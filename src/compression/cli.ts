/**
 * `nixamp compression` -- measure it, see it, set it, bring a relay in.
 *
 *   nixamp compression analyze ./sample.ts [--seconds 30] [--format json]
 *   nixamp compression analyze --channel main [--seconds 30]
 *   nixamp compression status [--channel main]
 *   nixamp compression set --channel main --mode auto [--level 1] [--ts-aware on]
 *   nixamp compression set --channel main --hls fmp4
 *   nixamp compression off | on
 *   nixamp compression pull --channel cnn --from https://host:4321/api/channels/cnn/relay --from-key KEY
 *   nixamp compression fetch URL --out FILE [--key KEY]
 *
 * A file is analysed here, with no server. Everything else talks to a
 * running server over the same routes a browser would: the local daemon
 * by default, or --url and --key for another machine, exactly as
 * `nixamp admin` finds its target. JSON goes to stdout and only JSON;
 * progress and complaints go to stderr; a failure is a nonzero exit.
 */
import { createWriteStream } from "node:fs";
import { resolveTarget } from "../admin.ts";
import { detectTools } from "../audio.ts";
import { KEY_HEADER } from "../share.ts";
import type { Analysis } from "./analyze.ts";
import { RelayError } from "./envelope.ts";
import type { Job } from "./jobs.ts";
import { receiveRelay, RelayRefused } from "./receiver.ts";
import { analyzeFile, type ChannelStatus } from "./service.ts";

const USAGE = `nixamp compression — lossless relay compression: measure it, see it, set it.

  nixamp compression analyze FILE [--seconds N] [--format json|text]
  nixamp compression analyze --channel ID [--seconds N]
  nixamp compression status [--channel ID]
  nixamp compression set --channel ID [--mode off|auto|zstd] [--level 1-19]
                         [--boundary channel|source] [--ts-aware on|off] [--hls mpegts|fmp4]
  nixamp compression off | on          the whole server's switch
  nixamp compression pull --channel ID --from URL [--from-key KEY] [--name NAME]
  nixamp compression fetch URL --out FILE [--key KEY]

  --url U --key K  a server other than the local daemon, as for \`nixamp admin\`
  --format json    JSON on stdout (the default when stdout is not a terminal)
`;

interface Flags {
  positional: string[];
  named: Map<string, string>;
}

function parse(argv: string[]): Flags {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) named.set(arg.slice(2, eq), arg.slice(eq + 1));
      else if (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("--")) named.set(arg.slice(2), argv[(i += 1)] as string);
      else named.set(arg.slice(2), "true");
    } else {
      positional.push(arg);
    }
  }
  return { positional, named };
}

function wantsJson(flags: Flags): boolean {
  const format = flags.named.get("format");
  if (format === "json") return true;
  if (format === "text") return false;
  return !process.stdout.isTTY;
}

