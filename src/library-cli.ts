/**
 * `nixamp library <command>`: the index, from a terminal or a script.
 *
 * `nixamp library ~/Music` still sets the folder a daemon serves (library.ts);
 * these are the questions you ask once it is running. Same conventions as
 * `nixamp station`: the daemon on this machine unless --url/--key, --json for
 * scripts, exit 0 done, 1 refused, 2 usage, 3 unreachable.
 */
import { resolveTarget } from "./admin.ts";
import { KEY_HEADER } from "./share.ts";

import { LIBRARY_COMMANDS, LIBRARY_USAGE } from "./library-usage.ts";
import { readSession } from "./session.ts";

export { LIBRARY_COMMANDS, LIBRARY_USAGE };

/** The public guide a published file goes on, unless --guide or --here says otherwise. */
export const STREAMING_GUIDE = "https://live.streaming.pit.world";

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * The ready files `publish` means: item ids as they are, a folder on this
 * machine as everything under it, anything else as search words. A message
 * when nothing matches.
 */
export async function publishPicks(targets: string[], call: Call): Promise<Record<string, unknown>[] | string> {
  const ready = (items: Record<string, unknown>[]): Record<string, unknown>[] => items.filter((one) => one["state"] === "ready");
  if (targets.every((one) => /^[0-9a-f]{16}$/.test(one))) {
    const items = await Promise.all(targets.map(async (id) => (await call("GET", `/api/v1/library/items/${id}`)).body["item"] as Record<string, unknown> | undefined));
    const found = ready(items.filter((one): one is Record<string, unknown> => Boolean(one)));
    return found.length === targets.length ? found : "not every item is in the library and ready (nixamp library show ITEM)";
  }
  const { existsSync, statSync } = await import("node:fs");
  const { resolve, relative, isAbsolute } = await import("node:path");
  const { homedir } = await import("node:os");
  const path = resolve(targets.join(" ").replace(/^~(?=$|\/)/, homedir()));
  const query = new URLSearchParams({ limit: "500", sort: "path" });
  if (existsSync(path) && statSync(path).isDirectory()) {
    const sources = ((await call("GET", "/api/v1/library/sources")).body["sources"] as Record<string, unknown>[] | undefined) ?? [];
    const source = sources.find((one) => { const rel = relative(String(one["root"] ?? ""), path); return !rel.startsWith("..") && !isAbsolute(rel); });
    if (!source) return `${path} is not inside the library (nixamp library sources)`;
    query.set("source", String(source["id"]));
    const folder = relative(String(source["root"]), path);
    if (folder) query.set("folder", folder);
  } else query.set("q", targets.join(" "));
  const found = ready(((await call("GET", `/api/v1/library/items?${query}`)).body["items"] as Record<string, unknown>[] | undefined) ?? []);
  return found.length ? found : "nothing ready in the library matches that (nixamp library search WORDS)";
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** Words that are not flags or flag values. */
function words(argv: string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const one = argv[at]!;
    if (one.startsWith("--")) {
      if (!["--json", "--force", "--wait", "--dry-run", "--here"].includes(one)) at += 1;
      continue;
    }
    out.push(one);
  }
  return out;
}

