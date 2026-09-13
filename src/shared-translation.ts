/** One live source/language pipeline, paid access for every listening account.
 * Browsers receive the same PCM, never upload a replacement for a public feed. */
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { Interpreter, type Caption } from "./live-interpreter.ts";
import { LiveVoice, LIVE_VOICE_LANGUAGES } from "./live-voice.ts";
import { SpeechError } from "./speech.ts";
import type { Translator } from "./translate.ts";
import type { TranslationMeter, TranslationUsage } from "./translation-passes.ts";

const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(ip, bits, "ipv4");
const v6global = new BlockList(); v6global.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6"); blocked.addSubnet("2002::", 16, "ipv6"); blocked.addSubnet("2001::", 32, "ipv6");
export function publicStreamAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && v6global.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
export function sharedSource(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SpeechError("Choose a live Nixamp channel.", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !/^\/api\/channels\/[\w-]{1,80}$/.test(url.pathname) || [...url.searchParams.keys()].some(key => key !== "k")) throw new SpeechError("Choose a live Nixamp channel.", 400);
  if (url.toString().length > 2048) throw new SpeechError("Invalid live source.", 400);
  url.searchParams.sort(); return url;
}
export interface LiveInput { stop(): void; }
export type OpenLiveInput = (source: URL, pcm: (bytes: Buffer) => void, ended: () => void, signal: AbortSignal) => Promise<LiveInput>;

