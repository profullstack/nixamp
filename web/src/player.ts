/**
 * Playback in the browser: a media element for the sound, a Web Audio analyser
 * tapped off it for the picture. One graph, one decode — the same reason the
 * terminal app does not run a second decoder for its visualiser.
 */
import { isVideoFile, titleFromFilename } from "./format.ts";

import { attachSource, detectKind, type AttachedSource } from "@profullstack/player";

export interface LocalTrack {
  title: string;
  artist: string;
  album: string;
  duration: number;
  /** Object URL for a picked file, or an http URL on a nixamp server. */
  url: string;
  video: boolean;
  /** Set for picked files, so the URL can be revoked when the list is replaced. */
  objectUrl: boolean;
  /**
   * What the bytes are, when the URL cannot say.
   *
   * A picked file is a blob URL with no name and no extension on it, so
   * `detectKind` can only answer "unknown" -- and a raw transport stream
   * handed to a <video> as if it were an MP4 plays as nothing at all. The
   * file's own name is the answer, read once when the list is built.
   */
  kind?: "mp4" | "hls" | "mpegts" | "audio";
}

const AUDIO_EXTENSIONS = new Set([
  "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac",
  "wav", "wma", "aiff", "aif", "alac", "mp4", "webm", "mkv", "mov", "m4v", "ogv",
  // Transport streams, which a browser cannot open by itself but mpegts.js
  // can: a 1080p or 4K recording dragged into the page plays here rather than
  // being filtered out of the list as if it were not media at all.
  "ts", "m2ts", "mts", "m2t", "trp", "tp",
]);

/** The extensions that mean a transport stream, which needs its own engine. */
const TRANSPORT_EXTENSIONS = new Set(["ts", "m2ts", "mts", "m2t", "trp", "tp"]);

