/**
 * The party line.
 *
 * A phone number, a spoken room name, and everybody who said the same name
 * talking to each other. You call 888-ROOM-818, it asks which room you want,
 * you say "blue", and you are in the blue room with whoever else said blue.
 *
 * The rooms are not configured anywhere. Saying a name that nobody is using
 * makes it, and the last person to hang up unmakes it -- the same shape as a
 * channel, where a name is just where a stream happens to be rather than a
 * record somebody created first.
 *
 * The audio mixing is Telnyx's. A conference is a name on their side too, so
 * this module never touches a byte of audio: it answers a call, asks a
 * question, and puts the leg into a conference. What we keep is the part
 * Telnyx does not -- which spoken words mean which conference, and how many
 * people a room is holding.
 *
 * Two things about conferences are worth knowing before reading the state
 * machine. They expire after four hours whether or not anyone is still on
 * them, so a long-lived room's conference id goes stale underneath us and has
 * to be remade on the next join. And the id is only knowable after the first
 * caller creates it, so the first caller and the tenth take different paths
 * through the same function.
 */
import { createPublicKey, verify as verifySignature, timingSafeEqual } from "node:crypto";

/** Where Telnyx's REST API lives. Injectable so a test never leaves the process. */
const TELNYX_API = "https://api.telnyx.com/v2";

/**
 * Telnyx's own voice, so a room prompt costs nothing beyond the call. A
 * Polly or ElevenLabs voice reads better and bills separately; the name is
 * configuration rather than a constant for exactly that reason.
 */
const DEFAULT_VOICE = "Telnyx.KokoroTTS.af";

/** How long a signed webhook stays acceptable. Telnyx's own SDKs use five minutes. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** A conference Telnyx will discard on its own, so we stop trusting ours first. */
const CONFERENCE_TTL_MS = 4 * 60 * 60 * 1000;

export interface RoomInfo {
  /** The spoken name, normalised -- "the Blue Room" and "blue" are one room. */
  name: string;
  /** Telnyx's id for the conference, once a first caller has made one. */
  conferenceId: string | null;
  /** How many legs we have put in, less the ones we have seen leave. */
  callers: number;
  startedAt: number;
}

interface Room extends RoomInfo {
  /** Legs currently in the room, so a caller is never counted twice. */
  legs: Set<string>;
}

export interface PartyLineOptions {
  /** A Telnyx API key with call-control rights. */
  apiKey: string;
  /**
   * The account's ed25519 public key, base64, from the portal. Without it
   * every webhook is refused: an unauthenticated call-control webhook lets a
   * stranger drive calls we are paying for.
   */
  publicKey: string;
  /** What the caller hears before being asked for a room. */
  greeting?: string;
  voice?: string;
  /** A ceiling per room, so one room cannot spend the whole balance. */
  maxParticipants?: number;
  /** Injected for tests. */
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  onEvent?: (message: string) => void;
}

/** Words a caller says around the name rather than as part of it. */
const FILLER = new Set([
  "the", "a", "an", "room", "rooms", "please", "uh", "um", "er",
  "join", "me", "to", "in", "into", "put", "i", "want", "wanna", "would",
  "like", "lets", "let", "go", "take",
]);

/**
 * What a caller said, as a room name.
 *
 * Speech recognition returns a sentence, not a token: "uh, the blue room
 * please" and "blue" have to land in the same place or two people trying to
 * meet will not. Stripping filler and punctuation gets most of the way, and
 * what survives is joined with dashes so it can sit in a URL next to a
 * channel id.
 */
export function roomNameFrom(spoken: unknown, fallback = ""): string {
  if (typeof spoken !== "string") return fallback;
  const words = spoken
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 0 && !FILLER.has(word));
  const name = words.join("-").slice(0, 40).replace(/^-+|-+$/g, "");
  return name || fallback;
}

/**
 * Telnyx signs `${timestamp}|${body}` with ed25519 and sends both back in
 * headers. Node will not take a bare 32-byte key, so it is wrapped in the
 * fixed SPKI prefix that says "this is ed25519" and handed over as DER.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519KeyFrom(base64Key: string): ReturnType<typeof createPublicKey> | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(base64Key, "base64");
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

export interface TelnyxEvent {
  event_type?: string;
  payload?: Record<string, unknown>;
}

/**
 * The party line, as a thing that answers webhooks.
 *
 * It owns no socket and no timer. The server hands it a verified event and it
 * issues whatever call-control commands that event calls for, which makes the
 * whole state machine testable with a fetch that records what it was asked.
 */
