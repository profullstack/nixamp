/**
 * The party line.
 *
 * A phone number, a six-digit code, and everybody who keyed the same code
 * talking to each other. You call 408-357-2326, key 482917, and you are on the
 * line with whoever else keyed 482917.
 *
 * The phone half -- answering, asking for the code on the keypad, the voices,
 * Telnyx conferences and their four-hour expiry, who is in which room -- is
 * @profullstack/group-call, which started life as this file and is shared with
 * group.call.pit.world. What stays here is what a code means to nixamp: a code
 * that belongs to a live stream is that stream's room, a code whose stream has
 * ended offers a text for when it is back, and anything else is an ordinary
 * room nobody had to create first.
 */
import {
  GroupCall,
  peopleHere,
  roomCodeFrom as groupRoomCodeFrom,
  sameSecret,
  spokenCode,
  telnyxSms,
  type CallHandle,
  type CodeAnswer,
  type RoomInfo,
  type Sms,
  type TelnyxEvent,
} from "@profullstack/group-call";

export { peopleHere, sameSecret, spokenCode, telnyxSms };
export type { RoomInfo, Sms, TelnyxEvent };

/**
 * Telnyx's own voice, so a room prompt costs nothing beyond the call. A
 * Polly or ElevenLabs voice reads better and bills separately; the name is
 * configuration rather than a constant for exactly that reason.
 */
const DEFAULT_VOICE = "Telnyx.KokoroTTS.af";

/**
 * How long a room code is.
 *
 * Six digits, because the code has to survive being read down a phone line and
 * typed into a URL. A room code is something you tell somebody, so it has to
 * be short enough to hold in your head between hearing it and dialling it.
 */
export const CODE_LENGTH = 6;

/** A six-digit room code from whatever the caller keyed, or "". */
export function roomCodeFrom(entered: unknown): string {
  return groupRoomCodeFrom(entered, CODE_LENGTH);
}

/**
 * What the party line needs to know about a stream.
 *
 * A narrow view of the Directory rather than the Directory itself, so this
 * module stays a function of its inputs and a test can describe a stream
 * without standing one up.
 */
export interface StreamLookup {
  liveByCode(
    code: string,
  ): { name: string; url: string; audio: string; nowPlaying: string; startedAt: number } | undefined;
  endedByCode(code: string): { name: string; nowPlaying: string; startedAt: number; endedAt: number } | undefined;
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
   * long code that already has a messaging profile sends today.
   */
  sms?: Sms;
  /** The account's ed25519 public key, base64, from the portal. */
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

/**
 * A track's name as it should be read out.
 *
 * What is playing is a filename more often than a title: "02 - ...And Justice
 * For All.mp3" read aloud is "zero two dash dot dot dot", and the extension is
 * a noise the caller does not need.
 */
export function spokenTitle(nowPlaying: string): string {
  return nowPlaying
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/^\s*\d{1,3}\s*[-._]\s*/, "")
    .replace(/^[\s.]+/, "")
    .trim();
}

/**
 * The party line, as a thing that answers webhooks: a group call whose codes
 * can also be streams.
 */
export class PartyLine extends GroupCall {
  /** Who to text when a stream returns, by stream code. */
  private readonly reminders = new Map<string, Set<string>>();
  /**
   * The same list, somewhere that survives a deploy.
   *
   * A caller who pressed 1 was told they would be texted. Keeping that promise
   * only in a Map meant a restart broke it silently, which is the worst way to
   * break a promise made to somebody on a telephone.
   */
  private reminderStore: {
    add: (code: string, phone: string) => void;
    take: (code: string) => Promise<string[]>;
  } | null = null;
  private readonly party: PartyLineOptions;

