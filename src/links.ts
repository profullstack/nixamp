/**
 * Any link, played.
 *
 * Paste a YouTube page, a podcast episode, a SoundCloud track, a TikTok live,
 * and the server works out where the media actually is and plays it to you
 * the way it plays a catalog entry: as a channel of its own, started for
 * whoever asked and stopped a minute after the last viewer leaves. The
 * working-out is yt-dlp's, which knows a thousand sites and is updated
 * weekly; this module only asks it the right question and reads the answer.
 *
 * Two questions, in fact. "Where is it" is `yt-dlp -j`, one JSON object with
 * the chosen format's direct URL, its title, and whether it is live. "Give it
 * to me" is `yt-dlp -o -`, the whole file down a pipe, which is what the
 * Download button hands to the browser -- the server fetches, the person's
 * own machine keeps it.
 *
 * Some sites want a signed-in cookie before they will say anything (YouTube
 * from a datacenter, Vimeo). A Netscape cookies file at
 * ~/.local/state/nixamp/cookies.txt is passed through when it exists, and
 * the error is otherwise repeated to the person, who can decide.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseCatalog } from "./catalogs.ts";

export interface ResolvedLink {
  /** What to call it: the page's title, or the file's name for a bare file. */
  title: string;
  /** Where the bytes are: what ffmpeg is pointed at. */
  media: string;
  /**
   * The sound, when it comes separately. YouTube stopped offering a single
   * stream with both picture and sound in it: every format is video alone
   * or audio alone, and a player that insists on one file gets "Requested
   * format is not available" for every link. So the two are asked for as a
   * pair, and ffmpeg reads both and puts them together. "" when `media`
   * already has the sound in it.
   */
  audio: string;
  /** Whether it is on now, which decides pacing and whether it can be saved. */
  live: boolean;
  /** Seconds, when known. */
  duration: number;
  /** Whether there is a picture. Unknown reads as yes; ffprobe settles it. */
  video: boolean;
  /** Headers the site expects on the media request, if any. */
  headers: Record<string, string>;
  /** Which site, as yt-dlp names it -- "soundcloud", "youtube", "generic". */
  extractor: string;
  /** The file type yt-dlp would save, for naming a download. */
  ext: string;
  /** The page it came from. */
  page: string;
  /**
   * For a pasted .m3u: every entry in it, in order. The channel plays them
   * one after another and starts over at the end, a station rather than a
   * file; `media` is the first, for the probe that decides what it holds.
   */
  playlist?: string[];
}

/**
 * Formats that are a file, not a page.
 *
 * A link straight to an MP3 or an HLS playlist needs no resolving -- ffmpeg
 * reads it as it is, and asking yt-dlp about it only adds a second and a
 * "generic" extractor's guess.
 */
const DIRECT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpg|mpeg|m2ts|3gp|ts|m3u8|mpd)(\?.*)?$/i;

