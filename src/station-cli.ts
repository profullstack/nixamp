/**
 * `nixamp station`: stations from a terminal, a script or a cron job.
 *
 * Talks to the daemon on this machine with its control key, or to another
 * server with --url and --key, exactly as `nixamp admin` does. Every command
 * takes --json for a script; without it, a line a person can read. Exit codes
 * a script can branch on: 0 done, 1 the server said no (the reason and a
 * stable code are printed), 2 the command was wrong, 3 the server could not
 * be reached.
 *
 * Nothing here publishes as a side effect. `create` and `start` leave a
 * station private; `publish` is its own command and says on what basis.
 */
import { resolveTarget } from "./admin.ts";
import { readState } from "./daemon.ts";
import { KEY_HEADER } from "./share.ts";

import { USAGE } from "./station-usage.ts";

export { USAGE };

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

class Unreachable extends Error {}

export async function station(argv: string[]): Promise<number> {
  const [command, id] = argv;
  const json = has(argv, "--json");
  if (!command || command === "help" || has(argv, "--help")) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  let target;
  try {
    target = resolveTarget(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 3;
  }
  const headers: Record<string, string> = { "content-type": "application/json", ...(target.key ? { [KEY_HEADER]: target.key } : {}) };
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    let response: Response;
    try {
      response = await fetch(`${target.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new Unreachable(`could not reach ${target.url}: ${(error as Error).message}`);
    }
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text }; }
    return { status: response.status, body: parsed };
  };
  const needId = (): string | null => {
    if (!id || id.startsWith("--")) {
      console.error(`nixamp station ${command} needs a station id. \`nixamp station list\` shows them.`);
      return null;
    }
    return id;
  };
  const show = (answer: Answer, line: (body: Record<string, unknown>) => string): number => {
    if (json) {
      console.log(JSON.stringify(answer.body, null, 2));
    } else if (answer.status < 400) {
      console.log(line(answer.body));
    }
    if (answer.status >= 400) {
      if (!json) console.error(`nixamp: ${String(answer.body["error"] ?? "refused")} (${String(answer.body["code"] ?? answer.status)})`);
      return 1;
    }
    return 0;
  };
  const describe = (station: Record<string, unknown>): string => {
    const links = (station["links"] ?? {}) as Record<string, string>;
    return [
      `${String(station["name"])}  [${String(station["id"])}]`,
      `  state       ${String(station["state"])} (wanted ${String(station["desired"])})`,
      `  visibility  ${String(station["visibility"])}${station["listed"] ? ", listed in the directory" : ""}`,
      `  rotation    ${station["shuffle"] ? "shuffle" : "in order"}${station["repeat"] ? ", repeating" : ", once"}; ${(station["items"] as unknown[] | undefined)?.length ?? 0} files at ${String(station["bitrate"])} kbps`,
      `  breaks      ${Number(station["breaksEvery"] ?? 0) > 0 ? `a spot every ${Math.round(Number(station["breaksEvery"]) / 60)} min, between entries` : "none"}`,
      ...(station["error"] ? [`  problem     ${String(station["error"])}`] : []),
      ...((station["excluded"] as unknown[] | undefined)?.length ? [`  left out   ${(station["excluded"] as unknown[]).length} files (nixamp station retry)`] : []),
      ...(station["visibility"] !== "private" && links["page"] ? [`  listen      ${links["page"]}`] : []),
    ].join("\n");
  };

  try {
    switch (command) {
      case "list": {
        const answer = await call("GET", "/api/v1/stations?limit=200");
        return show(answer, (body) => {
          const all = (body["stations"] as Record<string, unknown>[] | undefined) ?? [];
          return all.length === 0 ? "No stations yet. nixamp station create --name NAME --folder PATH" : all.map(describe).join("\n\n");
        });
      }
      case "create": {
        const name = flag(argv, "--name");
        if (!name) {
          console.error("nixamp station create needs --name");
          return 2;
        }
        const items = flag(argv, "--items");
        let folder = flag(argv, "--folder");
        if (folder !== undefined) {
          // A path under the library is taken relative to it.
          const root = readState()?.source ?? "";
          if (root && folder.startsWith(root)) folder = folder.slice(root.length);
        }
        const playlist = flag(argv, "--playlist");
        if (items === undefined && folder === undefined && playlist === undefined) {
          console.error("nixamp station create needs --folder PATH, --playlist ID or --items 0,1,2");
          return 2;
        }
        const bitrate = flag(argv, "--bitrate");
        const answer = await call("POST", "/api/v1/stations", {
          name,
          ...(playlist !== undefined ? { playlist } : items !== undefined ? { items: items.split(",").map((one) => Number(one.trim())) } : { folder }),
          shuffle: has(argv, "--shuffle"),
          repeat: !has(argv, "--no-repeat"),
          ...(bitrate ? { bitrate: Number(bitrate) } : {}),
          ...(flag(argv, "--breaks") ? { breaksEvery: Number(flag(argv, "--breaks")) } : {}),
        });
        return show(answer, (body) => `Made (private, stopped):\n${describe(body["station"] as Record<string, unknown>)}`);
      }
      case "show":
      case "status": {
        const station = needId();
        if (!station) return 2;
        return show(await call("GET", `/api/v1/stations/${station}`), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "start":
      case "stop":
      case "skip":
      case "retry": {
        const station = needId();
        if (!station) return 2;
        return show(await call("POST", `/api/v1/stations/${station}/${command}`, {}), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "breaks": {
        const station = needId();
        if (!station) return 2;
        const seconds = argv.includes("--off") ? 0 : Number(argv[argv.indexOf(station) + 1]);
        if (!Number.isFinite(seconds)) {
          console.error("nixamp station breaks ID SECONDS (or --off)");
          return 2;
        }
        return show(await call("PATCH", `/api/v1/stations/${station}`, { breaksEvery: seconds }), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "publish": {
        const station = needId();
        if (!station) return 2;
        const basis = flag(argv, "--basis");
        const unlisted = has(argv, "--unlisted");
        const access: Record<string, unknown> = {
          visibility: unlisted ? "unlisted" : "public",
          listed: !unlisted && !has(argv, "--no-list"),
          ...(basis ? { rights: { basis, note: flag(argv, "--note") ?? "" } } : {}),
        };
        return show(await call("POST", `/api/v1/stations/${station}/access`, access), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "unpublish": {
        const station = needId();
        if (!station) return 2;
        const access = has(argv, "--private") ? { visibility: "private" } : { listed: false };
        return show(await call("POST", `/api/v1/stations/${station}/access`, access), (body) => {
          const dropped = Number(body["dropped"] ?? 0);
          return `${describe(body["station"] as Record<string, unknown>)}${dropped ? `\n  ${dropped} listener(s) disconnected; old links no longer work.` : ""}`;
        });
      }
      case "link": {
        const station = needId();
        if (!station) return 2;
        const answer = has(argv, "--rotate")
          ? await call("POST", `/api/v1/stations/${station}/rotate-link`, {})
          : await call("GET", `/api/v1/stations/${station}`);
        return show(answer, (body) => {
          const links = ((body["station"] as Record<string, unknown>)["links"] ?? {}) as Record<string, string>;
          return [`page    ${links["page"]}`, `stream  ${links["stream"]}`, `m3u     ${links["m3u"]}`].join("\n");
        });
      }
      case "guide-host": {
        // This machine's own setting, read by the daemon on every request.
        const { readConfig, writeConfig } = await import("./library.ts");
        const host = (id ?? "").trim().toLowerCase();
        const hosts = new Set(readConfig().guideHosts ?? []);
        if (argv.includes("--remove")) hosts.delete(host); else if (host) hosts.add(host);
        writeConfig({ guideHosts: [...hosts] });
        console.log(hosts.size ? `The guide is the front page for: ${[...hosts].join(", ")}` : "No host shows the guide as its front page (it is still at /guide).");
        return 0;
      }
      case "guide-ads": {
        // crawlproof analytics + an ad unit on the guide; read by the daemon on every request.
        const { readConfig, writeConfig } = await import("./library.ts");
        const { cleanGuideAds } = await import("./station-guide.ts");
        const raw = argv.includes("--off") ? {} : { ...(readConfig().guideAds ?? {}), ...Object.fromEntries(
          (["site", "slot", "format"] as const).flatMap((name) => { const value = flag(argv, `--${name}`); return value === undefined ? [] : [[name, value]]; }),
        ) };
        const next = cleanGuideAds(raw);
        for (const name of ["site", "slot"] as const) {
          if (typeof (raw as Record<string, unknown>)[name] === "string" && (raw as Record<string, unknown>)[name] !== "" && !next[name]) {
            console.error(`--${name} is a crawlproof id (letters, digits and dashes)`);
            return 2;
          }
        }
        writeConfig({ guideAds: next });
        console.log([
          next.site ? `Tracker   crawlproof project ${next.site}` : "Tracker   off",
          next.slot ? `Ad        crawlproof slot ${next.slot} (${next.format ?? "banner_300x250"})` : "Ad        off",
        ].join("\n"));
        return 0;
      }
      case "guide-peer": {
        // Another server whose public, listed stations this guide shows too.
        const { readConfig, writeConfig } = await import("./library.ts");
        const { peerBase } = await import("./station-guide.ts");
        const peer = peerBase(id ?? "");
        if (id && !peer) {
          console.error("A guide peer is an https address, e.g. https://server2.example.com:4321");
          return 2;
        }
        const peers = new Set(readConfig().guidePeers ?? []);
        if (argv.includes("--remove")) peers.delete(peer); else if (peer) peers.add(peer);
        writeConfig({ guidePeers: [...peers] });
        console.log(peers.size ? `The guide also lists the public stations of: ${[...peers].join(", ")}` : "The guide lists only this server's stations.");
        return 0;
      }
      case "auto": {
        const body: Record<string, unknown> = argv.includes("--off") ? { off: true } : {
          ...(argv.includes("--no-video") ? { video: false } : {}),
          ...(argv.includes("--no-start") ? { start: false } : {}),
          ...(flag(argv, "--min") ? { minItems: Number(flag(argv, "--min")) } : {}),
          ...(flag(argv, "--films") ? { minFilms: Number(flag(argv, "--films")) } : {}),
          ...(flag(argv, "--tv") ? { maxVideoRunning: Number(flag(argv, "--tv")) } : {}),
          ...(flag(argv, "--breaks") ? { breaksEvery: Number(flag(argv, "--breaks")) } : {}),
        };
        const started = await call("POST", "/api/v1/stations/auto", body);
        let answer = started;
        if (started.status < 400 && !body["off"]) {
          // Started in the background; wait for it to say what it made.
          for (let tries = 0; tries < 600; tries++) {
            await new Promise((next) => setTimeout(next, 1000));
            const state = await call("GET", "/api/v1/stations/auto");
            const setting = state.body["setting"] as { running?: boolean; last?: { report?: unknown } } | undefined;
            if (!setting?.running && setting?.last?.report) {
              answer = { status: 200, body: { report: setting.last.report } };
              break;
            }
          }
        }
        return show(answer, (answer) => {
          const report = answer["report"] as { off?: boolean; radio?: Array<Record<string, unknown>>; tv?: Array<Record<string, unknown>>; skipped?: string[] };
          if (report.off) return "Auto stations are off. The stations already made stay as they are.";
          const line = (one: Record<string, unknown>, unit: string) => `  ${String(one["genre"]).padEnd(16)} ${String(one["files"] ?? one["films"]).padStart(5)} ${unit}  ${one["running"] ? "on air" : "stopped"}${one["made"] ? "  (new)" : ""}  [${String(one["id"])}]`;
          return [
            "Radio:", ...(report.radio ?? []).map((one) => line(one, "files")),
            "TV:", ...((report.tv ?? []).length ? (report.tv ?? []).map((one) => line(one, "films")) : ["  none (no film genres known yet)"]),
            ...((report.skipped ?? []).length ? [`Too small for a station: ${(report.skipped ?? []).join(", ")}`] : []),
            "Every library scan keeps these up to date. They are unlisted: `nixamp station link ID` for a link.",
          ].join("\n");
        });
      }
      case "ai":
        return await aiCommand(argv.slice(1), call, show, json);
      case "label":
        return await labelCommand(argv.slice(1), call, show);
      case "shares":
        return await sharesCommand(argv.slice(1), call, show);
      case "lyrics":
        return await lyricsCommand(argv.slice(1), call, show, json);
      case "holder":
      case "holders": {
        const sub = argv[1] ?? "list";
        const all = (flagName: string): string[] => argv.flatMap((one, at) => (one === flagName && argv[at + 1] ? [argv[at + 1]!] : []));
        const line = (h: Record<string, unknown>): string =>
          `${String(h["name"])}  [${String(h["id"])}]\n  artists   ${((h["artists"] as string[]) ?? []).join(", ") || "-"}\n  stations  ${((h["stations"] as string[]) ?? []).join(", ") || "-"}\n  support   ${String(h["support"] || "-")}${h["license"] ? `\n  licence   ${String(h["license"])}` : ""}`;
        if (sub === "list") return show(await call("GET", "/api/v1/stations/holders"), (body) => ((body["holders"] as Record<string, unknown>[]) ?? []).map(line).join("\n\n") || "No copyright holders yet. nixamp station holder set NAME --artist ARTIST --support URL");
        if (sub === "remove") return show(await call("DELETE", `/api/v1/stations/holders/${argv[2] ?? ""}`), () => `Removed ${argv[2]}.`);
        if (sub === "set") {
          const name = argv[2];
          if (!name || name.startsWith("--")) { console.error("nixamp station holder set needs a NAME"); return 2; }
          const body: Record<string, unknown> = { name };
          if (all("--artist").length) body["artists"] = all("--artist");
          if (all("--station").length) body["stations"] = all("--station");
          if (flag(argv, "--support")) body["support"] = flag(argv, "--support");
          if (flag(argv, "--label")) body["label"] = flag(argv, "--label");
          if (flag(argv, "--license")) body["license"] = flag(argv, "--license");
          return show(await call("POST", "/api/v1/stations/holders", body), (answer) => line(answer["holder"] as Record<string, unknown>));
        }
        console.error(`nixamp station holder: no command "${sub}".\n\n${USAGE}`);
        return 2;
      }
      case "delete": {
        const station = needId();
        if (!station) return 2;
        return show(await call("DELETE", `/api/v1/stations/${station}`), () => `Deleted ${station}. Its files were not touched.`);
      }
      default:
        console.error(`nixamp station: no command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof Unreachable) {
      console.error(`nixamp: ${error.message}`);
      return 3;
    }
    throw error;
  }
}

type Call = (method: string, path: string, body?: unknown) => Promise<Answer>;
type Show = (answer: Answer, line: (body: Record<string, unknown>) => string) => number;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text.trim();
}

/** `nixamp station ai ...` */
async function aiCommand(argv: string[], call: Call, show: Show, json: boolean): Promise<number> {
  const [sub, key] = argv;
  const describe = (one: Record<string, unknown>): string => [
    `${String(one["name"])}  [${String(one["key"])}]${one["enabled"] ? "" : "  (off)"}`,
    `  style      ${String(one["style"])}`,
    `  tracks     ${Array.isArray(one["tracks"]) ? one["tracks"].length : Number(one["tracks"] ?? 0)} of ${String(one["trackSeconds"])} s, ${String(one["perDay"])} a day${one["vocals"] ? ", with vocals" : ""}`,
    `  station    ${one["stationId"] ? String(one["stationId"]) : "made with its first track"}${one["publish"] ? ", public on the guide" : ", unlisted"}`,
    ...(one["lastError"] ? [`  problem    ${String(one["lastError"])}`] : []),
  ].join("\n");
  switch (sub) {
    case undefined:
    case "status":
    case "list":
      return show(await call("GET", "/api/v1/stations/ai"), (body) => {
        const keys = (body["keys"] ?? {}) as Record<string, boolean>;
        const stations = (body["stations"] as Record<string, unknown>[] | undefined) ?? [];
        return [
          `composer   ${String(body["composer"] ?? "none")}; briefs by ${String(body["writer"])}`,
          `this month ${String(body["secondsThisMonth"])} of ${Number(body["monthlySeconds"]) === 0 ? "unlimited" : String(body["monthlySeconds"])} s${body["busy"] ? `; composing for ${String(body["busy"])}` : ""}`,
          ...(body["paused"] ? [`paused     ${String(body["paused"])}`] : []),
          `keys       ${Object.entries(keys).map(([name, set]) => `${name} ${set ? "set" : "-"}`).join(", ")}`,
          "",
          ...(stations.length ? stations.map(describe) : [`No AI stations yet. nixamp station ai create --preset ${((body["presets"] as string[] | undefined) ?? ["lofi"])[0]}`]),
        ].join("\n");
      });
    case "create": {
      const seconds = flag(argv, "--seconds");
      const perDay = flag(argv, "--per-day");
      const body = {
        ...(flag(argv, "--preset") ? { preset: flag(argv, "--preset") } : {}),
        ...(flag(argv, "--name") ? { name: flag(argv, "--name") } : {}),
        ...(flag(argv, "--style") ? { style: flag(argv, "--style") } : {}),
        ...(flag(argv, "--description") ? { description: flag(argv, "--description") } : {}),
        ...(has(argv, "--vocals") ? { vocals: true } : has(argv, "--instrumental") ? { vocals: false } : {}),
        ...(seconds ? { trackSeconds: Number(seconds) } : {}),
        ...(perDay ? { perDay: Number(perDay) } : {}),
        publish: !has(argv, "--unlisted"),
      };
      return show(await call("POST", "/api/v1/stations/ai/stations", body), (answer) =>
        `Made. Its first tracks are being composed now; the station appears with the first.\n${describe(answer["station"] as Record<string, unknown>)}`);
    }
    case "generate": {
      if (!key) { console.error("nixamp station ai generate needs the AI station's key (nixamp station ai)"); return 2; }
      if (!json) console.log("Composing; this takes a minute or two…");
      return show(await call("POST", `/api/v1/stations/ai/stations/${key}/generate`, {}), (answer) => {
        const track = answer["track"] as Record<string, unknown>;
        return `"${String(track["title"])}" (${String(track["seconds"])} s, ${String(track["made"])}) is on the station.`;
      });
    }
    case "set": {
      if (!key) { console.error("nixamp station ai set needs the AI station's key"); return 2; }
      const body = {
        ...(flag(argv, "--style") ? { style: flag(argv, "--style") } : {}),
        ...(flag(argv, "--name") ? { name: flag(argv, "--name") } : {}),
        ...(flag(argv, "--per-day") ? { perDay: Number(flag(argv, "--per-day")) } : {}),
        ...(flag(argv, "--seconds") ? { trackSeconds: Number(flag(argv, "--seconds")) } : {}),
        ...(has(argv, "--off") ? { enabled: false } : has(argv, "--on") ? { enabled: true } : {}),
        ...(has(argv, "--vocals") ? { vocals: true } : has(argv, "--instrumental") ? { vocals: false } : {}),
      };
      return show(await call("PATCH", `/api/v1/stations/ai/stations/${key}`, body), (answer) => describe(answer["station"] as Record<string, unknown>));
    }
    case "remove": {
      if (!key) { console.error("nixamp station ai remove needs the AI station's key"); return 2; }
      const files = has(argv, "--files");
      return show(await call("DELETE", `/api/v1/stations/ai/stations/${key}${files ? "?files=1" : ""}`), () =>
        files ? "Removed, with its station and its music." : "Removed. Its station and its music stay; nothing new will be composed.");
    }
    case "budget":
      return show(await call("POST", "/api/v1/stations/ai", { monthlySeconds: Number(key) }), (answer) => {
        const settings = answer["settings"] as Record<string, unknown>;
        return `AI music: at most ${Number(settings["monthlySeconds"]) === 0 ? "unlimited" : `${String(settings["monthlySeconds"])} s`} a month.`;
      });
    case "resume":
      return show(await call("POST", "/api/v1/stations/ai", { resume: true }), () => "Composing again.");
    case "key": {
      if (!key) { console.error("nixamp station ai key needs a name, e.g. ELEVENLABS_API_KEY, and the value on stdin"); return 2; }
      const value = has(argv, "--clear") ? "" : await readStdin();
      return show(await call("POST", "/api/v1/stations/ai/keys", { name: key, value }), (answer) =>
        `Keys: ${Object.entries((answer["keys"] ?? {}) as Record<string, boolean>).map(([name, set]) => `${name} ${set ? "set" : "-"}`).join(", ")}`);
    }
    default:
      console.error(`nixamp station ai: no command "${sub}".\n\n${USAGE}`);
      return 2;
  }
}

/** `nixamp station label ...`: AI artists who put out an album a month (ai-label.ts). */
async function labelCommand(argv: string[], call: Call, show: Show): Promise<number> {
  const [sub, key] = argv;
  const when = (at: number): string => at === -1 ? "never (off)" : at === 0 ? "now" : new Date(at).toISOString().slice(0, 10);
  const describe = (one: Record<string, unknown>): string => {
    const albums = (one["albums"] as Array<Record<string, unknown>> | undefined) ?? [];
    return [
      `${String(one["name"])}  [${String(one["key"])}]  ${String(one["genre"])}${one["enabled"] ? "" : "  (off)"}`,
      ...albums.map((album) => `  ${String(album["year"])}  ${String(album["title"])}  ${String(album["composed"])}/${String(album["songs"])} songs${album["doneAt"] ? "" : "  (recording)"}`),
      `  next album ${when(Number(one["nextAlbumAt"] ?? -1))}`,
      ...(one["lastError"] ? [`  problem    ${String(one["lastError"])}`] : []),
    ].join("\n");
  };
  switch (sub) {
    case undefined:
    case "status":
    case "list":
      return show(await call("GET", "/api/v1/stations/label"), (body) => {
        const settings = (body["settings"] ?? {}) as Record<string, unknown>;
        const artists = (body["artists"] as Record<string, unknown>[] | undefined) ?? [];
        const roster = (body["roster"] as Array<Record<string, unknown>> | undefined) ?? [];
        return [
          `holder     ${String(settings["holder"])}${settings["enabled"] ? "" : "  (off)"}`,
          `files      ${String(body["root"])}/<genre>/<artist>/<year>-<album>/`,
          `composer   ${String(body["composer"] ?? "none")}; words by ${String(body["writer"] ?? "nobody (no model key)")}`,
          `this month ${String(body["secondsThisMonth"])} of ${Number(settings["monthlySeconds"]) === 0 ? "unlimited" : String(settings["monthlySeconds"])} s${body["busy"] ? `; recording ${String(body["busy"])}` : ""}`,
          `albums     ${String(settings["songsPerAlbum"])} songs of ${String(settings["songSeconds"])} s; ${String(settings["seedAlbums"])} to start, then one every ${String(settings["everyDays"])} days`,
          ...(body["waiting"] ? [`waiting    ${String(body["waiting"])}`] : []),
          "",
          ...(artists.length ? artists.map(describe) : ["Nobody signed yet. nixamp station label sign --roster"]),
          "",
          `roster     ${roster.map((one) => `${String(one["key"])}${one["signed"] ? " (signed)" : ""}`).join(", ")}`,
        ].join("\n");
      });
    case "sign": {
      const body = has(argv, "--roster") ? { roster: true } : {
        ...(flag(argv, "--preset") ? { preset: flag(argv, "--preset") } : {}),
        ...(flag(argv, "--name") ? { name: flag(argv, "--name") } : {}),
        ...(flag(argv, "--genre") ? { genre: flag(argv, "--genre") } : {}),
        ...(flag(argv, "--sound") ? { sound: flag(argv, "--sound") } : {}),
        ...(flag(argv, "--voice") ? { voice: flag(argv, "--voice") } : {}),
        ...(flag(argv, "--bio") ? { bio: flag(argv, "--bio") } : {}),
        ...(flag(argv, "--themes") ? { themes: flag(argv, "--themes") } : {}),
      };
      return show(await call("POST", "/api/v1/stations/label/artists", body), (answer) => {
        const signed = (answer["artists"] as Array<Record<string, unknown>> | undefined) ?? (answer["artist"] ? [answer["artist"] as Record<string, unknown>] : []);
        return signed.length ? `Signed ${signed.map((one) => `${String(one["name"])} (${String(one["genre"])})`).join(", ")}. Their first albums are planned and recorded from here.` : "Everybody on the roster is already signed.";
      });
    }
    case "album": {
      if (!key) { console.error("nixamp station label album needs the artist's key (nixamp station label)"); return 2; }
      return show(await call("POST", `/api/v1/stations/label/artists/${key}/album`, {}), (answer) => {
        const album = answer["album"] as Record<string, unknown>;
        return `Planned "${String(album["title"])}" (${((album["songs"] as unknown[]) ?? []).length} songs); recording now, a song at a time.`;
      });
    }
    case "set": {
      if (!key) { console.error("nixamp station label set needs the artist's key"); return 2; }
      const body = {
        ...(flag(argv, "--sound") ? { sound: flag(argv, "--sound") } : {}),
        ...(flag(argv, "--voice") ? { voice: flag(argv, "--voice") } : {}),
        ...(flag(argv, "--bio") ? { bio: flag(argv, "--bio") } : {}),
        ...(flag(argv, "--themes") ? { themes: flag(argv, "--themes") } : {}),
        ...(has(argv, "--off") ? { enabled: false } : has(argv, "--on") ? { enabled: true } : {}),
      };
      return show(await call("PATCH", `/api/v1/stations/label/artists/${key}`, body), (answer) => `${String((answer["artist"] as Record<string, unknown>)["name"])} updated.`);
    }
    case "drop": {
      if (!key) { console.error("nixamp station label drop needs the artist's key"); return 2; }
      const files = has(argv, "--files");
      return show(await call("DELETE", `/api/v1/stations/label/artists/${key}${files ? "?files=1" : ""}`), () =>
        files ? "Dropped, with their music." : "Dropped. Their albums stay on the air; nothing new will be recorded.");
    }
    case "config": {
      const number = (name: string): number | undefined => (flag(argv, name) === undefined ? undefined : Number(flag(argv, name)));
      const body = Object.fromEntries(Object.entries({
        holder: flag(argv, "--holder"),
        monthlySeconds: number("--budget"),
        everyDays: number("--every-days"),
        seedAlbums: number("--seed-albums"),
        songsPerAlbum: number("--songs"),
        songSeconds: number("--seconds"),
        enabled: has(argv, "--off") ? false : has(argv, "--on") ? true : undefined,
        publish: has(argv, "--unlisted") ? false : has(argv, "--public") ? true : undefined,
      }).filter(([, value]) => value !== undefined));
      return show(await call("POST", "/api/v1/stations/label", body), (answer) => {
        const settings = answer["settings"] as Record<string, unknown>;
        return `Label: ${String(settings["holder"])}, ${String(settings["songsPerAlbum"])} songs of ${String(settings["songSeconds"])} s an album, every ${String(settings["everyDays"])} days, at most ${Number(settings["monthlySeconds"]) === 0 ? "unlimited" : `${String(settings["monthlySeconds"])} s`} a month${settings["enabled"] ? "" : " (off)"}.`;
      });
    }
    case "run":
      return show(await call("POST", "/api/v1/stations/label/run", {}), (body) => body["waiting"] ? `Nothing to record now: ${String(body["waiting"])}.` : "Recording whatever is due.");
    case "resume":
      return show(await call("POST", "/api/v1/stations/label", { resume: true }), () => "Recording again.");
    default:
      console.error(`nixamp station label: no command "${sub}".\n\n${USAGE}`);
      return 2;
  }
}

/** `nixamp station lyrics ...`: our own songs' words, published back to nichedb.dev. */
async function lyricsCommand(argv: string[], call: Call, show: Show, json: boolean): Promise<number> {
  const [sub, id] = argv;
  switch (sub) {
    case undefined:
    case "status":
      return show(await call("GET", "/api/v1/stations/lyrics"), (body) => {
        const stations = (body["stations"] as Record<string, unknown>[] | undefined) ?? [];
        const last = body["last"] as { at: number; reports: Array<Record<string, unknown>> } | null;
        return [
          `key        ${body["key"] ? "set" : "- (nixamp station lyrics key, the value on stdin)"}`,
          `target     ${String(body["target"])}`,
          `published  ${String(body["published"])} files${body["running"] ? "; publishing now" : ""}`,
          ...(last ? [`last run   ${new Date(last.at).toISOString()}: ${last.reports.map((one) => `${String(one["station"])} +${String(one["published"])}`).join(", ") || "nothing eligible"}`] : []),
          ...(body["lastError"] ? [`problem    ${String(body["lastError"])}`] : []),
          "",
          ...stations.map((one) => `  ${String(one["id"])}  ${one["eligible"] ? "publishes" : "no       "} ${String(one["published"]).padStart(4)}/${String(one["files"]).padEnd(5)} ${String(one["name"])}${one["eligible"] ? "" : `  (${String(one["why"])})`}`),
        ].join("\n");
      });
    case "publish": {
      if (!id || id.startsWith("--")) { console.error("nixamp station lyrics publish needs a station id"); return 2; }
      if (!json) console.log("Publishing; a second between songs…");
      return show(await call("POST", `/api/v1/stations/lyrics/${id}/publish`, {}), (body) => {
        const report = body["report"] as Record<string, unknown>;
        return `${String(report["published"])} published, ${String(report["unchanged"])} already there, ${String(report["without"])} without words, ${String(report["failed"])} failed${report["stopped"] ? `\nstopped: ${String(report["stopped"])}` : ""}`;
      });
    }
    case "key": {
      const value = argv.includes("--clear") ? "" : await readStdin();
      return show(await call("POST", "/api/v1/stations/ai/keys", { name: "NIXAMP_LYRICS_KEY", value }), (answer) =>
        `nichedb lyrics key ${((answer["keys"] ?? {}) as Record<string, boolean>)["NIXAMP_LYRICS_KEY"] ? "set" : "cleared"}.`);
    }
    default:
      console.error(`nixamp station lyrics: no command "${sub}".\n\n${USAGE}`);
      return 2;
  }
}

/** `nixamp station shares ...` */
async function sharesCommand(argv: string[], call: Call, show: Show): Promise<number> {
  const [sub, id] = argv;
  const line = (one: Record<string, unknown>): string =>
    `  ${String(one["id"])}  ${String(one["state"]).padEnd(9)} ${String(one["genre"] || "?").padEnd(14)} ${String(one["title"] || one["name"])}${one["artist"] ? ` — ${String(one["artist"])}` : ""}  [${String((one["rights"] as Record<string, unknown> | undefined)?.["basis"] ?? "")}]${one["reason"] ? `\n      ${String(one["reason"])}` : ""}`;
  const summary = (body: Record<string, unknown>): string => {
    const setting = (body["setting"] ?? {}) as Record<string, unknown>;
    const shares = (body["shares"] as Record<string, unknown>[] | undefined) ?? [];
    return [
      `shares     ${setting["open"] ? "open" : "closed"}; moderation ${String(setting["moderation"])}${setting["model"] ? "" : " (no AI key: everything waits for you)"}; ${setting["publish"] ? "public on the guide" : "unlisted"}; ${Math.round(Number(setting["maxBytes"]) / 1048576)} MB, ${String(setting["perHour"])} an hour each`,
      ...(shares.length ? ["", ...shares.map(line)] : []),
    ].join("\n");
  };
  switch (sub) {
    case undefined:
    case "list": {
      const state = flag(argv, "--state");
      return show(await call("GET", `/api/v1/stations/shares${state ? `?state=${encodeURIComponent(state)}` : sub === undefined ? "?state=held" : ""}`), summary);
    }
    case "on":
    case "off": {
      const body = sub === "off" ? { open: false } : {
        open: true,
        moderation: has(argv, "--owner-moderation") ? "owner" : "ai",
        publish: !has(argv, "--unlisted"),
        ...(flag(argv, "--max-mb") ? { maxMb: Number(flag(argv, "--max-mb")) } : {}),
        ...(flag(argv, "--per-hour") ? { perHour: Number(flag(argv, "--per-hour")) } : {}),
      };
      return show(await call("POST", "/api/v1/stations/shares", body), (answer) => summary(answer));
    }
    case "approve":
    case "reject": {
      if (!id) { console.error(`nixamp station shares ${sub} needs a share id`); return 2; }
      return show(await call("POST", `/api/v1/stations/shares/${id}/${sub}`, { reason: flag(argv, "--reason") ?? "" }), (answer) => line(answer["share"] as Record<string, unknown>));
    }
    case "delete": {
      if (!id) { console.error("nixamp station shares delete needs a share id"); return 2; }
      return show(await call("DELETE", `/api/v1/stations/shares/${id}`), () => `Deleted ${id} and its copy.`);
    }
    case "trust": {
      const { readConfig, writeConfig } = await import("./library.ts");
      const proxies = new Set(readConfig().trustedProxies ?? []);
      if (argv.includes("--remove")) proxies.delete(id ?? ""); else if (id) proxies.add(id);
      writeConfig({ trustedProxies: [...proxies] });
      console.log(proxies.size ? `X-Forwarded-For believed from: ${[...proxies].join(", ")}` : "No proxy is trusted.");
      return 0;
    }
    default:
      console.error(`nixamp station shares: no command "${sub}".\n\n${USAGE}`);
      return 2;
  }
}