/** Resolve once and pin that public address; no redirects or ffmpeg URL fetches. */
export function liveInput(ffmpeg: string[] = ["ffmpeg"]): OpenLiveInput {
  return async (source, pcm, ended, signal) => {
    const hostname = source.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(one => !publicStreamAddress(one.address))) throw new SpeechError("This live source is not publicly reachable.", 400);
    signal.throwIfAborted();
    const selected = addresses[0]!;
    const child = spawn(ffmpeg[0]!, [...ffmpeg.slice(1), "-v", "error", "-nostats", "-protocol_whitelist", "pipe", "-readrate", "1", "-analyzeduration", "500000", "-probesize", "262144", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    let stopped = false;
    const request = (source.protocol === "https:" ? https : http).get(source, {
      signal, headers: { "user-agent": "Nixamp shared translated audio", accept: "audio/*,video/*,application/octet-stream" },
      lookup: (_name, options, callback) => { if (typeof options === "object" && options.all) callback(null, [selected]); else callback(null, selected.address, selected.family); },
    });
    const stop = (): void => { if (stopped) return; stopped = true; request.destroy(); child.stdin.destroy(); child.kill("SIGKILL"); signal.removeEventListener("abort", stop); };
    const end = (): void => { if (!stopped) { stop(); ended(); } };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", pcm); child.on("error", end); child.on("close", end); child.stdin.on("error", end);
    request.on("response", response => {
      if (response.statusCode !== 200) { response.destroy(); end(); return; }
      response.on("error", end); response.on("end", end); response.pipe(child.stdin);
    });
    request.on("error", end);
    request.setTimeout(15_000, end);
    return { stop };
  };
}

export type SharedEvent = { type: "status"; listeners: number } | { type: "line"; id: string; line: Caption } | { type: "audio"; id: string; data: string } | { type: "end"; id: string } | { type: "error"; error: string };
type Member = { by: string; send: (event: SharedEvent) => void; close: () => void };
interface Feed { id: string; source: URL; language: string; members: Set<Member>; controller: AbortController; input?: LiveInput; interpreter: Interpreter; meter: TranslationMeter; reservations: Map<string, string[]>; queue: Caption[]; speaking: boolean; previous: Buffer; pending: Buffer; until: number; heartbeat?: ReturnType<typeof setInterval>; }

export class SharedTranslations {
  private readonly feeds = new Map<string, Feed>();
  constructor(private readonly options: { voice: LiveVoice; translator: Pick<Translator, "translate">; billing?: TranslationMeter; open?: OpenLiveInput }) {}
  get size(): number { return this.feeds.size; }

  async join(raw: string, language: string, by: string, send: Member["send"], close: () => void): Promise<() => void> {
    if (!this.options.voice.available()) throw new SpeechError("Translated audio is unavailable.", 503);
    const source = sharedSource(raw);
    if (!LIVE_VOICE_LANGUAGES.has(language)) throw new SpeechError("Choose a supported audio language.", 400);
    const id = `dub-${createHash("sha256").update(`${source}|${language}`).digest("hex").slice(0, 40)}`;
    const capacity = (): void => {
      const connections = [...this.feeds.values()].reduce((total, feed) => total + [...feed.members].filter(member => member.by === by).length, 0);
      if (connections >= 2) throw new SpeechError("Translated audio is already open in two players for this account.", 429);
      const feed = this.feeds.get(id);
      if (!feed && this.feeds.size >= 4) throw new SpeechError("Live translation is busy. Try again shortly.", 429);
      if (feed && feed.members.size >= 1000) throw new SpeechError("This translated stream is full. Try again shortly.", 429);
    };
    capacity();
    if (this.options.billing?.begin) await this.options.billing.begin(by, id);
    else await this.options.billing?.require(by, id);
    capacity(); // Other joins can finish during the account/database check.
    let feed = this.feeds.get(id);
    if (!feed) {
      feed = this.make(id, source, language); this.feeds.set(id, feed);
      const current = feed;
      current.heartbeat = setInterval(() => void this.checkMembers(current), 10_000); current.heartbeat.unref?.();
    }
    const member = { by, send, close }; feed.members.add(member);
    this.broadcast(feed, { type: "status", listeners: feed.members.size });
    if (feed.members.size === 1 && !feed.input) void this.start(feed);
    const current = feed;
    return () => this.leave(current, member);
  }
  private leave(feed: Feed, member: Member): void {
    if (!feed.members.delete(member)) return;
    if (!feed.members.size) {
      if (feed.heartbeat) clearInterval(feed.heartbeat);
      feed.controller.abort(); feed.input?.stop(); feed.interpreter.reset(); feed.queue = [];
      this.feeds.delete(feed.id);
    } else this.broadcast(feed, { type: "status", listeners: feed.members.size });
  }
  private async checkMembers(feed: Feed): Promise<void> {
    const accounts = [...new Set([...feed.members].map(member => member.by))];
    let funded = new Set(accounts), message = "This free session ended and audio credit is used up. Start a remaining free session or buy a pass.";
    try {
      if (this.options.billing?.eligible) funded = new Set(await this.options.billing.eligible(accounts, feed.id));
      else if (this.options.billing) {
        const results = await Promise.allSettled(accounts.map(by => this.options.billing!.require(by, feed.id)));
        funded = new Set(accounts.filter((_by, index) => results[index]?.status === "fulfilled"));
      }
    } catch { funded.clear(); message = "Your translation access could not be checked. Try again shortly."; }
    for (const member of [...feed.members]) if (accounts.includes(member.by) && !funded.has(member.by)) {
      try { member.send({ type: "error", error: message }); } catch { /* disconnected */ }
      finally { this.leave(feed, member); member.close(); }
    }
  }
  private broadcast(feed: Feed, event: SharedEvent): void {
    for (const member of [...feed.members]) {
      try { member.send(event); } catch { this.leave(feed, member); member.close(); }
    }
  }
  private stop(feed: Feed, error: string): void {
    this.broadcast(feed, { type: "error", error });
    for (const member of [...feed.members]) { this.leave(feed, member); member.close(); }
  }
  private make(id: string, source: URL, language: string): Feed {
    const feed = { id, source, language, members: new Set<Member>(), controller: new AbortController(), reservations: new Map<string, string[]>(), queue: [], speaking: false, previous: Buffer.alloc(0), pending: Buffer.alloc(0), until: Date.now() } as unknown as Feed;
    // Each account uses free access first, then the same published credit rate.
    // Additional listeners do not trigger recognition or synthesis.
    feed.meter = {
      require: async () => { if (!feed.members.size) throw new SpeechError("No listeners.", 410); },
      reserve: async (_by: string, kind: TranslationUsage, units: number) => {
        const ids: string[] = [];
        const accounts = [...new Set([...feed.members].map(member => member.by))];
        const accepted = new Set<string>();
        const billing = this.options.billing;
        if (billing?.reserveMany) {
          for (const charged of await billing.reserveMany(accounts, kind, units, feed.id)) { ids.push(charged.id); accepted.add(charged.by); }
        } else {
          const results = await Promise.allSettled(accounts.map(async account => ({ by: account, id: await billing?.reserve(account, kind, units, feed.id) })));
          let failure: unknown;
          for (const result of results) {
            if (result.status === "fulfilled") { accepted.add(result.value.by); if (result.value.id) ids.push(result.value.id); }
            else if (!(result.reason instanceof SpeechError) || result.reason.status !== 402) failure = result.reason;
          }
          if (failure) { await Promise.all(ids.map(id => billing!.refund(id))); throw failure; }
        }
        for (const member of [...feed.members]) if (accounts.includes(member.by) && !accepted.has(member.by)) {
          try { member.send({ type: "error", error: "This free session ended and audio credit is used up. Start a remaining free session or buy a pass." }); }
          catch { /* disconnected */ } finally { this.leave(feed, member); member.close(); }
        }
        if (!feed.members.size) { await Promise.all(ids.map(id => this.options.billing!.refund(id))); throw new SpeechError("No funded listeners.", 402); }
        const reservation = randomUUID(); feed.reservations.set(reservation, ids); return reservation;
      },
      commit: async id => { const ids = feed.reservations.get(id) ?? []; if (this.options.billing?.commitMany) await this.options.billing.commitMany(ids); else await Promise.all(ids.map(id => this.options.billing!.commit(id))); feed.reservations.delete(id); },
      refund: async id => { const ids = feed.reservations.get(id) ?? []; if (this.options.billing?.refundMany) await this.options.billing.refundMany(ids); else await Promise.all(ids.map(id => this.options.billing!.refund(id))); feed.reservations.delete(id); },
    };
    let voices: Awaited<ReturnType<LiveVoice["voices"]>> = [];
    feed.interpreter = new Interpreter({
      language: () => language, speakers: () => true, voices: () => voices, channel: () => id,
      status: text => { if (!feed.controller.signal.aborted && !feed.members.size) this.stop(feed, text); },
      failed: () => this.stop(feed, "Live translation stopped. Enable it again to retry."),
      lines: lines => {
        feed.queue.push(...lines);
        if (feed.queue.length > 24) { this.stop(feed, "Live translation fell behind. Enable it again to retry."); return; }
        if (!feed.speaking) void this.speak(feed);
      },
      fetcher: (async (url, init) => {
        feed.controller.signal.throwIfAborted();
        const signal = AbortSignal.any([feed.controller.signal, ...(init?.signal ? [init.signal] : [])]);
        if (String(url).includes("/speakers")) {
          voices = await this.options.voice.voices();
          return Response.json(await this.options.voice.hear(new Uint8Array(init?.body as Uint8Array), id, signal, feed.meter));
        }
        const body = JSON.parse(String(init?.body));
        return Response.json(await this.options.translator.translate(body.texts, body.from, body.to, { by: id, deadline: Date.now() + 10_000 }));
      }) as typeof fetch,
    });
    return feed;
  }
  private async start(feed: Feed): Promise<void> {
    try {
      const input = await (this.options.open ?? liveInput())(feed.source, bytes => {
        if (feed.controller.signal.aborted) return;
        feed.pending = Buffer.concat([feed.pending, bytes]);
        while (feed.pending.length >= 64_000) {
          const fresh = feed.pending.subarray(0, 64_000); feed.pending = feed.pending.subarray(64_000);
          const pcm = Buffer.concat([feed.previous, fresh]); feed.previous = pcm.subarray(-128_000);
          feed.until += 2000;
          if (Math.abs(Date.now() - feed.until) > 2000) feed.until = Date.now();
          const samples = new Float32Array(pcm.length / 2);
          for (let index = 0; index < samples.length; index++) samples[index] = pcm.readInt16LE(index * 2) / 32768;
          feed.interpreter.push({ samples, at: feed.until - samples.length / 16, until: feed.until, freshAt: feed.until - 2000 });
        }
      }, () => this.stop(feed, "The live source stopped. Enable translated audio again when playback resumes."), feed.controller.signal);
      if (feed.controller.signal.aborted) input.stop(); else feed.input = input;
    } catch (error) { this.stop(feed, error instanceof SpeechError ? error.message : "The live source could not be opened."); }
  }
  private async speak(feed: Feed): Promise<void> {
    feed.speaking = true;
    try {
      while (feed.queue.length && !feed.controller.signal.aborted) {
        const line = feed.queue.shift()!;
        if (Date.now() - line.until > 12_000) throw new SpeechError("Live translation fell behind. Enable it again to retry.", 503);
        const response = await this.options.voice.stream({ text: line.text, language: feed.language, channel: feed.id, speaker: line.speaker, voice: feed.interpreter.tracker.speakers.get(line.speaker ?? "")?.voice }, feed.id, feed.controller.signal, feed.meter);
        const id = randomUUID();
        this.broadcast(feed, { type: "line", id, line });
        const reader = response.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            for (let at = 0; at < value.length; at += 16_384) this.broadcast(feed, { type: "audio", id, data: Buffer.from(value.subarray(at, at + 16_384)).toString("base64") });
          }
        } finally { reader.releaseLock(); }
        this.broadcast(feed, { type: "end", id });
      }
    } catch (error) { if (!feed.controller.signal.aborted) this.stop(feed, error instanceof SpeechError ? error.message : "Translated audio was interrupted."); }
    finally { feed.speaking = false; }
  }
}
