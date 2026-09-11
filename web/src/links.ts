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
  | { kind: "direct"; url: string; video: boolean; label: string };

const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?.*)?$/i;
const VIDEO = /\.(mp4|m4v|webm|mov|mkv)(\?.*)?$/i;
/** A playlist of segments, which only Safari plays without help. */
const HLS = /\.m3u8(\?.*)?$/i;

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
  if (AUDIO.test(path)) return { kind: "direct", url: url.toString(), video: false, label: name };
  if (VIDEO.test(path)) return { kind: "direct", url: url.toString(), video: true, label: name };
  if (HLS.test(path) && hlsNatively) return { kind: "direct", url: url.toString(), video: true, label: name };
  return null;
}