  constructor(options: PartyLineOptions) {
    let self: PartyLine | undefined;
    super({
      apiKey: options.apiKey,
      publicKey: options.publicKey,
      codeLength: CODE_LENGTH,
      conferencePrefix: "partyline",
      greeting: options.greeting ?? "Welcome to the nixamp party line. Enter the six digit room code.",
      voice: options.voice ?? DEFAULT_VOICE,
      ...(options.maxParticipants !== undefined ? { maxParticipants: options.maxParticipants } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      // A code that belongs to a stream is answered as a stream. Anything else
      // is an ordinary room, which is what this line was before.
      onCode: (code, call) => self!.stream(code, call),
    });
    self = this;
    this.party = options;
  }

  /** Start echoing reminders somewhere durable, and put back what was there. */
  persistRemindersTo(
    store: { add: (code: string, phone: string) => void; take: (code: string) => Promise<string[]> },
    waiting: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  ): void {
    this.reminderStore = store;
    for (const [code, phones] of waiting) {
      const set = this.reminders.get(code) ?? new Set<string>();
      for (const phone of phones) set.add(phone);
      this.reminders.set(code, set);
    }
  }

  /**
   * Answer a code that belongs to a stream, rather than a room.
   *
   * Keying a stream's code puts you in a room with the other people watching
   * it. It does not play the stream at you: this is the phone line beside a
   * broadcast, the way a podcast has an 800 number -- the show is on your
   * screen and the phone is where you talk about it.
   */
  private async stream(code: string, call: CallHandle): Promise<CodeAnswer> {
    const streams = this.party.streams;
    if (streams === undefined) return true;

    const live = streams.liveByCode(code);
    if (live !== undefined) {
      // The welcome is said once they are in the room, not before: a speak
      // on the leg followed by the conference join was cut off by the join.
      const title = spokenTitle(live.nowPlaying);
      const what = title ? `, playing ${title}` : "";
      return { welcome: `Welcome to the live room for ${live.name}${what}. ` };
    }

    const ended = streams.endedByCode(code);
    if (ended === undefined) return true;

    const what = ended.nowPlaying ? ` of ${ended.nowPlaying}` : "";
    await call.gather(
      `Welcome to ${ended.name}'s live stream${what}. ` +
        `The live stream ended at ${pacificTime(ended.endedAt)}. ` +
        "Call back later when they stream again. " +
        "Press 1 to get a text message when they do.",
      { validDigits: "1", minimumDigits: 1, maximumDigits: 1, timeoutMillis: 12000 },
      (digits) => this.reminder(call, code, digits),
    );
    return "handled";
  }

  /** Whether the caller took the reminder that was offered. */
  private async reminder(call: CallHandle, code: string, digits: string): Promise<void> {
    const from = call.from;
    if (!digits.includes("1") || !from) {
      // Not pressing 1 is an answer. So is a call with no caller id, which we
      // cannot text however willing the caller was.
      await call.goodbye("Goodbye.");
      return;
    }

    const waiting = this.reminders.get(code) ?? new Set<string>();
    waiting.add(from);
    this.reminders.set(code, waiting);
    this.reminderStore?.add(code, from);
    this.party.onEvent?.(`  a caller asked to be told when ${code} is live again.`);

    await call.goodbye("Got it. We will text you when they are live again. Goodbye.");
  }

  /**
   * A stream came back: text whoever asked to be told.
   *
   * The list is cleared as it is sent. A reminder is a thing somebody asked
   * for once, and texting them every time that stream starts for the rest of
   * the week is how a useful message becomes the reason they block the number.
   */
  async wentLive(stream: { code: string; name: string; nowPlaying: string }): Promise<number> {
    const sms = this.party.sms;
    // Taken from the store first, and that take is what clears it: a number
    // put there by a process that has since been replaced is still owed a
    // text, and this one never heard the call that promised it.
    const stored = this.reminderStore ? await this.reminderStore.take(stream.code) : [];
    const waiting = new Set([...(this.reminders.get(stream.code) ?? []), ...stored]);
    if (waiting.size === 0 || sms === undefined) return 0;
    this.reminders.delete(stream.code);

    const what = stream.nowPlaying ? ` of ${stream.nowPlaying}` : "";
    // STOP is not decoration: an automated text to a US number has to say how
    // to make it stop, and the carriers check.
    const text =
      `${stream.name} is live now${what} on nixamp. ` +
      `Call ${this.party.callIn ?? "408-357-2326"} and key ${stream.code} to listen. ` +
      "Reply STOP to opt out.";

    let sent = 0;
    for (const to of waiting) if (await sms.send(to, text)) sent += 1;
    this.party.onEvent?.(`  texted ${sent} of ${waiting.size} waiting on ${stream.code}.`);
    return sent;
  }

  /** How many numbers are waiting to hear that a code is live. */
  waitingOn(code: string): number {
    return this.reminders.get(code)?.size ?? 0;
  }

  /**
   * A line said into a room, to everybody on the phone in it. What the
   * trollbox becomes on the party line: the handle and the words, in the
   * voice of whoever typed them.
   */
  override async say(code: string, text: string, voice: string, settings?: { api_key_ref: string }): Promise<boolean> {
    return super.say(code, text, voice, settings);
  }

  /** How many people are on the phone for a stream: the room's own count. */
  listenersOn(code: string): number {
    return this.callersIn(code);
  }
}
