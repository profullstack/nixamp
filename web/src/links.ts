/**
 * A pasted link, played here.
 *
 * The server used to fetch every link, through yt-dlp, and play it back as
 * a channel of its own. That is the right thing for putting a link on the
 * air for everybody, and the wrong thing for one person wanting to watch
 * it: YouTube refuses a datacenter address outright for many videos ("Sign
 * in to confirm you're not a bot"), the server spends a core decoding for
 * an audience of one, and anyone holding a listen link could make it do so.
 *
 * So a link plays in this browser when it can. YouTube, Vimeo and
 * SoundCloud have players made to be embedded, and the browser is the
 * viewer's own, which those sites will serve. A link straight to a file
 * plays in the page's own player. The server is asked only to make a link
 * public, which is administering it.
 */

export type LocalPlayback =
  | { kind: "embed"; site: "youtube" | "vimeo" | "soundcloud"; src: string; label: string }
  | { kind: "direct"; url: string; video: boolean; label: string }
  /** A list of files by address, which this page reads and plays through. */
  | { kind: "list"; url: string; label: string };

const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?.*)?$/i;
const VIDEO = /\.(mp4|m4v|webm|mov|mkv)(\?.*)?$/i;
/** A playlist of segments, which only Safari plays without help. */
const HLS = /\.m3u8(\?.*)?$/i;
/** A list of files, one after another: an .m3u or a .pls by address. */
const LIST = /\.(m3u|pls)(\?.*)?$/i;

/** Whether a file's address is a picture, by its ending. */
export function isVideoFile(url: string): boolean {
  try {
    const parsed = new URL(url);
    return VIDEO.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

/**
 * What to call a list that does not name itself: its file, or, when the
 * file is only called "playlist", the folder it sits in -- a show's page
 * hands out /podcast/off-protocol/playlist.m3u, and "off protocol" is the
 * name in that.
 */
export function listNameOf(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean).map((one) => {
      try {
        return decodeURIComponent(one);
      } catch {
        return one;
      }
    });
    const file = (parts.pop() ?? "").replace(/\.(m3u|pls)$/i, "");
    const named = /^(playlist|index|list|all|episodes|feed)?$/i.test(file) ? (parts.pop() ?? "") : file;
    return named.replace(/[-_]+/g, " ").trim() || parsed.hostname;
  } catch {
    return "Playlist";
  }
}

export interface ListEntry {
  url: string;
  title: string;
}

/** A list is read whole, and a very long one is enough of one. */
export const LIST_MAX_ENTRIES = 1000;

/**
 * A list's text, read for what this page can play: every entry that is a
 * file by its ending, in order, with the name it was given. Relative
 * entries are taken against the list's own address. An IPTV feed with no
 * ending is left out, since only a server can carry that; Go live is for
 * those. The title is the list's own #PLAYLIST line, else its address.
 */
export function parseList(text: string, base: string): { title: string; entries: ListEntry[] } {
  const named = /^#PLAYLIST:\s*(.+)$/im.exec(text)?.[1]?.replace(/[\u0000-\u001F]/g, " ").trim() ?? "";
  const title = named || listNameOf(base);
  const entries: ListEntry[] = [];
  const add = (raw: string, given: string): void => {
    if (entries.length >= LIST_MAX_ENTRIES) return;
    let url: URL;
    try {
      url = new URL(raw.trim(), base);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    const path = url.pathname + url.search;
    if (!AUDIO.test(path) && !VIDEO.test(path)) return;
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? url.hostname);
    entries.push({ url: url.toString(), title: given || name });
  };
  let pls = false;
  try {
    pls = /\.pls$/i.test(new URL(base).pathname);
  } catch {
    pls = false;
  }
  if (pls) {
    const files = new Map<string, string>();
    const titles = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const match = /^(File|Title)(\d+)\s*=\s*(.*)$/i.exec(line.trim());
      if (!match) continue;
      (/^file$/i.test(match[1] ?? "") ? files : titles).set(match[2] ?? "", match[3] ?? "");
    }
    for (const [index, file] of [...files.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      add(file, (titles.get(index) ?? "").trim());
    }
    return { title, entries };
  }
  let given = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const info = /^#EXTINF:\s*-?[\d.]+\s*(?:,(.*))?$/i.exec(line);
      if (info) given = (info[1] ?? "").trim();
      continue;
    }
    add(line, given);
    given = "";
  }
  return { title, entries };
}

/** YouTube's eleven characters, from the addresses people actually paste. */
export function youtubeId(url: URL): string {
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  const id = (value: string | null): string => (value && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : "");
  if (host === "youtu.be") return id(url.pathname.slice(1).split("/")[0] ?? null);
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return "";
  if (url.pathname === "/watch") return id(url.searchParams.get("v"));
  const match = /^\/(?:shorts|live|embed|v)\/([^/?]+)/.exec(url.pathname);
  return match ? id(match[1] ?? null) : "";
}

/**
 * How to play a link here, or null when only a server could.
 *
 * `hlsNatively` says whether this browser plays an HLS playlist on its own;
 * one that does not is handed nothing for an .m3u8, and the server, which
 * repackages it, is the answer.
 */
export function localPlayback(entered: string, hlsNatively = false): LocalPlayback | null {
  let url: URL;
  try {
    url = new URL(entered.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const yt = youtubeId(url);
  if (yt) {
    // The privacy-enhanced host: no cookies until the viewer presses play.
    const at = url.searchParams.get("t");
    const start = at && /^\d+$/.test(at) ? `&start=${at}` : "";
    return {
      kind: "embed", site: "youtube",
      src: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&playsinline=1&rel=0${start}`,
      label: `YouTube · ${yt}`,
    };
  }

  const host = url.hostname.replace(/^www\.|^player\./, "");
  const vimeo = host === "vimeo.com" ? /^\/(?:video\/)?(\d+)/.exec(url.pathname)?.[1] : undefined;
  if (vimeo) {
    return { kind: "embed", site: "vimeo", src: `https://player.vimeo.com/video/${vimeo}?autoplay=1&playsinline=1`, label: `Vimeo · ${vimeo}` };
  }

  if (host === "soundcloud.com" && url.pathname.split("/").filter(Boolean).length >= 2) {
    return {
      kind: "embed", site: "soundcloud",
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.toString())}&auto_play=true&visual=false`,
      label: `SoundCloud · ${url.pathname.split("/").filter(Boolean).slice(0, 2).join(" / ")}`,
    };
  }

  const path = url.pathname + url.search;
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? url.hostname);
  if (LIST.test(path)) return { kind: "list", url: url.toString(), label: listNameOf(url.toString()) };
  if (AUDIO.test(path)) return { kind: "direct", url: url.toString(), video: false, label: name };
  if (VIDEO.test(path)) return { kind: "direct", url: url.toString(), video: true, label: name };
  if (HLS.test(path) && hlsNatively) return { kind: "direct", url: url.toString(), video: true, label: name };
  return null;
}
