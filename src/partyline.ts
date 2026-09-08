/**
 * The party line.
 *
 * A phone number, a six-digit code, and everybody who keyed the same code
 * talking to each other. You call 888-ROOM-818, key 482917, and you are on the
 * line with whoever else keyed 482917.
 *
 * Six digits, and digits rather than letters, for one reason: the code is a
 * thing you say to somebody. The generated ids this replaces were long enough
 * that nobody could read one down a phone line, and letters would have brought
 * case and spelling with them -- was that a capital B, was it "blue" or "blu".
 * A keypad has one way to type a 4 and nobody disagrees about how to say it.
 *
 * The rooms are not configured anywhere. Keying a code nobody is using opens
 * it, and the last person to hang up closes it -- the same shape as a channel,
 * where a name is just where a stream happens to be rather than a record
 * somebody created first. The code is a rendezvous, not a credential: two
 * people who agree on 482917 beforehand both dial in, and neither had to
 * create it first.
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
  /** The six-digit code, which is the room's whole identity. */
  code: string;
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

/**
 * What the party line needs to know about a stream.
 *
 * A narrow view of the Directory rather than the Directory itself, so this
 * module stays a function of its inputs and a test can describe a stream
 * without standing one up.
 */
export interface StreamLookup {
  liveByCode(code: string): { name: string; url: string; nowPlaying: string; startedAt: number } | undefined;
  endedByCode(code: string): { name: string; nowPlaying: string; startedAt: number; endedAt: number } | undefined;
}

/** Sending a text. Injected because the number that sends is not this one. */
export interface Sms {
  send(to: string, text: string): Promise<boolean>;
}

export interface PartyLineOptions {
  /** A Telnyx API key with call-control rights. */
  apiKey: string;
  /** The directory, on the instance that hosts one. */
  streams?: StreamLookup;
  /**
   * How to text somebody when a stream comes back.
   *
   * Not from the toll-free number the call arrived on: toll-free A2P messaging
   * is filtered by carriers until the number is verified, and ours is not. A
   * long code that already has a messaging profile sends today, so reminders
   * go out from there and the verification can land whenever it lands.
   */
  sms?: Sms;
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
  /** The number to tell people to call back on. Injected, not hardcoded. */
  callIn?: string;
  /** Injected for tests. */
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  onEvent?: (message: string) => void;
}

/**
 * How long a room code is.
 *
 * Six digits, because the code has to survive being read down a phone line and
 * typed into a URL. The generated ids this replaces were long enough that
 * nobody could say one out loud, which is the whole failure being fixed: a
 * room code is something you tell somebody, so it has to be short enough to
 * hold in your head between hearing it and dialling it.
 */
export const CODE_LENGTH = 6;

/**
 * A room code, from whatever the caller keyed.
 *
 * Digits only, and exactly six of them. Five is not a near miss to be
 * charitable about -- it is a different room, and guessing which one they
 * meant would drop somebody into a stranger's conversation.
 *
 * Nothing here is case-sensitive because nothing here has a case. That is the
 * point of digits over letters: a phone keypad has one way to type a 4, and no
 * two people disagree about how to say it.
 */
export function roomCodeFrom(entered: unknown): string {
  if (typeof entered !== "string" && typeof entered !== "number") return "";
  const digits = String(entered).replace(/\D/g, "");
  return digits.length === CODE_LENGTH ? digits : "";
}

/**
 * A time as a caller should hear it.
 *
 * Pacific, spelled out, because that is the clock the streams are announced on
 * and a bare "9:27" down a phone line is a time in somebody's head rather than
 * a time. Built with Intl rather than arithmetic: the offset changes twice a
 * year and hand-rolled zone maths is how you end up an hour out for three
 * weeks every spring.
 */
export function pacificTime(at: number): string {
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(new Date(at));
  return `${clock} Pacific`;
}