/** Whether a picked file is a transport stream, by its name: a blob URL has none. */
export function isTransportFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && TRANSPORT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function isPlayable(name: string, type = ""): boolean {
  if (type.startsWith("audio/") || type.startsWith("video/")) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Filenames in the order a person expects: "10" after "9", not after "1". */
export function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * A playlist from picked files. Tags are not read — an ID3 parser is a lot of
 * code to show what the filename already says — so the name is the title, and
 * the duration arrives from the media element once it has looked.
 */
export function tracksFromFiles(files: File[]): LocalTrack[] {
  return files
    .filter((file) => isPlayable(file.name, file.type))
    .sort((a, b) => byName(pathOf(a), pathOf(b)))
    .map((file) => ({
      title: titleFromFilename(file.name),
      artist: "",
      album: folderOf(pathOf(file)),
      duration: 0,
      url: URL.createObjectURL(file),
      video: isVideoFile(file.name, file.type),
      objectUrl: true,
      // Taken off the name now, because the blob URL about to be made of it
      // carries no name at all.
      ...(isTransportFile(file.name) ? { kind: "mpegts" as const } : {}),
    }));
}

function pathOf(file: File): string {
  // Set when a whole directory was picked.
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function folderOf(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? (parts[parts.length - 2] as string) : "";
}

export function revoke(tracks: LocalTrack[]): void {
  for (const track of tracks) if (track.objectUrl) URL.revokeObjectURL(track.url);
}

export interface PlayerElements {
  audio: HTMLAudioElement;
  video: HTMLVideoElement;
}

export interface PlayerHandlers {
  onTime: (position: number, duration: number) => void;
  onEnded: () => void;
  onState: (playing: boolean) => void;
  onError: (message: string) => void;
  /**
   * Whether the element is waiting on bytes it does not have yet.
   *
   * True from the moment a source starts loading, and again whenever playback
   * stalls for want of data; false once it is playing, or has stopped trying.
   * A catalog entry can take half a minute to start -- the server probes the
   * source and spins up a decoder first -- and for all of that the page said
   * STOPPED, which reads as broken. This is what lets it say LOADING instead.
   */
  onBusy?: (busy: boolean) => void;
}

/** How many analyser bins we ask for. 2048 samples, as in the terminal app. */
export const FFT_SIZE = 2048;

/** Audio, or something with a picture. */
/**
 * Whether a track has to go into the <video> element rather than the <audio>.
 *
 * Decided by what the track IS, not by what its URL looks like. A nixamp
 * serves media as `/api/media/12`, with no extension on the end, so
 * `detectKind` can only answer "unknown" -- and treating unknown as "not
 * audio" put every remote song into a <video> that is hidden whenever the
 * track has no picture. Chrome will play audio out of a display:none video
 * element; iOS Safari will not, which is why a phone connected to a server sat
 * there silent with the bars moving.
 *
 * The server says which of its tracks have a picture and a picked file knows
 * its own type, so the flag is the answer. Only the streaming kinds override
 * it: hls and mpegts want the video element whatever they turn out to carry.
 */
export function needsVideoElement(video: boolean, kind: string): boolean {
  return video || kind === "hls" || kind === "mpegts";
}

export class BrowserPlayer {
  /** The engine currently feeding the element, if any. */
  private attached: AttachedSource | null = null;
  /** The address of what is loaded, for handing to another player. */
  source = "";

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly wired = new WeakSet<HTMLMediaElement>();
  private active: HTMLMediaElement;
  private frequencies = new Uint8Array(0);

  constructor(
    private readonly elements: PlayerElements,
    private readonly handlers: PlayerHandlers,
  ) {
    this.active = elements.audio;
    for (const element of [elements.audio, elements.video]) {
      // The analyser only sees cross-origin media that says we may look.
      element.crossOrigin = "anonymous";
      element.addEventListener("timeupdate", () => {
        if (element === this.active) {
          this.handlers.onTime(element.currentTime, Number.isFinite(element.duration) ? element.duration : 0);
        }
      });
      element.addEventListener("loadedmetadata", () => {
        if (element === this.active) {
          this.handlers.onTime(element.currentTime, Number.isFinite(element.duration) ? element.duration : 0);
        }
      });
      element.addEventListener("ended", () => {
        if (element === this.active) this.handlers.onEnded();
      });
      element.addEventListener("play", () => {
        if (element === this.active) this.handlers.onState(true);
      });
      element.addEventListener("pause", () => {
        if (element === this.active) this.handlers.onState(false);
      });
      element.addEventListener("error", () => {
        if (element === this.active) this.handlers.onError(mediaError(element));
      });
      const busy = (is: boolean) => () => {
        if (element === this.active) this.handlers.onBusy?.(is);
      };
      for (const name of ["loadstart", "waiting", "stalled", "seeking"]) element.addEventListener(name, busy(true));
      for (const name of ["playing", "canplay", "pause", "ended", "error", "emptied", "seeked", "abort"]) {
        element.addEventListener(name, busy(false));
      }
    }
  }

  get playing(): boolean {
    return !this.active.paused && !this.active.ended;
  }

  get position(): number {
    return this.active.currentTime;
  }

  get duration(): number {
    return Number.isFinite(this.active.duration) ? this.active.duration : 0;
  }

  get showingVideo(): boolean {
    return this.active === this.elements.video;
  }

  /**
   * The audio graph is built on the first play, not at load: a browser will
   * not start an AudioContext until a person has clicked something.
   */
  private ensureGraph(element: HTMLMediaElement): void {
    type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = globalThis.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
    if (!Ctor) return;
    this.context ??= new Ctor();
    if (!this.analyser) {
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.connect(this.context.destination);
      this.frequencies = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (!this.wired.has(element)) {
      try {
        // One MediaElementSource per element, ever: a second throws.
        this.context.createMediaElementSource(element).connect(this.analyser);
        this.wired.add(element);
      } catch {
        // Already wired by a previous instance; the sound still plays.
        this.wired.add(element);
      }
    }
    void this.context.resume();
  }

  /** Frequency bins, 0..255, or an empty array before the graph exists. */
  read(): Uint8Array {
    if (!this.analyser) return this.frequencies;
    this.analyser.getByteFrequencyData(this.frequencies);
    return this.frequencies;
  }

  /** Peak levels. The analyser is mono here, so both meters share it. */
  levels(): [number, number] {
    if (!this.analyser) return [0, 0];
    const data = this.read();
    let sum = 0;
    for (const value of data) sum += value;
    const mean = data.length === 0 ? 0 : sum / data.length / 255;
    return [Math.min(1, mean * 2.2), Math.min(1, mean * 2.2)];
  }

  /**
   * Point an element at a track.
   *
   * The bytes are handed to @profullstack/player rather than assigned to
   * `.src`, which is the difference between playing an MP4 and playing every
   * source the fleet serves: it picks the engine, so an HLS playlist or a
   * transport stream works here without this file knowing what either is. Its
   * control bar is not used -- nixamp has one -- only the delivery half.
   *
   * The attach is awaited before play, because it is asynchronous and calling
   * play in the same commit fails permanently rather than loudly.
   */
  async load(track: LocalTrack, autoplay: boolean): Promise<void> {
    // A picked file is a blob in this tab, which is no address at all.
    this.source = track.objectUrl ? "" : track.url;
    // A picked file is a blob URL with nothing to read a kind from, so the
    // flag the file itself carried decides; a remote track has a real URL and
    // the package can tell.
    // What it is, said by whoever knew: the list, for a picked file whose
    // name has already been read; the address, for anything with one.
    const kind = track.kind ?? (track.objectUrl ? (track.video ? "mp4" : "audio") : detectKind({ src: track.url }));
    const wanted = needsVideoElement(track.video, kind) ? this.elements.video : this.elements.audio;
    if (wanted !== this.active) {
      this.active.pause();
      this.active.removeAttribute("src");
      this.active.load();
      this.active = wanted;
    }

    this.attached?.destroy();
    this.attached = null;
    try {
      this.attached = await attachSource(this.active, {
        src: track.url,
        kind,
        // A film the browser has no decoder for is the ordinary case in a
        // library of downloads, and silence is the worst way to say so.
        unplayableAdvice: "VLC or mpv will play it; nixamp can only hand it to your browser.",
        onError: (message) => this.handlers.onError(message),
        onNotice: (message) => {
          if (message) this.handlers.onError(message);
        },
      });
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error.message : "that would not play");
      return;
    }
    if (autoplay) await this.play();
  }

  async play(): Promise<void> {
    this.ensureGraph(this.active);
    try {
      await this.active.play();
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error.message : "playback was refused");
    }
  }

  pause(): void {
    this.active.pause();
  }

  stop(): void {
    this.active.pause();
    this.active.currentTime = 0;
    this.source = "";
    // The engine goes with it: an HLS or transport stream left attached keeps
    // pulling segments long after somebody has stopped listening.
    this.attached?.destroy();
    this.attached = null;
  }

  seek(seconds: number): void {
    if (Number.isFinite(seconds)) this.active.currentTime = Math.max(0, seconds);
  }

  set volume(value: number) {
    this.elements.audio.volume = value;
    this.elements.video.volume = value;
  }

  get volume(): number {
    return this.active.volume;
  }
}

function mediaError(element: HTMLMediaElement): string {
  switch (element.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED: return "playback was aborted";
    case MediaError.MEDIA_ERR_NETWORK: return "the network dropped mid-track";
    case MediaError.MEDIA_ERR_DECODE: return "this browser could not decode that";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return "this browser cannot play that format";
    default: return "playback failed";
  }
}