export function isDirectMedia(url: string): boolean {
  if (/^rtmps?:\/\//i.test(url)) return true;
  try {
    const parsed = new URL(url);
    return DIRECT.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

/**
 * A plain m3u: a list of things to play, one per line, which is not a thing
 * ffmpeg reads. The .m3u8 of HLS is a list of segments of one thing, which
 * it does, and stays in DIRECT above.
 */
const PLAYLIST = /\.m3u(\?.*)?$/i;

export function isPlaylistLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return PLAYLIST.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

/** How much of a playlist is worth reading: a list, not a library dump. */
export const PLAYLIST_MAX_BYTES = 2_000_000;
export const PLAYLIST_MAX_ENTRIES = 1000;
export const PLAYLIST_FETCH_TIMEOUT_MS = 15_000;

/**
 * What a playlist's text holds: the entries, in order, resolved against
 * where the list was fetched from. Some things called .m3u are HLS after
 * all -- a segment list with #EXT-X- tags -- and those are one stream for
 * ffmpeg to read as it is, not a list of streams.
 */
export function playlistFrom(text: string, base: string): { hls: boolean; sources: string[] } {
  if (/^#EXT-X-/m.test(text)) return { hls: true, sources: [] };
  const sources = parseCatalog(text, base)
    .map((entry) => entry.source)
    .filter((source) => /^(https?|rtmps?):\/\//i.test(source))
    .slice(0, PLAYLIST_MAX_ENTRIES);
  return { hls: false, sources };
}

/**
 * A pasted .m3u, read and turned into a channel's worth of entries. Fetched
 * here rather than by yt-dlp, which would take the first entry and stop, or
 * by ffmpeg, which does not read a plain list at all.
 */
export async function resolvePlaylist(
  url: string,
  options: { timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<ResolvedLink | { error: string }> {
  const get = options.fetcher ?? fetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? PLAYLIST_FETCH_TIMEOUT_MS);
  let text = "";
  try {
    const answer = await get(url, { signal: abort.signal, headers: { "user-agent": "nixamp" }, redirect: "follow" });
    if (!answer.ok) return { error: `that playlist could not be fetched (HTTP ${answer.status})` };
    text = (await answer.text()).slice(0, PLAYLIST_MAX_BYTES);
  } catch (error) {
    const why = abort.signal.aborted ? "took too long to answer" : ((error as Error).message || "could not be fetched");
    return { error: `that playlist ${why}` };
  } finally {
    clearTimeout(timer);
  }
  const list = playlistFrom(text, url);
  if (list.hls) return directLink(url);
  const [first] = list.sources;
  if (!first) return { error: "that playlist has nothing in it this can play" };
  return {
    title: fileNameOf(url).replace(/\.m3u$/i, "") || "Playlist",
    media: first,
    audio: "",
    // A station: joined where it is, never seeked, and with no end to save.
    live: true,
    duration: 0,
    // Whether there is a picture is the first entry's to say; ffprobe settles it.
    video: true,
    headers: {},
    extractor: "playlist",
    ext: "",
    page: url,
    playlist: list.sources,
  };
}

/** A link somebody pasted, or "" when it is not one this can play. */
export function playableLink(entered: unknown): string {
  if (typeof entered !== "string") return "";
  const trimmed = entered.trim();
  if (!/^(https?|rtmps?):\/\//i.test(trimmed)) return "";
  try {
    new URL(trimmed);
  } catch {
    return "";
  }
  return trimmed.slice(0, 2048);
}

/** A channel id for a link: stable, so two people pasting the same link share one decoder. */
export function linkChannelId(url: string): string {
  return `url-${createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
}

/**
 * One format with both a picture and sound where the site offers one;
 * failing that, the best picture and the best sound as a pair, which ffmpeg
 * reads as two inputs and puts together; failing that, the best there is.
 *
 * The pair prefers an H.264 picture (avc1) with M4A sound, because those are
 * copied into the stream untouched -- YouTube's "best" MP4 is AV1 now, and
 * an AV1 or VP9 picture would be re-encoded, a core per channel. And no
 * taller than 1080: a seedbox is not a render farm, and nobody is watching
 * 4K in a browser tab.
 */
const PAIR = "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba";
const PLAY_FORMAT = `b[vcodec!=none][acodec!=none]/${PAIR}/b`;
const SAVE_VIDEO_FORMAT = `b[vcodec!=none][acodec!=none][protocol^=http]/b[vcodec!=none][acodec!=none]/${PAIR}/bv*+ba/b`;
const SAVE_AUDIO_FORMAT = "ba[protocol^=http]/ba/b";

/** The format a download would pick, so it can be named before it is fetched. */
export function saveFormat(audioOnly: boolean): string {
  return audioOnly ? SAVE_AUDIO_FORMAT : SAVE_VIDEO_FORMAT;
}

/** How yt-dlp is asked where a link's media is, for playing or for the format a download would take. */
export function resolveArgs(url: string, cookies = "", format = PLAY_FORMAT): string[] {
  return [
    "-j",
    "--no-playlist",
    "--no-warnings",
    "-f", format,
    ...(cookies ? ["--cookies", cookies] : []),
    "--",
    url,
  ];
}

/** How yt-dlp is asked to hand over the whole thing, down a pipe. */
export function downloadArgs(url: string, audioOnly: boolean, cookies = ""): string[] {
  return [
    "-o", "-",
    "--no-playlist",
    "--no-warnings",
    "--no-part",
    // A playlist of fragments is written to the pipe fragment by fragment by
    // the native downloader; ffmpeg's would want a seekable file.
    "--hls-prefer-native",
    "-f", audioOnly ? SAVE_AUDIO_FORMAT : SAVE_VIDEO_FORMAT,
    ...(cookies ? ["--cookies", cookies] : []),
    "--",
    url,
  ];
}

/** Headers as yt-dlp lists them, kept only where the name and value are the plain kind. */
function headersFrom(headersIn: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (headersIn && typeof headersIn === "object") {
    for (const [name, value] of Object.entries(headersIn as Record<string, unknown>)) {
      if (typeof value === "string" && /^[A-Za-z0-9-]+$/.test(name) && !/[\r\n]/.test(value)) headers[name] = value;
    }
  }
  return headers;
}

/** yt-dlp's answer, read into what the player needs. Null when it is not an answer. */
export function parseResolved(json: unknown, page: string): ResolvedLink | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  let media = typeof record["url"] === "string" ? record["url"] : "";
  let audio = "";
  let headers = headersFrom(record["http_headers"]);
  let vcodec = typeof record["vcodec"] === "string" ? record["vcodec"] : "";
  // A pair, when the site keeps picture and sound apart: yt-dlp lists what
  // it would have merged under requested_formats and gives no url of its
  // own. The picture is the one with a video codec; the sound is the other.
  const parts = Array.isArray(record["requested_formats"]) ? (record["requested_formats"] as unknown[]) : [];
  if (media === "" && parts.length > 0) {
    const records = parts.filter((one): one is Record<string, unknown> => Boolean(one) && typeof one === "object");
    const withUrl = records.filter((one) => typeof one["url"] === "string" && one["url"] !== "");
    const picture = withUrl.find((one) => typeof one["vcodec"] === "string" && one["vcodec"] !== "none");
    const sound = withUrl.find((one) => one !== picture && typeof one["acodec"] === "string" && one["acodec"] !== "none");
    const first = picture ?? withUrl[0];
    if (first) {
      media = first["url"] as string;
      headers = headersFrom(first["http_headers"]);
      vcodec = picture ? (picture["vcodec"] as string) : "none";
      if (picture && sound) audio = sound["url"] as string;
    }
  }
  if (media === "") return null;
  // A link that was the media all along -- an IPTV feed at /channel/906,
  // with no extension to say so -- is answered by yt-dlp's generic
  // extractor with wherever the feed redirected to, which for a panel is a
  // second host and a token minted for that one request. ffmpeg follows a
  // redirect itself, so the link is kept as pasted and every redial gets a
  // fresh token instead of a 403 an hour in.
  if (record["direct"] === true && parts.length === 0 && /^https?:\/\//i.test(page)) media = page;
  const title = typeof record["title"] === "string" && record["title"].trim() !== ""
    ? record["title"].trim().slice(0, 200)
    : fileNameOf(page);
  return {
    title,
    media,
    audio,
    live: record["is_live"] === true,
    duration: typeof record["duration"] === "number" && Number.isFinite(record["duration"]) ? record["duration"] : 0,
    video: vcodec !== "none",
    headers,
    extractor: typeof record["extractor"] === "string" ? record["extractor"] : "",
    ext: typeof record["ext"] === "string" && /^[a-z0-9]{1,5}$/i.test(record["ext"]) ? record["ext"].toLowerCase() : "",
    page,
  };
}

/** A bare file link, described without asking anybody. */
export function directLink(url: string): ResolvedLink {
  return {
    title: fileNameOf(url),
    media: url,
    audio: "",
    // A playlist of segments is live until proven otherwise; a file is not.
    live: /\.(m3u8|mpd)(\?.*)?$/i.test(url) || /^rtmps?:/i.test(url),
    duration: 0,
    video: !/\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?.*)?$/i.test(url),
    headers: {},
    extractor: "direct",
    ext: (url.match(/\.([a-z0-9]{2,5})(\?.*)?$/i)?.[1] ?? "").toLowerCase(),
    page: url,
  };
}

function fileNameOf(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    return last || new URL(url).hostname;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * ffmpeg's input options for a site that wants headers on the media request.
 *
 * yt-dlp's answer came with the headers it would have sent; ffmpeg has to
 * send the same ones or the CDN answers 403 to a request that worked a
 * second ago. The user agent has its own flag; the rest go as one block.
 */
export function inputArgsFor(headers: Record<string, string>): string[] {
  const args: string[] = [];
  const rest: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "user-agent") args.push("-user_agent", value);
    else if (name.toLowerCase() === "accept-encoding") continue;
    else rest.push(`${name}: ${value}`);
  }
  if (rest.length > 0) args.push("-headers", `${rest.join("\r\n")}\r\n`);
  return args;
}

/**
 * How ffmpeg is asked to hand over a picture and a sound as one file, down a
 * pipe. yt-dlp merges the two only into a file it can seek in, so a pair
 * cannot go down its pipe; ffmpeg copies both into a fragmented MP4 -- or
 * Matroska when the picture is not MP4, since a VP9 picture in an MP4 is a
 * file few things open -- and writes as it goes.
 */
export function mergeDownloadArgs(link: ResolvedLink): string[] {
  const input = inputArgsFor(link.headers);
  const mp4 = link.ext === "mp4";
  return [
    "-hide_banner", "-loglevel", "error",
    ...input, "-i", link.media,
    ...input, "-i", link.audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c", "copy",
    ...(mp4 ? ["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"] : ["-f", "matroska"]),
    "pipe:1",
  ];
}

/** A file name for a download: the title, made safe, with the right ending. */
export function fileNameFor(link: ResolvedLink, audioOnly: boolean): string {
  const base = link.title.replace(/[\\/:*?"<>| -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "download";
  // The ending is the format's, and for sound alone it has to be a sound
  // format: a film's "mp4" on an audio-only fetch would name an AAC stream
  // as a video. Unknown reads as m4a, which is what most sites hand over.
  const soundExts = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "webm"];
  const ext = audioOnly
    ? (soundExts.includes(link.ext) ? link.ext : "m4a")
    // A pair is put together by ffmpeg, as MP4 when the picture is one and
    // Matroska otherwise; the name has to say which.
    : (link.audio ? (link.ext === "mp4" ? "mp4" : "mkv") : (link.ext || "mp4"));
  return `${base}.${ext}`;
}

/** What a browser should call the bytes, from the file name's ending. */
export function contentTypeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg",
    flac: "audio/flac", wav: "audio/wav", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
    mkv: "video/x-matroska", mov: "video/quicktime", ts: "video/mp2t",
  };
  return types[ext] ?? "application/octet-stream";
}

/** The one line of yt-dlp's complaint worth repeating to a person. */
export function reasonFrom(stderr: string): string {
  const line = stderr.split("\n").map((one) => one.trim()).filter((one) => one.startsWith("ERROR:")).pop();
  if (!line) return "that link could not be read";
  return line.replace(/^ERROR:\s*/, "").replace(/\s*See\s+https:\/\/github\.com\/yt-dlp.*$/i, "").trim().slice(0, 300);
}

/** How long resolving may take before it is a link that is not going to answer. */
export const RESOLVE_TIMEOUT_MS = 60_000;

/**
 * Where a link's media is, by asking yt-dlp. A bare file is answered without
 * asking. An error is a sentence for the person who pasted it.
 */
export async function resolveLink(
  ytdlp: string[] | null,
  url: string,
  options: { cookies?: string; timeoutMs?: number; format?: string } = {},
): Promise<ResolvedLink | { error: string }> {
  if (isDirectMedia(url)) return directLink(url);
  if (isPlaylistLink(url)) return resolvePlaylist(url, { timeoutMs: options.timeoutMs });
  // Without yt-dlp, a link is taken as the media it may well be: an IPTV
  // feed has no extension and no page behind it, and ffprobe -- asked next,
  // before anything goes on the air -- tells a stream from a web page in a
  // second. A page it cannot read is refused there, by name.
  if (!ytdlp || ytdlp.length === 0) return directLink(url);
  const [command, ...prefix] = ytdlp as [string, ...string[]];
  return new Promise((done) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (answer: ResolvedLink | { error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(answer);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...prefix, ...resolveArgs(url, options.cookies ?? "", options.format ?? PLAY_FORMAT)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ error: `yt-dlp could not be started: ${(error as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ error: "that link took too long to read" });
    }, options.timeoutMs ?? RESOLVE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 4_000_000) out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 200_000) err += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ error: `yt-dlp could not be started: ${error.message}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ error: reasonFrom(err) });
        return;
      }
      // One object per line; the first is the one asked for.
      const line = out.split("\n").find((one) => one.trim().startsWith("{")) ?? "";
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const link = parseResolved(parsed, url);
      finish(link ?? { error: "yt-dlp did not say where the media is" });
    });
  });
}
