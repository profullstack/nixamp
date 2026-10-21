/**
 * What is playing, for everything outside the page: the lock screen, media
 * keys, a Bluetooth head unit, CarPlay and Android Auto. They all read the
 * browser's MediaSession and nothing else, so a page that leaves it empty
 * shows up in the car as its address and a bare progress bar.
 *
 * Artwork is offered at every size the platforms ask for (the same picture
 * each time: they pick by size and skip what they cannot match), with its
 * real type, and always as a full address, since a car fetches it itself.
 */

export interface NowPlaying {
  title: string;
  artist?: string;
  album?: string;
  /** The cover, any address the page can load; "" or absent for the mark. */
  art?: string;
}

const SIZES = ["96x96", "128x128", "192x192", "256x256", "384x384", "512x512"];
const MARK = "/icons/icon-512.png";

const has = (): boolean => typeof navigator !== "undefined" && "mediaSession" in navigator && typeof MediaMetadata !== "undefined";

const typeOf = (src: string): string | undefined => {
  const ext = /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.exec(src)?.[1]?.toLowerCase();
  return ext === "jpg" ? "image/jpeg" : ext ? `image/${ext}` : undefined;
};

/** The artwork list for one picture. */
export function artwork(src: string): MediaImage[] {
  const href = new URL(src || MARK, location.href).href;
  const type = typeOf(href);
  return SIZES.map((sizes) => (type ? { src: href, sizes, type } : { src: href, sizes }));
}

let shown = "";

/** Name what is playing; the same thing twice is one write, so it is safe on every tick. */
export function setNowPlaying(now: NowPlaying): void {
  if (!has()) return;
  const art = now.art || "";
  const key = JSON.stringify([now.title, now.artist ?? "", now.album ?? "", art]);
  if (key === shown) return;
  shown = key;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: now.title || "nixamp",
    artist: now.artist || "",
    album: now.album || "",
    artwork: artwork(art),
  });
}

let at = "";

/**
 * Where in the song the listener is. A live station's stream never ends, so
 * the platform's own bar is meaningless; this puts the song's on it. Called
 * with no duration it clears, which shows "live" rather than a wrong bar.
 */
export function setNowPosition(duration: number, position: number, playbackRate = 1): void {
  if (!has() || typeof navigator.mediaSession.setPositionState !== "function") return;
  try {
    if (!(duration > 0) || !Number.isFinite(duration)) {
      if (at !== "") { at = ""; navigator.mediaSession.setPositionState(); }
      return;
    }
    const where = Math.min(duration, Math.max(0, position));
    // A second's drift is not worth telling the car about.
    const key = `${duration.toFixed(0)}:${Math.round(where)}`;
    if (key === at) return;
    at = key;
    navigator.mediaSession.setPositionState({ duration, position: where, playbackRate });
  } catch {
    // An odd duration or an old browser: the platform keeps its own bar.
  }
}

/** Playing or paused, for the play button on the dashboard. */
export function setNowState(state: MediaSessionPlaybackState): void {
  if (!has()) return;
  navigator.mediaSession.playbackState = state;
}

/** The buttons the car and the lock screen show; an action left out is not offered. */
export function setNowActions(handlers: Partial<Record<MediaSessionAction, (() => void) | null>>): void {
  if (!has()) return;
  for (const [action, handler] of Object.entries(handlers) as Array<[MediaSessionAction, (() => void) | null]>) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // This browser does not know that action.
    }
  }
}
