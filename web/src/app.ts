/**
 * nixamp on the web: the same player, drawn in a browser.
 *
 * Two sources, one set of controls. Local files play here, decoded by the
 * browser and measured by a Web Audio analyser. A `nixamp serve` elsewhere is
 * driven over its control API, and its library can be streamed back to play
 * here as well — the phone becomes the remote, or the speaker, or both.
 */
import { displayName, formatTime } from "./format.ts";
import {
  BrowserPlayer, revoke, tracksFromFiles,
  type LocalTrack,
} from "./player.ts";
import {
  RemoteClient, fetchSnapshot, normalizeBase, probeServer,
  type Status,
} from "./remote.ts";
import { bandEdges, bands, decay, drawSpectrum, holdPeaks } from "./spectrum.ts";
import { emptySnapshot, type Snapshot } from "../../src/protocol.ts";

export const BAND_COUNT = 24;
const REMOTE_KEY = "nixamp.remote";
const VOLUME_KEY = "nixamp.volume";

type Mode = "local" | "remote";

function need<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`nixamp: #${id} is missing from the shell`);
  return element as unknown as T;
}

export function start(): void {
  const dom = {
    status: need<HTMLElement>("status"),
    source: need<HTMLElement>("source"),
    install: need<HTMLButtonElement>("install"),
    video: need<HTMLVideoElement>("video"),
    audio: need<HTMLAudioElement>("audio"),
    title: need<HTMLElement>("title-line"),
    album: need<HTMLElement>("album-line"),
    elapsed: need<HTMLElement>("elapsed"),
    total: need<HTMLElement>("total"),
    seek: need<HTMLInputElement>("seek"),
    canvas: need<HTMLCanvasElement>("spectrum"),
    glyphs: need<HTMLElement>("glyphs"),
    levels: need<HTMLElement>("levels"),
    playlist: need<HTMLOListElement>("playlist"),
    playlistTitle: need<HTMLElement>("playlist-panel"),
    note: need<HTMLElement>("note"),
    files: need<HTMLInputElement>("files"),
    folder: need<HTMLInputElement>("folder"),
    remoteUrl: need<HTMLInputElement>("remote-url"),
    remoteForm: need<HTMLFormElement>("remote-form"),
    remoteState: need<HTMLElement>("remote-state"),
    disconnect: need<HTMLButtonElement>("disconnect"),
    browse: need<HTMLButtonElement>("browse"),
    directory: need<HTMLDivElement>("directory"),
    directoryNote: need<HTMLParagraphElement>("directory-note"),
    directoryList: need<HTMLUListElement>("directory-list"),
    listenHere: need<HTMLInputElement>("listen-here"),
    volume: need<HTMLInputElement>("volume"),
    prev: need<HTMLButtonElement>("prev"),
    playPause: need<HTMLButtonElement>("play-pause"),
    stop: need<HTMLButtonElement>("stop"),
    next: need<HTMLButtonElement>("next"),
  };

  let mode: Mode = "local";
  let local: LocalTrack[] = [];
  let index = 0;
  let snapshot: Snapshot = emptySnapshot();
  let remoteStatus: Status = "idle";
  let remoteDetail = "";
  let note = "Pick files, or connect to a nixamp running somewhere else.";
  let scrubbing = false;

  let bars: number[] = new Array<number>(BAND_COUNT).fill(0);
  let peaks: number[] = new Array<number>(BAND_COUNT).fill(0);
  let edges: number[] = [];

  /**
   * Who is making the sound. Connected to a remote, the server plays and we
   * only draw it — unless "Listen on this device" is ticked, and then the
   * server is a library rather than a player and everything happens here.
   */
  const remoteDrives = (): boolean => mode === "remote" && !dom.listenHere.checked;

  const player = new BrowserPlayer({ audio: dom.audio, video: dom.video }, {
    onTime: (_at, of) => {
      // A picked file has no duration until the browser has looked at it.
      const track = local[index];
      if (mode === "local" && track && of > 0 && track.duration !== of) track.duration = of;
      draw();
    },
    onEnded: () => step(1),
    onState: () => draw(),
    onError: (message) => { note = message; draw(); },
  });

  const remote = new RemoteClient({
    onSnapshot: (next) => {
      snapshot = next;
      if (remoteDrives()) {
        // The server is the one making the sound; mirror its analyser.
        bars = next.bars.length > 0 ? next.bars : bars;
        peaks = holdPeaks(peaks, bars);
      }
      draw();
    },
    onStatus: (status, detail) => {
      remoteStatus = status;
      remoteDetail = detail ?? "";
      draw();
    },
  });

  // ---- playlist, whichever source is in charge -----------------------------

  const count = (): number => (mode === "remote" ? snapshot.tracks.length : local.length);
  const at = (): number => (mode === "remote" ? snapshot.index : index);

  const currentName = (): string => {
    if (mode === "remote") {
      const track = snapshot.tracks[snapshot.index];
      return track ? displayName(track) : "Nothing loaded.";
    }
    const track = local[index];
    return track ? displayName(track) : "Nothing loaded.";
  };

  const currentAlbum = (): string => {
    const track = mode === "remote" ? snapshot.tracks[snapshot.index] : local[index];
    return track?.album || "—";
  };

  const duration = (): number => {
    if (remoteDrives()) return snapshot.tracks[snapshot.index]?.duration ?? 0;
    return player.duration;
  };

  const position = (): number =>
    remoteDrives() ? snapshot.position : player.position;

  const playing = (): boolean =>
    remoteDrives() ? snapshot.playing : player.playing;

  // ---- commands -----------------------------------------------------------

  async function playAt(next: number): Promise<void> {
    if (mode === "remote") {
      if (remoteDrives()) {
        await remote.send({ type: "play", index: next });
        return;
      }
      // Select rather than play: the server's cursor stays in step with ours
      // without it starting the same track on its own speakers.
      await remote.send({ type: "select", index: next });
      await listenTo(next);
      return;
    }
    const track = local[next];
    if (!track) return;
    index = next;
    await player.load(track, true);
    showVideo(track.video);
    updateMediaSession();
    draw();
  }

  async function listenTo(next: number): Promise<void> {
    const track = snapshot.tracks[next];
    if (!track) return;
    await player.load({
      title: track.title, artist: track.artist, album: track.album,
      duration: track.duration, url: remote.media(next), video: false, objectUrl: false,
    }, true);
    updateMediaSession();
  }

  async function toggle(): Promise<void> {
    if (remoteDrives()) {
      await remote.send({ type: "toggle" });
      return;
    }
    if (count() === 0) return;
    if (player.playing) player.pause();
    else if (player.position > 0) await player.play();
    else await playAt(at());
    draw();
  }

  async function step(delta: number): Promise<void> {
    const total = count();
    if (total === 0) return;
    if (remoteDrives()) {
      await remote.send({ type: delta > 0 ? "next" : "prev" });
      return;
    }
    // `at()` is already the current index for whichever source is in charge,
    // so the step is worked out once here rather than again from a cursor the
    // server has meanwhile moved.
    await playAt((at() + delta + total) % total);
  }

  async function halt(): Promise<void> {
    if (remoteDrives()) {
      await remote.send({ type: "stop" });
      return;
    }
    player.stop();
    bars = new Array<number>(BAND_COUNT).fill(0);
    peaks = [...bars];
    draw();
  }

  // ---- drawing ------------------------------------------------------------

  const RAMP = "▁▂▃▄▅▆▇█";
  const glyph = (value: number): string =>
    RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.round(value * (RAMP.length - 1))))] as string;

  function draw(): void {
    const total = count();
    const live = playing();
    dom.status.textContent = live ? "▶ PLAYING" : "■ STOPPED";
    dom.status.dataset.playing = String(live);
    dom.title.textContent = currentName();
    dom.album.textContent = currentAlbum();

    const at2 = position();
    const of = duration();
    dom.elapsed.textContent = formatTime(at2);
    dom.total.textContent = of > 0 ? formatTime(of) : "--:--";
    if (!scrubbing) {
      dom.seek.value = String(of > 0 ? Math.round((at2 / of) * 1000) : 0);
      dom.seek.disabled = of <= 0 || remoteDrives();
    }

    dom.playPause.textContent = live ? "❚❚" : "▶";
    dom.playPause.setAttribute("aria-label", live ? "Pause" : "Play");
    dom.playlistTitle.dataset.title = `Playlist (${total})`;
    dom.source.textContent = mode === "remote"
      ? `remote · ${remote.address.replace(/^https?:\/\//, "") || "—"}`
      : local.length > 0 ? `local · ${local.length} files` : "no source";

    dom.remoteState.textContent = mode === "remote"
      ? `${remoteStatus}${remoteDetail ? ` — ${remoteDetail}` : ""}`
      : "not connected";
    dom.remoteState.dataset.status = mode === "remote" ? remoteStatus : "idle";
    dom.disconnect.hidden = mode !== "remote";

    const message = mode === "remote" && snapshot.note !== "" ? snapshot.note : note;
    dom.note.textContent = message;
    dom.note.hidden = message === "";

    renderPlaylist();
    dom.glyphs.textContent = bars.map(glyph).join("");
    const [l, r] = remoteDrives() ? snapshot.levels : player.levels();
    dom.levels.textContent =
      `L${"▮".repeat(Math.round(l * 6)).padEnd(6, "·")} R${"▮".repeat(Math.round(r * 6)).padEnd(6, "·")}`;
  }

  let renderedFor = "";
  function renderPlaylist(): void {
    const names = mode === "remote"
      ? snapshot.tracks.map((t) => [displayName(t), t.duration] as const)
      : local.map((t) => [displayName(t), t.duration] as const);
    // Durations are part of the key: a picked file learns its own length late.
    const key = `${mode}:${names.map(([n, d]) => `${n}@${d}`).join("|")}`;
    if (key !== renderedFor) {
      renderedFor = key;
      dom.playlist.replaceChildren(...names.map(([name, seconds], i) => {
        const item = document.createElement("li");
        item.className = "row";
        item.dataset.index = String(i);
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = String(i + 1).padStart(2, " ");
        const label = document.createElement("span");
        label.className = "name";
        label.textContent = name;
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = seconds > 0 ? formatTime(seconds) : "--:--";
        item.append(n, label, time);
        return item;
      }));
    }
    const active = at();
    const live = playing();
    Array.from(dom.playlist.children).forEach((child, i) => {
      const row = child as HTMLElement;
      row.classList.toggle("selected", i === active);
      row.classList.toggle("playing", i === active && live);
    });
    const selected = dom.playlist.children[active] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }

  function frame(): void {
    const canvas = dom.canvas;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");

    if (!remoteDrives()) {
      const data = player.read();
      if (data.length > 0) {
        if (edges.length !== BAND_COUNT + 1) edges = bandEdges(BAND_COUNT, data.length);
        bars = decay(bars, bands(data, edges));
        peaks = holdPeaks(peaks, bars);
      }
    } else {
      peaks = holdPeaks(peaks, bars);
    }

    if (context) {
      const style = getComputedStyle(document.documentElement);
      drawSpectrum(context, { width: canvas.width, height: canvas.height }, bars, peaks, {
        bar: style.getPropertyValue("--green").trim() || "#4af689",
        peak: style.getPropertyValue("--green-dim").trim() || "#227a4a",
        background: "transparent",
      });
    }
    if (playing()) {
      dom.glyphs.textContent = bars.map(glyph).join("");
      const [l, r] = remoteDrives() ? snapshot.levels : player.levels();
      dom.levels.textContent =
        `L${"▮".repeat(Math.round(l * 6)).padEnd(6, "·")} R${"▮".repeat(Math.round(r * 6)).padEnd(6, "·")}`;
      dom.elapsed.textContent = formatTime(position());
      const of = duration();
      if (!scrubbing && of > 0) dom.seek.value = String(Math.round((position() / of) * 1000));
    }
    requestAnimationFrame(frame);
  }

  function showVideo(on: boolean): void {
    dom.video.hidden = !on;
  }

  function updateMediaSession(): void {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentName(),
      album: currentAlbum(),
      artist: "nixamp",
      artwork: [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.setActionHandler("play", () => void toggle());
    navigator.mediaSession.setActionHandler("pause", () => void toggle());
    navigator.mediaSession.setActionHandler("nexttrack", () => void step(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => void step(-1));
  }

  // ---- wiring -------------------------------------------------------------

  dom.playlist.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("li");
    const chosen = Number(row?.dataset.index);
    if (Number.isInteger(chosen)) void playAt(chosen);
  });

  dom.prev.addEventListener("click", () => void step(-1));
  dom.next.addEventListener("click", () => void step(1));
  dom.stop.addEventListener("click", () => void halt());
  dom.playPause.addEventListener("click", () => void toggle());

  dom.seek.addEventListener("input", () => { scrubbing = true; });
  dom.seek.addEventListener("change", () => {
    const of = duration();
    if (of > 0) player.seek((Number(dom.seek.value) / 1000) * of);
    scrubbing = false;
  });

  dom.volume.addEventListener("input", () => {
    const value = Number(dom.volume.value) / 100;
    player.volume = value;
    try { localStorage.setItem(VOLUME_KEY, String(value)); } catch { /* private mode */ }
  });

  const pick = (input: HTMLInputElement): void => {
    input.addEventListener("change", () => {
      const chosen = tracksFromFiles(Array.from(input.files ?? []));
      if (chosen.length === 0) {
        note = "Nothing playable in that selection.";
        draw();
        return;
      }
      revoke(local);
      local = chosen;
      index = 0;
      mode = "local";
      remote.close();
      note = "";
      void playAt(0);
    });
  };
  pick(dom.files);
  pick(dom.folder);

  dom.remoteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const base = normalizeBase(dom.remoteUrl.value);
    if (base === "") {
      note = "That is not an address.";
      draw();
      return;
    }
    void (async () => {
      remoteStatus = "connecting";
      draw();
      const version = await probeServer(base);
      if (version === null) {
        remoteStatus = "error";
        remoteDetail = "no nixamp answered there";
        mode = "local";
        draw();
        return;
      }
      mode = "remote";
      note = "";
      try { localStorage.setItem(REMOTE_KEY, base); } catch { /* private mode */ }
      remote.connect(base);
      draw();
    })();
  });

  /**
   * The public directory. It is served by whoever is hosting this page, so a
   * nixamp on your laptop serving its own copy of the PWA asks its own
   * /api/directory and finds nothing, which is the honest answer: it does not
   * host one.
   */
  const loadDirectory = async (): Promise<void> => {
    dom.directory.hidden = false;
    dom.directoryNote.textContent = "Looking for live streams…";
    dom.directoryList.replaceChildren();

    let streams: { id: string; name: string; url: string; tracks: number; nowPlaying: string }[];
    try {
      const response = await fetch("/api/directory");
      if (!response.ok) throw new Error(String(response.status));
      streams = ((await response.json()) as { streams?: typeof streams }).streams ?? [];
    } catch {
      dom.directoryNote.textContent = "The directory is not answering. Type an address instead.";
      return;
    }

    if (streams.length === 0) {
      dom.directoryNote.textContent = "Nobody is streaming right now.";
      return;
    }

    dom.directoryNote.textContent = `${streams.length} live ${streams.length === 1 ? "stream" : "streams"}:`;
    for (const stream of streams) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";

      // textContent, never innerHTML: these names are written by strangers.
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = stream.name;
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = stream.nowPlaying
        ? `${stream.nowPlaying} · ${stream.tracks} tracks`
        : `${stream.tracks} tracks`;

      button.append(name, detail);
      button.addEventListener("click", () => {
        dom.remoteUrl.value = stream.url;
        dom.directory.hidden = true;
        dom.remoteForm.requestSubmit();
      });
      item.append(button);
      dom.directoryList.append(item);
    }
  };

  // /directory is the shareable address for the list. The server serves the
  // app shell for any unknown path, so the routing is this one line.
  if (location.pathname.replace(/\/+$/, "") === "/directory") void loadDirectory();

  dom.browse.addEventListener("click", () => {
    if (!dom.directory.hidden) {
      dom.directory.hidden = true;
      return;
    }
    void loadDirectory();
  });

  dom.disconnect.addEventListener("click", () => {
    remote.close();
    mode = "local";
    remoteStatus = "idle";
    remoteDetail = "";
    draw();
  });

  dom.listenHere.addEventListener("change", () => {
    if (mode !== "remote") return;
    void (async () => {
      if (dom.listenHere.checked) {
        // "on this device" means instead of over there, not as well as.
        await remote.send({ type: "stop" });
        await listenTo(snapshot.index);
      } else {
        player.stop();
      }
      draw();
    })();
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    switch (event.key) {
      case " ": event.preventDefault(); void toggle(); return;
      case "s": void halt(); return;
      case "n": case "ArrowRight": void step(1); return;
      case "p": case "ArrowLeft": void step(-1); return;
      case "ArrowDown": event.preventDefault(); void playAt(Math.min(count() - 1, at() + 1)); return;
      case "ArrowUp": event.preventDefault(); void playAt(Math.max(0, at() - 1)); return;
    }
  });

  // The install prompt only fires when the browser judges us installable, so
  // the button appears only when pressing it will do something.
  interface InstallEvent extends Event { prompt(): Promise<void> }
  let deferred: InstallEvent | null = null;
  globalThis.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallEvent;
    dom.install.hidden = false;
  });
  dom.install.addEventListener("click", () => {
    void deferred?.prompt();
    deferred = null;
    dom.install.hidden = true;
  });

  try {
    const savedVolume = localStorage.getItem(VOLUME_KEY);
    if (savedVolume !== null) {
      dom.volume.value = String(Math.round(Number(savedVolume) * 100));
      player.volume = Number(savedVolume);
    }
    const saved = localStorage.getItem(REMOTE_KEY);
    if (saved) dom.remoteUrl.value = saved;
  } catch { /* private mode */ }

  // Served by a nixamp of its own? Then it has a library to show — but only
  // if there is one. The hosted copy at nixamp.com serves the same files with
  // nothing behind them, and taking that over as a "remote" would be a lie.
  void (async () => {
    if (dom.remoteUrl.value !== "") return;
    const here = globalThis.location.origin;
    if (await probeServer(here) === null) return;
    const snapshot = await fetchSnapshot(here);
    if (!snapshot || snapshot.tracks.length === 0) return;
    dom.remoteUrl.value = here;
    mode = "remote";
    // The hint about picking files has been answered by the server itself.
    note = "";
    remote.connect(here);
    draw();
  })();

  draw();
  requestAnimationFrame(frame);
}