/** Talk to the server the way a browser does, key in the header. */
async function call(flags: Flags, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = resolveTarget([
    ...(flags.named.has("url") ? ["--url", flags.named.get("url") as string] : []),
    ...(flags.named.has("key") ? ["--key", flags.named.get("key") as string] : []),
  ]);
  const headers: Record<string, string> = { accept: "application/json" };
  if (target.key) headers[KEY_HEADER] = target.key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${target.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let parsedBody: Record<string, unknown> = {};
  try {
    parsedBody = (await response.json()) as Record<string, unknown>;
  } catch {
    parsedBody = { error: `${response.status} ${response.statusText}` };
  }
  return { status: response.status, body: parsedBody };
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function describeAnalysis(a: Analysis): string {
  const lines = [
    `  ${a.source.kind} ${a.source.name}`,
    `  boundary ${a.boundary}; sample ${kb(a.sampleBytes)}${a.truncated ? " (truncated)" : ""}${a.sampleMs ? ` over ${(a.sampleMs / 1000).toFixed(1)}s` : ""}; container ${a.container}`,
  ];
  if (a.codecs) lines.push(`  ffprobe: ${a.codecs.container} video=${a.codecs.video || "-"} audio=${a.codecs.audio || "-"}${a.codecs.duration ? ` ${a.codecs.duration.toFixed(0)}s` : ""}`);
  if (a.observedKbps) lines.push(`  observed ${a.observedKbps} kbps`);
  if (a.ts) {
    lines.push(`  transport stream: ${a.ts.packetSize}-byte packets, ${a.ts.packets} packets, ${(a.ts.nullShare * 100).toFixed(1)}% null, ${a.ts.pids.length} PIDs${a.ts.pcrBitrateKbps ? `, PCR says ${a.ts.pcrBitrateKbps} kbps` : ""}${a.ts.scrambled ? `, ${a.ts.scrambled} scrambled` : ""}`);
  }
  lines.push("  mode      level  wire bytes     saving   enc ms  dec ms  round trip");
  for (const row of a.bench) {
    lines.push(
      `  ${row.mode.padEnd(9)} ${String(row.level).padStart(5)}  ${String(row.wireBytes).padStart(10)}  ${(row.savingsPercent >= 0 ? "+" : "") + row.savingsPercent.toFixed(2).padStart(6)}%  ${row.encodeMs.toFixed(1).padStart(6)}  ${row.decodeMs.toFixed(1).padStart(6)}  ${row.roundTrip ? "ok" : "FAILED"}${row.note ? `  (${row.note})` : ""}`,
    );
  }
  lines.push(`  recommendation: ${a.recommendation.mode}${a.recommendation.level ? ` level ${a.recommendation.level}` : ""} — ${a.recommendation.reason}`);
  lines.push(`  ${a.tools.runtime}, zstd ${a.tools.zstd}, sha256 ${a.sha256.slice(0, 16)}…, ${a.at}`);
  return lines.join("\n");
}

function describeStatus(s: ChannelStatus): string {
  const c = s.configured.losslessCompression;
  const e = s.effective.losslessCompression;
  const lines = [
    `  ${s.channel}${s.live ? "" : " (not on the air)"}`,
    `  lossless: configured ${c.mode} at ${c.boundary}, level ${c.zstdLevel}${c.tsAware ? ", ts-aware" : ""}; effective ${e.mode}${s.effective.reason ? ` — ${s.effective.reason}` : ""}`,
    `  hls packaging: ${s.effective.hlsPackaging}; quality: ${s.effective.qualityProfile}; policy version ${s.configured.version}`,
    `  server switch: ${s.global.enabled ? "on" : "OFF"}`,
  ];
  if (s.relay) lines.push(`  relaying to ${s.relay.sessions} receiver${s.relay.sessions === 1 ? "" : "s"}, generation ${s.relay.generation}`);
  if (s.incoming) lines.push(`  fed by ${s.incoming.from} (generation ${s.incoming.generation}, ${s.incoming.reconnects} redials${s.incoming.error ? `, last: ${s.incoming.error}` : ""})`);
  const m = s.metrics;
  if (m && m.blocks > 0) {
    const saved = m.inputBytes - m.representationBytes;
    lines.push(
      `  this generation: in ${kb(m.inputBytes)}, representation ${kb(m.representationBytes)} (${saved >= 0 ? "-" : "+"}${((Math.abs(saved) * 100) / Math.max(1, m.inputBytes)).toFixed(1)}%), wire ${kb(m.wireBytes)} across listeners`,
      `  blocks ${m.blocks}: ${m.compressedBlocks} ${m.activeMode === "stored" ? "compressed" : m.activeMode}, ${m.storedBlocks} stored${m.bypassed ? " (bypassed)" : ""}; latency p50 ${m.latencyMs.p50.toFixed(1)}ms p95 ${m.latencyMs.p95.toFixed(1)}ms; queue ${kb(m.queueBytes)}`,
    );
    if (m.fallbackReason) lines.push(`  reason: ${m.fallbackReason}`);
  }
  return lines.join("\n");
}

async function analyze(flags: Flags): Promise<number> {
  const json = wantsJson(flags);
  const channel = flags.named.get("channel");
  const seconds = Number(flags.named.get("seconds") ?? 30);
  if (!channel) {
    const file = flags.positional[1];
    if (!file) {
      console.error(USAGE);
      return 2;
    }
    console.error(`  Reading ${file}…`);
    const tools = detectTools();
    const result = await analyzeFile(file, { ffprobe: tools.ffprobe });
    console.log(json ? JSON.stringify(result, null, 2) : describeAnalysis(result));
    return 0;
  }
  const started = await call(flags, "POST", `/api/channels/${encodeURIComponent(channel)}/compression/analyses`, { seconds });
  if (started.status !== 202 && started.status !== 200) {
    console.error(`nixamp: ${started.body["error"] ?? started.status}`);
    return 1;
  }
  let job = started.body["job"] as Job;
  console.error(`  Analysis ${job.id} ${started.body["existing"] ? "already running" : "started"}: up to ${seconds}s of "${channel}"…`);
  while (job.status === "queued" || job.status === "running") {
    await new Promise((done) => setTimeout(done, 1000));
    const poll = await call(flags, "GET", `/api/compression/analyses/${job.id}`);
    if (poll.status !== 200) {
      console.error(`nixamp: ${poll.body["error"] ?? poll.status}`);
      return 1;
    }
    job = poll.body["job"] as Job;
    if (job.status === "running") process.stderr.write(`\r  ${kb(job.progress.bytes)} in ${(job.progress.ms / 1000).toFixed(0)}s`);
  }
  process.stderr.write("\n");
  if (job.status !== "done" || !job.result) {
    console.error(`nixamp: analysis ${job.status}${job.error ? `: ${job.error}` : ""}`);
    return 1;
  }
  console.log(json ? JSON.stringify(job.result, null, 2) : describeAnalysis(job.result));
  return 0;
}

async function status(flags: Flags): Promise<number> {
  const json = wantsJson(flags);
  const channel = flags.named.get("channel");
  const got = await call(flags, "GET", channel ? `/api/channels/${encodeURIComponent(channel)}/compression` : "/api/compression");
  if (got.status !== 200) {
    console.error(`nixamp: ${got.body["error"] ?? got.status}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(got.body, null, 2));
    return 0;
  }
  if (channel) {
    console.log(describeStatus(got.body as unknown as ChannelStatus));
    return 0;
  }
  const overview = got.body as { global: { enabled: boolean; hlsPackaging: string }; channels: ChannelStatus[]; pool: Record<string, number>; cache: { bytes: number; entries: number } | null };
  console.log(`  server switch ${overview.global.enabled ? "on" : "OFF"}; hls ${overview.global.hlsPackaging}; pool running ${overview.pool["running"]} queued ${overview.pool["queued"]}${overview.cache ? `; cache ${kb(overview.cache.bytes)} in ${overview.cache.entries} files` : ""}`);
  for (const one of overview.channels) console.log(describeStatus(one));
  if (overview.channels.length === 0) console.log("  no channels with a policy or on the air");
  return 0;
}

async function set(flags: Flags): Promise<number> {
  const channel = flags.named.get("channel");
  if (!channel) {
    console.error("nixamp: say which channel: --channel ID");
    return 2;
  }
  const lossless: Record<string, unknown> = {};
  const change: Record<string, unknown> = {};
  const mode = flags.named.get("mode");
  if (mode) lossless["mode"] = mode;
  const boundary = flags.named.get("boundary");
  if (boundary) lossless["boundary"] = boundary;
  const level = flags.named.get("level");
  if (level) lossless["zstdLevel"] = Number(level);
  const ts = flags.named.get("ts-aware");
  if (ts) lossless["tsAware"] = ts === "on" || ts === "true";
  for (const [flag, key] of [["min-savings-percent", "minSavingsPercent"], ["min-savings-bytes", "minSavingsBytes"], ["max-block-bytes", "maxBlockBytes"], ["max-hold-ms", "maxHoldMs"]] as const) {
    const value = flags.named.get(flag);
    if (value) lossless[key] = Number(value);
  }
  if (Object.keys(lossless).length > 0) change["losslessCompression"] = lossless;
  const hls = flags.named.get("hls");
  if (hls) change["hlsPackaging"] = hls;
  if (Object.keys(change).length === 0) {
    console.error("nixamp: nothing to set; see `nixamp compression --help`");
    return 2;
  }
  const expect = flags.named.get("expect-version");
  const result = await call(flags, "PATCH", `/api/channels/${encodeURIComponent(channel)}/compression`, expect ? { ...change, version: Number(expect) } : change);
  if (result.status !== 200) {
    console.error(`nixamp: ${result.body["error"] ?? result.status}`);
    return 1;
  }
  console.log(wantsJson(flags) ? JSON.stringify(result.body, null, 2) : describeStatus(result.body as unknown as ChannelStatus));
  return 0;
}

async function toggle(flags: Flags, enabled: boolean): Promise<number> {
  const result = await call(flags, "PATCH", "/api/compression", { enabled });
  if (result.status !== 200) {
    console.error(`nixamp: ${result.body["error"] ?? result.status}`);
    return 1;
  }
  console.log(wantsJson(flags) ? JSON.stringify(result.body, null, 2) : `  compression is ${enabled ? "on: channels follow their own policies" : "OFF for the whole server: no new relay starts, and running ones end"}`);
  return 0;
}

async function pull(flags: Flags): Promise<number> {
  const channel = flags.named.get("channel");
  const from = flags.named.get("from");
  if (!channel || !from) {
    console.error("nixamp: say which channel and where from: --channel ID --from URL");
    return 2;
  }
  const result = await call(flags, "POST", `/api/channels/${encodeURIComponent(channel)}/relay`, {
    from,
    ...(flags.named.has("from-key") ? { key: flags.named.get("from-key") } : {}),
    ...(flags.named.has("name") ? { name: flags.named.get("name") } : {}),
  });
  if (result.status !== 202) {
    console.error(`nixamp: ${result.body["error"] ?? result.status}`);
    return 1;
  }
  console.log(wantsJson(flags) ? JSON.stringify(result.body, null, 2) : `  "${channel}" is being brought in from ${from}; \`nixamp compression status --channel ${channel}\` says how it is going`);
  return 0;
}

/** Receive one relay (or a static representation) into a file, checking every frame. */
async function fetchRelay(flags: Flags): Promise<number> {
  const url = flags.positional[1];
  const out = flags.named.get("out");
  if (!url || !out) {
    console.error("nixamp: fetch URL --out FILE");
    return 2;
  }
  const file = createWriteStream(out);
  let bytes = 0;
  const began = Date.now();
  try {
    const result = await receiveRelay({
      url,
      key: flags.named.get("key") ?? null,
      onStart: ({ codecs, kind }) => console.error(`  Receiving${kind ? ` ${kind}` : ""} with ${codecs || "stored"}…`),
      onBytes: (chunk) =>
        new Promise<void>((done) => {
          bytes += chunk.length;
          if (bytes % (1024 * 1024) < chunk.length) process.stderr.write(`\r  ${kb(bytes)}`);
          if (file.write(chunk)) done();
          else file.once("drain", done);
        }),
    });
    await new Promise<void>((done) => file.end(done));
    process.stderr.write("\n");
    console.log(JSON.stringify({ ok: true, out, bytes: result.bytes, frames: result.frames, generation: result.generation, ms: Date.now() - began }));
    return 0;
  } catch (error) {
    file.destroy();
    process.stderr.write("\n");
    if (error instanceof RelayError) console.error(`nixamp: the stream broke a rule: ${error.code}: ${error.message}`);
    else if (error instanceof RelayRefused) console.error(`nixamp: refused (${error.status}): ${error.message}`);
    else console.error(`nixamp: ${(error as Error).message}`);
    return 1;
  }
}

export async function compression(argv: string[]): Promise<number> {
  const flags = parse(argv);
  const verb = flags.positional[0];
  try {
    switch (verb) {
      case "analyze":
      case "analyse":
        return await analyze(flags);
      case "status":
        return await status(flags);
      case "set":
        return await set(flags);
      case "off":
        return await toggle(flags, false);
      case "on":
        return await toggle(flags, true);
      case "pull":
        return await pull(flags);
      case "fetch":
        return await fetchRelay(flags);
      default:
        console.error(USAGE);
        return verb === undefined || verb === "help" || flags.named.has("help") ? 0 : 2;
    }
  } catch (error) {
    console.error(`nixamp: ${(error as Error).message}`);
    return 1;
  }
}