export async function libraryTool(argv: string[]): Promise<number> {
  const [command] = argv;
  const json = argv.includes("--json");
  let target;
  try {
    target = resolveTarget(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 3;
  }
  const headers: Record<string, string> = { "content-type": "application/json", ...(target.key ? { [KEY_HEADER]: target.key } : {}) };
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    let response: Response;
    try {
      response = await fetch(`${target.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw Object.assign(new Error(`could not reach ${target.url}: ${(error as Error).message}`), { unreachable: true });
    }
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body: parsed };
  };
  const out = (answer: { status: number; body: Record<string, unknown> }, line: (body: Record<string, unknown>) => string): number => {
    if (json) console.log(JSON.stringify(answer.body, null, 2));
    else if (answer.status < 400) console.log(line(answer.body));
    if (answer.status >= 400) {
      if (!json) console.error(`nixamp: ${String(answer.body["error"] ?? "refused")} (${String(answer.body["code"] ?? answer.status)})`);
      return 1;
    }
    return 0;
  };
  const scanLine = (scan: Record<string, unknown> | null | undefined): string =>
    scan ? `${String(scan["status"])}: ${String(scan["found"])} found, ${String(scan["unchanged"])} unchanged, ${String(scan["probed"])} read, ${String(scan["failed"])} failed, ${String(scan["missing"])} gone` : "never scanned";
  const itemLine = (item: Record<string, unknown>): string =>
    `${String(item["id"])}  ${String(item["artist"] || "?")} — ${String(item["title"])}${item["album"] ? `  (${String(item["album"])})` : ""}${item["state"] !== "ready" ? `  [${String(item["state"])}]` : ""}`;
  const rest = words(argv.slice(1));

  try {
    switch (command) {
      case "status":
        return out(await call("GET", "/api/v1/library"), (body) => {
          const counts = body["counts"] as Record<string, number>;
          const sources = (body["sources"] as Record<string, unknown>[]) ?? [];
          return [
            `${String(body["items"])} items: ${Object.entries(counts).filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`).join(", ") || "none"}`,
            ...sources.map((one) => `  ${String(one["id"])}  ${String(one["root"] ?? "")}${one["enabled"] ? "" : " (off)"}\n    last scan ${scanLine(one["lastScan"] as Record<string, unknown> | null)}`),
          ].join("\n");
        });
      case "sources":
        return out(await call("GET", "/api/v1/library/sources"), (body) =>
          ((body["sources"] as Record<string, unknown>[]) ?? []).map((one) => `${String(one["id"])}  ${String(one["root"] ?? "")}${one["enabled"] ? "" : " (off)"}`).join("\n") || "No sources.");
      case "add": {
        const [path] = rest;
        if (!path) { console.error("nixamp library add needs a folder"); return 2; }
        const { resolve } = await import("node:path");
        const { homedir } = await import("node:os");
        return out(await call("POST", "/api/v1/library/sources", { root: resolve(path.replace(/^~(?=$|\/)/, homedir())) }), (body) =>
          `Indexing ${String((body["source"] as Record<string, unknown>)["root"])} as ${String((body["source"] as Record<string, unknown>)["id"])}.`);
      }
      case "scan": {
        let [source] = rest;
        if (!source) {
          const listed = await call("GET", "/api/v1/library/sources");
          const all = (listed.body["sources"] as Record<string, unknown>[]) ?? [];
          if (all.length !== 1) { console.error("Which source? `nixamp library sources` lists them."); return 2; }
          source = String(all[0]!["id"]);
        }
        const started = await call("POST", `/api/v1/library/sources/${source}/scan`, { force: argv.includes("--force") });
        if (started.status >= 400 || !argv.includes("--wait")) return out(started, (body) => `Scanning: job ${String((body["job"] as Record<string, unknown>)["jobId"])}.`);
        const jobId = String((started.body["job"] as Record<string, unknown>)["jobId"]);
        for (;;) {
          const polled = await call("GET", `/api/v1/library/jobs/${jobId}`);
          const job = polled.body["job"] as Record<string, unknown> | undefined;
          if (polled.status >= 400 || !job || job["status"] !== "running") return out(polled, () => scanLine(job));
          await new Promise((next) => setTimeout(next, 1000));
        }
      }
      case "search": {
        const query = new URLSearchParams({ q: rest.join(" "), limit: flag(argv, "--limit") ?? "20", sort: "artist" });
        for (const name of ["artist", "album", "genre", "state", "folder"]) {
          const value = flag(argv, `--${name}`);
          if (value) query.set(name, value);
        }
        return out(await call("GET", `/api/v1/library/items?${query}`), (body) => {
          const items = (body["items"] as Record<string, unknown>[]) ?? [];
          return items.length ? `${items.map(itemLine).join("\n")}\n${String(body["total"])} in all` : "Nothing matches.";
        });
      }
      case "show": {
        const [item] = rest;
        if (!item) { console.error("nixamp library show needs an item id"); return 2; }
        return out(await call("GET", `/api/v1/library/items/${item}`), (body) => JSON.stringify(body["item"], null, 2));
      }
      case "fix": {
        const [item] = rest;
        if (!item) { console.error("nixamp library fix needs an item id"); return 2; }
        const patch: Record<string, unknown> = {};
        for (const name of ["title", "artist", "album", "albumArtist", "genre"]) {
          const value = flag(argv, `--${name}`);
          if (value !== undefined) patch[name] = value;
        }
        for (const name of ["track", "disc", "year"]) {
          const value = flag(argv, `--${name}`);
          if (value !== undefined) patch[name] = Number(value);
        }
        if (Object.keys(patch).length === 0) { console.error("nixamp library fix needs at least one of --title --artist --album --genre --track --disc --year"); return 2; }
        return out(await call("PATCH", `/api/v1/library/items/${item}`, patch), (body) => itemLine(body["item"] as Record<string, unknown>));
      }
      case "remove": {
        const [source] = rest;
        if (!source) { console.error("nixamp library remove needs a source id"); return 2; }
        return out(await call("DELETE", `/api/v1/library/sources/${source}`), (body) => `Forgot ${String(body["forgotten"])} items. No file was touched.`);
      }
      case "playlists":
        return out(await call("GET", "/api/v1/library/playlists"), (body) =>
          ((body["playlists"] as Record<string, unknown>[]) ?? []).map((one) => `${String(one["id"])}  ${String(one["name"])} (${String(one["count"])})`).join("\n") || "No playlists yet.");
      case "playlist": {
        const [verb, first, ...others] = rest;
        const showList = (body: Record<string, unknown>): string => {
          const list = body["playlist"] as Record<string, unknown>;
          const items = (list["items"] as Record<string, unknown>[] | undefined) ?? [];
          return [`${String(list["id"])}  ${String(list["name"])} (revision ${String(list["revision"])})`, ...items.map((one, at) => `  ${at + 1}. ${itemLine(one)}`)].join("\n");
        };
        if (verb === "new" && first) return out(await call("POST", "/api/v1/library/playlists", { name: first, items: others }), showList);
        if (verb === "show" && first) return out(await call("GET", `/api/v1/library/playlists/${first}`), showList);
        if (verb === "add" && first && others.length) return out(await call("POST", `/api/v1/library/playlists/${first}/items`, { items: others }), showList);
        if (verb === "delete" && first) return out(await call("DELETE", `/api/v1/library/playlists/${first}`), () => `Deleted playlist ${first}.`);
        console.error("nixamp library playlist new NAME [ITEM...] | show ID | add ID ITEM... | delete ID");
        return 2;
      }
      case "publish": {
        // On demand on live.streaming (guide-vods.ts). ITEM, a folder or search
        // words pick the files; each goes to the guide as its public play
        // address, under this machine's nixamp.com session, so a file on any
        // server lands on the one guide. --here publishes on this server's own.
        const basis = flag(argv, "--basis");
        if (!rest.length || !basis) { console.error("nixamp library publish needs ITEM, a folder or search words, and --basis owned|permission|licensed|creative-commons|public-domain"); return 2; }
        const items = await publishPicks(rest, call);
        if (typeof items === "string") { console.error(`nixamp: ${items}`); return 1; }
        const title = items.length === 1 ? flag(argv, "--title") ?? "" : "";
        const note = flag(argv, "--note") ?? "";
        // Sold as a download on nixamp.com (the guide's owner only, owned or public domain); 0 stops selling it.
        const priceFlag = flag(argv, "--price");
        const price = priceFlag === undefined ? {} : { price: Number(priceFlag.replace(/^\$/, "")) };
        if ("price" in price && !Number.isFinite(price.price)) { console.error("nixamp: --price is in dollars, like 1 or 2.50"); return 2; }
        if (argv.includes("--dry-run")) {
          console.log(`${items.map(itemLine).join("\n")}\n${items.length} to publish (--dry-run: nothing sent)`);
          return 0;
        }
        const here = argv.includes("--here");
        const guide = (flag(argv, "--guide") ?? STREAMING_GUIDE).replace(/\/+$/, "");
        const session = here ? null : readSession();
        if (!here && !session?.token) { console.error("nixamp: publishing on live.streaming needs a nixamp.com account on this machine: run nixamp login (or pass --here)"); return 1; }
        let failed = 0;
        const done: Record<string, unknown>[] = [];
        for (const item of items) {
          const id = String(item["id"]);
          let answer: { status: number; body: Record<string, unknown> };
          if (here) answer = await call("POST", "/api/v1/guide/vods", { item: id, basis, agree: true, title, note, ...price });
          else {
            const play = String((((await call("GET", `/api/v1/library/items/${id}`)).body["item"] ?? {}) as Record<string, unknown>)["playAddress"] ?? "");
            if (!play) answer = { status: 409, body: { error: "this server has no public address and listen key to play it from (set one with --public-url)", code: "no_address" } };
            else {
              try {
                const response = await fetch(`${guide}/api/v1/guide/vods`, {
                  method: "POST",
                  headers: { "content-type": "application/json", authorization: `Bearer ${session!.token}` },
                  body: JSON.stringify({ play, basis, agree: true, title, note, ...price }),
                });
                answer = { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
              } catch (error) {
                answer = { status: 503, body: { error: `could not reach ${guide}: ${(error as Error).message}`, code: "unreachable" } };
              }
            }
          }
          done.push({ item: id, status: answer.status, ...answer.body });
          if (answer.status >= 400) {
            failed += 1;
            if (!json) console.error(`nixamp: ${itemLine(item)}: ${String(answer.body["error"] ?? "refused")} (${String(answer.body["code"] ?? answer.status)})`);
          } else if (!json) console.log(`on demand: ${String(answer.body["page"])}  ${String(item["title"] || item["rel"] || id)}`);
        }
        if (json) console.log(JSON.stringify({ published: done }, null, 2));
        return failed ? 1 : 0;
      }
      case "vods":
        return out(await call("GET", "/api/v1/guide/vods"), (body) => {
          const vods = (body["vods"] as Record<string, unknown>[]) ?? [];
          return vods.length === 0 ? "nothing published on demand" : vods.map((one) => `${String(one["id"])}  ${String(one["name"])}  ${String(one["page"])}${one["state"] === "offline" ? "  [not answering]" : ""}`).join("\n");
        });
      case "unpublish": {
        const [vod] = rest;
        if (!vod) { console.error("nixamp library unpublish needs a video id (see nixamp library vods)"); return 2; }
        return out(await call("DELETE", `/api/v1/guide/vods/${vod}`), (body) => `removed ${String(body["removed"])}`);
      }
      default:
        console.log(LIBRARY_USAGE);
        return 2;
    }
  } catch (error) {
    if ((error as { unreachable?: boolean }).unreachable) {
      console.error(`nixamp: ${(error as Error).message}`);
      return 3;
    }
    throw error;
  }
}