export class PartyLine {
  private readonly rooms = new Map<string, Room>();
  /** Which room a leg is heading for, between asking and being answered. */
  private readonly legRoom = new Map<string, string>();
  private readonly key: ReturnType<typeof createPublicKey> | null;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly options: PartyLineOptions) {
    this.key = options.publicKey ? ed25519KeyFrom(options.publicKey) : null;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /** True when this instance can actually check a signature. */
  get armed(): boolean {
    return this.key !== null && this.options.apiKey.length > 0;
  }

  /**
   * Whether a webhook really came from Telnyx.
   *
   * The body has to be the bytes that arrived. Parsing and reserialising JSON
   * changes key order and whitespace, and the signature is over the original.
   */
  verify(rawBody: string, signature: string | undefined, timestamp: string | undefined): boolean {
    if (this.key === null || !signature || !timestamp) return false;

    const sent = Number(timestamp) * 1000;
    if (!Number.isFinite(sent)) return false;
    // Both directions: a replayed webhook is old, and a clock-skewed forgery
    // from the future is no more trustworthy for being ahead.
    if (Math.abs(this.now() - sent) > SIGNATURE_TOLERANCE_MS) return false;

    let sig: Buffer;
    try {
      sig = Buffer.from(signature, "base64");
    } catch {
      return false;
    }
    if (sig.length !== 64) return false;

    try {
      return verifySignature(
        null,
        Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
        this.key,
        sig,
      );
    } catch {
      return false;
    }
  }

  /** The rooms with someone in them, busiest first. */
  list(): RoomInfo[] {
    return [...this.rooms.values()]
      .filter((room) => room.callers > 0)
      .map(({ name, conferenceId, callers, startedAt }) => ({ name, conferenceId, callers, startedAt }))
      .sort((a, b) => b.callers - a.callers || a.name.localeCompare(b.name));
  }

  /**
   * Drive one call-control event.
   *
   * Every branch returns rather than falling through, because an event we do
   * not handle is the normal case -- Telnyx sends a dozen kinds per call and
   * this cares about four.
   */
  async handle(event: TelnyxEvent): Promise<void> {
    const type = event.event_type ?? "";
    const payload = event.payload ?? {};
    const leg = typeof payload["call_control_id"] === "string" ? payload["call_control_id"] : "";
    if (!leg) return;

    if (type === "call.initiated") {
      // Only inbound. An outbound leg we dialled is not somebody calling in,
      // and answering it would be answering ourselves.
      if (payload["direction"] !== "incoming") return;
      await this.command(leg, "answer", {});
      return;
    }

    if (type === "call.answered") {
      await this.ask(leg);
      return;
    }

    // Speech and keypad arrive as different events with different payloads and
    // both mean "the caller told us a room".
    if (type === "call.ai_gather.ended" || type === "call.gather.ended") {
      const said = this.spokenRoom(payload);
      if (!said) {
        await this.command(leg, "speak", {
          payload: "Sorry, I did not catch that.",
          voice: this.voice,
        });
        await this.ask(leg);
        return;
      }
      await this.join(leg, said);
      return;
    }

    if (type === "conference.participant.left" || type === "call.hangup") {
      this.release(leg);
      return;
    }
  }

  /** Ask which room, by voice, with the keypad as a fallback. */
  private async ask(leg: string): Promise<void> {
    const greeting =
      this.options.greeting ??
      "Welcome to the party line. What room would you like to join? Say a room name, or make one up.";

    // gather_using_ai is the only Telnyx command that listens to speech --
    // gather_using_speak reads text out but collects keypad digits only. The
    // schema is what ends the gather: one required value, so it returns as
    // soon as the caller has named a room rather than waiting for silence.
    const ok = await this.command(leg, "gather_using_ai", {
      greeting,
      voice: this.voice,
      parameters: {
        type: "object",
        properties: {
          room: {
            type: "string",
            description:
              "The name of the room the caller wants to join. A single word or short phrase, as they said it.",
          },
        },
        required: ["room"],
      },
    });

    // AI gather is a paid add-on and an account without it gets a 4xx rather
    // than silence. Falling back to the keypad keeps the number answering.
    if (!ok) {
      await this.command(leg, "gather_using_speak", {
        payload: `${greeting} Enter a room number, then press pound.`,
        voice: this.voice,
        minimum_digits: 1,
        maximum_digits: 8,
        terminating_digit: "#",
      });
    }
  }

  /** The room a caller named, from whichever kind of gather answered. */
  private spokenRoom(payload: Record<string, unknown>): string {
    const result = payload["result"];
    if (result && typeof result === "object") {
      const said = (result as Record<string, unknown>)["room"];
      const name = roomNameFrom(said);
      if (name) return name;
    }
    // The keypad path: digits are already a name, and a spoken "eight one
    // eight" and a dialled 818 should not be two different rooms.
    return roomNameFrom(payload["digits"]);
  }

  /** Put a leg into a room, making the conference if it is the first one there. */
  private async join(leg: string, name: string): Promise<void> {
    const room = this.room(name);

    if (room.callers >= this.maxParticipants) {
      await this.command(leg, "speak", {
        payload: `The ${name} room is full. Goodbye.`,
        voice: this.voice,
      });
      await this.command(leg, "hangup", {});
      return;
    }

    this.legRoom.set(leg, name);

    // A conference we made more than four hours ago is gone on Telnyx's side
    // whatever our map says, so it is remade rather than joined.
    const stale = this.now() - room.startedAt > CONFERENCE_TTL_MS;
    if (room.conferenceId !== null && !stale) {
      const joined = await this.request(
        `/conferences/${encodeURIComponent(room.conferenceId)}/actions/join`,
        { call_control_id: leg, start_conference_on_enter: true },
      );
      if (joined !== null) {
        this.enter(room, leg);
        return;
      }
      // The id was stale in a way the clock did not predict -- an operator
      // ended it, or Telnyx did. Fall through and make a new one.
      room.conferenceId = null;
    }

    const created = await this.request("/conferences", {
      name: `partyline-${name}-${this.now()}`,
      call_control_id: leg,
      start_conference_on_create: true,
      max_participants: this.maxParticipants,
    });

    const id = created && typeof created === "object"
      ? ((created as Record<string, unknown>)["data"] as Record<string, unknown> | undefined)?.["id"]
      : undefined;

    if (typeof id !== "string") {
      await this.command(leg, "speak", {
        payload: "Sorry, that room could not be opened. Goodbye.",
        voice: this.voice,
      });
      await this.command(leg, "hangup", {});
      this.legRoom.delete(leg);
      return;
    }

    room.conferenceId = id;
    room.startedAt = this.now();
    this.enter(room, leg);
  }

  private enter(room: Room, leg: string): void {
    if (room.legs.has(leg)) return;
    room.legs.add(leg);
    room.callers = room.legs.size;
    this.options.onEvent?.(`  a caller joined "${room.name}" (${room.callers} on the line).`);
  }

  /** A leg that hung up or was dropped, wherever it was. */
  private release(leg: string): void {
    const name = this.legRoom.get(leg);
    this.legRoom.delete(leg);
    if (name === undefined) return;
    const room = this.rooms.get(name);
    if (room === undefined) return;
    room.legs.delete(leg);
    room.callers = room.legs.size;
    if (room.callers === 0) {
      // Telnyx ends an empty conference itself; keeping the name would only
      // mean handing the next caller a dead id.
      this.rooms.delete(name);
      this.options.onEvent?.(`  "${name}" is empty.`);
    }
  }

  private room(name: string): Room {
    const existing = this.rooms.get(name);
    if (existing !== undefined) return existing;
    const room: Room = {
      name,
      conferenceId: null,
      callers: 0,
      startedAt: this.now(),
      legs: new Set<string>(),
    };
    this.rooms.set(name, room);
    return room;
  }

  private get voice(): string {
    return this.options.voice ?? DEFAULT_VOICE;
  }

  private get maxParticipants(): number {
    return this.options.maxParticipants ?? 50;
  }

  /** One call-control command. True when Telnyx accepted it. */
  private async command(leg: string, action: string, body: unknown): Promise<boolean> {
    const path = `/calls/${encodeURIComponent(leg)}/actions/${action}`;
    return (await this.request(path, body)) !== null;
  }

  /** A POST to Telnyx, or null if it did not work. */
  private async request(path: string, body: unknown): Promise<unknown | null> {
    try {
      const response = await this.fetch(`${TELNYX_API}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // A command against a leg that already hung up is a 422 and is not
        // worth a stack trace; it is the ordinary end of a race.
        this.options.onEvent?.(`  telnyx ${path} -> ${response.status}`);
        return null;
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : {};
    } catch (error) {
      this.options.onEvent?.(`  telnyx ${path} failed: ${(error as Error).message}`);
      return null;
    }
  }
}

/** Constant-time compare, for the places a token is checked rather than signed. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