/** How a code is read back: one digit at a time, because 482917 is not a number. */
export function spokenCode(code: string): string {
  return code.split("").join(", ");
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
  /** The number each caller is calling from, for a reminder they ask for. */
  private readonly legFrom = new Map<string, string>();
  /** Legs that heard "press 1", and which stream they would be reminded about. */
  private readonly pendingReminder = new Map<string, string>();
  /** Who to text when a stream returns, by stream code. */
  private readonly reminders = new Map<string, Set<string>>();
  /**
   * Legs listening to a stream, by its code.
   *
   * Separate from the rooms because a stream listener is not in a conference:
   * they are a leg with an MP3 playing into it. Nothing else was counting
   * them, so the directory had no way to say how many people were on the
   * phone for a broadcast.
   */
  private readonly streamLegs = new Map<string, Set<string>>();
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

  /**
   * The rooms with someone in them, busiest first, with their codes.
   *
   * The code is published on purpose. An earlier version withheld it on the
   * reasoning that a code is the only thing between a stranger and a
   * conversation -- true of a private room, and wrong here: this is a public
   * call-in line, and a listing you cannot dial is a listing of nothing. The
   * code is how you join, so it is what the list is for.
   */
  list(): { code: string; callers: number; startedAt: number }[] {
    return [...this.rooms.values()]
      .filter((room) => room.callers > 0)
      .map(({ code, callers, startedAt }) => ({ code, callers, startedAt }))
      .sort((a, b) => b.callers - a.callers || a.startedAt - b.startedAt);
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
      // Kept now because a reminder needs it later, and by the time the caller
      // presses 1 the only thing we have is the leg.
      if (typeof payload["from"] === "string") this.legFrom.set(leg, payload["from"]);
      await this.command(leg, "answer", {});
      return;
    }

    if (type === "call.answered") {
      await this.ask(leg);
      return;
    }

    if (type === "call.gather.ended") {
      const digits = typeof payload["digits"] === "string" ? payload["digits"] : "";

      // A leg that was just offered a reminder is answering that, not keying a
      // room code -- the same event carries both, so the question we asked is
      // what decides how to read it.
      const offered = this.pendingReminder.get(leg);
      if (offered !== undefined) {
        this.pendingReminder.delete(leg);
        await this.reminder(leg, offered, digits);
        return;
      }

      const code = roomCodeFrom(digits);
      if (!code) {
        // Re-ask rather than guess. Anything that is not six digits is not a
        // room, and picking the nearest one would be picking a stranger's.
        await this.ask(leg, "That is not a six digit code. ");
        return;
      }
      // A code that belongs to a stream is answered as a stream. Anything else
      // is an ordinary room, which is what this line was before.
      if (await this.stream(leg, code)) return;
      await this.join(leg, code);
      return;
    }

    if (type === "conference.participant.left" || type === "call.hangup") {
      this.release(leg);
      this.legFrom.delete(leg);
      this.pendingReminder.delete(leg);
      return;
    }
  }

  /**
   * Ask for a room code, on the keypad.
   *
   * Not by voice, which is the one thing here that changed its mind. Speech
   * suited a room *name* -- "blue" misheard is still recognisably a word, and
   * a person can say it differently the second time. A six-digit code has no
   * such slack: one digit misheard is a different room that also exists, and
   * the caller lands in a stranger's conversation with nothing to tell them
   * they went wrong. A keypad cannot mishear a 4.
   *
   * Six digits terminates the gather on its own, so the caller does not have
   * to press anything after; # is there for the ones who do it anyway.
   */
  private async ask(leg: string, prefix = ""): Promise<void> {
    const greeting =
      this.options.greeting ??
      "Welcome to the party line. Enter a six digit room code. Anyone who enters the same code will be on the line with you.";

    await this.command(leg, "gather_using_speak", {
      payload: `${prefix}${greeting}`,
      voice: this.voice,
      valid_digits: "0123456789",
      minimum_digits: CODE_LENGTH,
      maximum_digits: CODE_LENGTH,
      terminating_digit: "#",
      timeout_millis: 20000,
    });
  }

  /**
   * Answer a code that belongs to a stream, rather than a room.
   *
   * Returns false when the code is nobody's stream, which is how an ordinary
   * room code still works: this line was a party line before it was a way into
   * a broadcast, and a code that means nothing to the directory should still
   * mean a room.
   */
  private async stream(leg: string, code: string): Promise<boolean> {
    const streams = this.options.streams;
    if (streams === undefined) return false;

    const live = streams.liveByCode(code);
    if (live !== undefined) {
      const what = live.nowPlaying ? ` of ${live.nowPlaying}` : "";
      await this.command(leg, "speak", {
        payload: `Welcome to ${live.name}'s live stream${what}. It started at ${pacificTime(live.startedAt)}. Here it is.`,
        voice: this.voice,
      });
      // A nixamp stream is an MP3 over HTTP and Telnyx will play a URL into a
      // call, so listening by phone costs no audio handling here at all.
      const playing = await this.command(leg, "playback_start", {
        audio_url: live.url,
        loop: "infinity",
      });
      // Counted only once the audio is actually going. A leg we failed to
      // start is not somebody listening, and the directory would be saying so.
      if (playing) {
        const legs = this.streamLegs.get(code) ?? new Set<string>();
        legs.add(leg);
        this.streamLegs.set(code, legs);
        this.options.onEvent?.(`  a caller is listening to ${code} (${legs.size} on the phone).`);
      }
      return true;
    }

    const ended = streams.endedByCode(code);
    if (ended === undefined) return false;

    const what = ended.nowPlaying ? ` of ${ended.nowPlaying}` : "";
    // Set before the prompt, not after: the answer can arrive while we are
    // still awaiting the command that asked for it.
    this.pendingReminder.set(leg, code);
    await this.command(leg, "gather_using_speak", {
      payload:
        `Welcome to ${ended.name}'s live stream${what}. ` +
        `The live stream ended at ${pacificTime(ended.endedAt)}. ` +
        "Call back later when they stream again. " +
        "Press 1 to get a text message when they do.",
      voice: this.voice,
      valid_digits: "1",
      minimum_digits: 1,
      maximum_digits: 1,
      timeout_millis: 12000,
    });
    return true;
  }

  /** Whether the caller took the reminder that was offered. */
  private async reminder(leg: string, code: string, digits: string): Promise<void> {
    const from = this.legFrom.get(leg) ?? "";
    if (!digits.includes("1") || !from) {
      // Not pressing 1 is an answer. So is a call with no caller id, which we
      // cannot text however willing the caller was.
      await this.command(leg, "speak", { payload: "Goodbye.", voice: this.voice });
      await this.command(leg, "hangup", {});
      return;
    }

    const waiting = this.reminders.get(code) ?? new Set<string>();
    waiting.add(from);
    this.reminders.set(code, waiting);
    this.options.onEvent?.(`  a caller asked to be told when ${code} is live again.`);

    await this.command(leg, "speak", {
      payload: "Got it. We will text you when they are live again. Goodbye.",
      voice: this.voice,
    });
    await this.command(leg, "hangup", {});
  }

  /**
   * A stream came back: text whoever asked to be told.
   *
   * The list is cleared as it is sent. A reminder is a thing somebody asked
   * for once, and texting them every time that stream starts for the rest of
   * the week is how a useful message becomes the reason they block the number.
   */
  async wentLive(stream: { code: string; name: string; nowPlaying: string }): Promise<number> {
    const waiting = this.reminders.get(stream.code);
    const sms = this.options.sms;
    if (waiting === undefined || waiting.size === 0 || sms === undefined) return 0;
    this.reminders.delete(stream.code);

    const what = stream.nowPlaying ? ` of ${stream.nowPlaying}` : "";
    // STOP is not decoration: an automated text to a US number has to say how
    // to make it stop, and the carriers check.
    const text =
      `${stream.name} is live now${what} on nixamp. ` +
      `Call ${this.options.callIn ?? "408-357-2326"} and key ${stream.code} to listen. ` +
      "Reply STOP to opt out.";

    let sent = 0;
    for (const to of waiting) if (await sms.send(to, text)) sent += 1;
    this.options.onEvent?.(`  texted ${sent} of ${waiting.size} waiting on ${stream.code}.`);
    return sent;
  }

  /** How many numbers are waiting to hear that a code is live. */
  waitingOn(code: string): number {
    return this.reminders.get(code)?.size ?? 0;
  }

  /** Put a leg into a room, making the conference if it is the first one there. */
  private async join(leg: string, code: string): Promise<void> {
    const room = this.room(code);

    if (room.callers >= this.maxParticipants) {
      await this.command(leg, "speak", {
        payload: "That room is full. Goodbye.",
        voice: this.voice,
      });
      await this.command(leg, "hangup", {});
      return;
    }

    this.legRoom.set(leg, code);

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
      name: `partyline-${this.now()}-${room.legs.size}`,
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
    this.options.onEvent?.(`  a caller joined a room (${room.callers} on the line).`);
  }

  /** How many people are listening to a stream by phone. */
  listenersOn(code: string): number {
    return this.streamLegs.get(code)?.size ?? 0;
  }

  /** A leg that hung up or was dropped, wherever it was. */
  private release(leg: string): void {
    for (const [code, legs] of this.streamLegs) {
      if (legs.delete(leg) && legs.size === 0) this.streamLegs.delete(code);
    }
    const code = this.legRoom.get(leg);
    this.legRoom.delete(leg);
    if (code === undefined) return;
    const room = this.rooms.get(code);
    if (room === undefined) return;
    room.legs.delete(leg);
    room.callers = room.legs.size;
    if (room.callers === 0) {
      // Telnyx ends an empty conference itself; keeping the code would only
      // mean handing the next caller a dead id.
      this.rooms.delete(code);
      this.options.onEvent?.("  a room is empty.");
    }
  }

  /**
   * The room on this code, made if nobody is using it.
   *
   * Entering a code nobody is in opens that room rather than failing. The code
   * is a rendezvous, not a credential: two people who agree on 482917
   * beforehand should both be able to dial in, and neither of them should have
   * had to create it first.
   */
  private room(code: string): Room {
    const existing = this.rooms.get(code);
    if (existing !== undefined) return existing;
    const room: Room = {
      code,
      conferenceId: null,
      callers: 0,
      startedAt: this.now(),
      legs: new Set<string>(),
    };
    this.rooms.set(code, room);
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

/**
 * Texting, over Telnyx.
 *
 * A separate `from` because it is a different number: the call arrives on the
 * toll-free line, but toll-free A2P messaging is filtered by carriers until
 * that number is verified and ours is not yet. The long code already carries a
 * messaging profile, so it can send today -- and when verification lands, this
 * becomes a one-line change rather than a redesign.
 */
export function telnyxSms(
  { apiKey, from, fetch = globalThis.fetch, onEvent }: {
    apiKey: string;
    from: string;
    fetch?: typeof globalThis.fetch;
    onEvent?: (message: string) => void;
  },
): Sms {
  return {
    async send(to: string, text: string): Promise<boolean> {
      try {
        const response = await fetch(`${TELNYX_API}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to, text }),
        });
        if (!response.ok) {
          onEvent?.(`  sms to ${to} -> ${response.status}`);
          return false;
        }
        return true;
      } catch (error) {
        onEvent?.(`  sms to ${to} failed: ${(error as Error).message}`);
        return false;
      }
    },
  };
}

/** Constant-time compare, for the places a token is checked rather than signed. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
