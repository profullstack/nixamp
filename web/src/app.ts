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
  blockedAsMixedContent,
  RemoteClient, fetchSnapshot, needsAName, probeServer, refusesUs, splitShareLink,
  rungName, stepDown,
  type Status,
} from "./remote.ts";
import { bandEdges, bands, decay, drawSpectrum, holdPeaks } from "./spectrum.ts";
import { emptySnapshot, type FullSnapshot, merge, type Snapshot } from "../../src/protocol.ts";

export const BAND_COUNT = 24;
const REMOTE_KEY = "nixamp.remote";
const VOLUME_KEY = "nixamp.volume";
/**
 * Whether a connected server plays here or plays over there.
 *
 * On by default, which it was not: connecting a phone to your own server used
 * to make sound come out of the server's speakers and nothing at all out of
 * the phone, so picking your server from the directory looked like a player
 * that was simply broken. Playing here is what a person means by opening a
 * player; driving the machine in the other room is the specialised thing, and
 * it is one tick away.
 */
const LISTEN_HERE_KEY = "nixamp.listenHere";
/**
 * Whether this page has already made its noise.
 *
 * Per page rather than per tab. It was per tab, which meant refreshing the
 * page was silent -- and refreshing is exactly how somebody checks whether the
 * thing they asked for works. A load is a load.
 *
 * Still guarded, because a refused autoplay arms a listener for the first
 * click and that must not fire twice on the same page.
 */
let jingled = false;

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
    fullscreen: need<HTMLButtonElement>("fullscreen"),
    canvas: need<HTMLCanvasElement>("spectrum"),
    glyphs: need<HTMLElement>("glyphs"),
    levels: need<HTMLElement>("levels"),
    playlist: need<HTMLOListElement>("playlist"),
    crumbs: need<HTMLElement>("crumbs"),
    filter: need<HTMLInputElement>("filter"),
    playlistTitle: need<HTMLElement>("playlist-panel"),
    note: need<HTMLElement>("note"),
    files: need<HTMLInputElement>("files"),
    folder: need<HTMLInputElement>("folder"),
    remoteUrl: need<HTMLInputElement>("remote-url"),
    remoteForm: need<HTMLFormElement>("remote-form"),
    remoteState: need<HTMLElement>("remote-state"),
    disconnect: need<HTMLButtonElement>("disconnect"),
    browse: need<HTMLButtonElement>("browse"),
    accountForm: need<HTMLFormElement>("account-form"),
    accountEmail: need<HTMLInputElement>("account-email"),
    accountPassword: need<HTMLInputElement>("account-password"),
    accountSubmit: need<HTMLButtonElement>("account-submit"),
    accountToggle: need<HTMLButtonElement>("account-toggle"),
    accountProviders: need<HTMLDivElement>("account-providers"),
    accountPanel: need<HTMLElement>("account-panel"),
    accountElsewhere: need<HTMLParagraphElement>("account-elsewhere"),
    accountSignOut: need<HTMLButtonElement>("account-signout"),
    accountNote: need<HTMLParagraphElement>("account-note"),
    adminPanel: need<HTMLElement>("admin-panel"),
    adminNote: need<HTMLParagraphElement>("admin-note"),
    adminSaid: need<HTMLParagraphElement>("admin-said"),
    adminConnections: need<HTMLTableElement>("admin-connections"),
    publishPanel: need<HTMLElement>("publish-panel"),
    publishNote: need<HTMLParagraphElement>("publish-note"),
    publishList: need<HTMLUListElement>("publish-list"),
    adminRestream: need<HTMLFormElement>("admin-restream"),
    adminReplace: need<HTMLInputElement>("admin-replace"),
    adminSource: need<HTMLInputElement>("admin-source"),
    adminName: need<HTMLInputElement>("admin-name"),
    adminAdd: need<HTMLButtonElement>("admin-add"),
    homeNote: need<HTMLParagraphElement>("home-note"),
    loadHome: need<HTMLButtonElement>("load-home"),
    directory: need<HTMLElement>("directory"),
    recentNote: need<HTMLParagraphElement>("recent-note"),
    recentList: need<HTMLUListElement>("recent-list"),
    followingNote: need<HTMLParagraphElement>("following-note"),
    followingList: need<HTMLUListElement>("following-list"),
    serversPanel: need<HTMLElement>("servers-panel"),
    serversNote: need<HTMLParagraphElement>("servers-note"),
    serversList: need<HTMLUListElement>("servers-list"),
    favoritesPanel: need<HTMLElement>("favorites-panel"),
    favoritesNote: need<HTMLParagraphElement>("favorites-note"),
    favoritesList: need<HTMLUListElement>("favorites-list"),
    favHere: need<HTMLButtonElement>("fav-here"),
    notifyPanel: need<HTMLElement>("notify-panel"),
    notifyNote: need<HTMLParagraphElement>("notify-note"),
    notifyWeb: need<HTMLInputElement>("notify-web"),
    notifyEmail: need<HTMLInputElement>("notify-email"),
    notifySms: need<HTMLInputElement>("notify-sms"),
    notifyPhone: need<HTMLInputElement>("notify-phone"),
    notifyPhoneForm: need<HTMLFormElement>("notify-phone-form"),
    notifyPhoneNote: need<HTMLParagraphElement>("notify-phone-note"),
    directoryNote: need<HTMLParagraphElement>("directory-note"),
    directoryList: need<HTMLUListElement>("directory-list"),
    onairPanel: need<HTMLElement>("onair-panel"),
    onairNote: need<HTMLParagraphElement>("onair-note"),
    onairList: need<HTMLUListElement>("onair-list"),
    sharePanel: need<HTMLElement>("share-panel"),
    shareNote: need<HTMLParagraphElement>("share-note"),
    shareLink: need<HTMLInputElement>("share-link"),
    shareCopy: need<HTMLButtonElement>("share-copy"),
    sharePhone: need<HTMLParagraphElement>("share-phone"),
    shareSend: need<HTMLFormElement>("share-send"),
    liveControls: need<HTMLDivElement>("live-controls"),
    goLive: need<HTMLButtonElement>("go-live"),
    stopLive: need<HTMLButtonElement>("stop-live"),
    shareTo: need<HTMLInputElement>("share-to"),
    listenOnly: need<HTMLParagraphElement>("listen-only"),
    listenHere: need<HTMLInputElement>("listen-here"),
    volume: need<HTMLInputElement>("volume"),
    prev: need<HTMLButtonElement>("prev"),
    playPause: need<HTMLButtonElement>("play-pause"),
    stop: need<HTMLButtonElement>("stop"),
    next: need<HTMLButtonElement>("next"),
  };

  /** What the tab is called with nothing playing: whatever the shell said. */
  const baseTitle = document.title || "nixamp";
  let mode: Mode = "local";
  /** What the server we are connected to calls itself, once it has said. */
  let serverName = "";
  let local: LocalTrack[] = [];
  let index = 0;
  let snapshot: FullSnapshot = emptySnapshot();
  let remoteStatus: Status = "idle";
  let remoteDetail = "";
  let note = "Pick files, or connect to a nixamp running somewhere else.";
  let scrubbing = false;
  /**
   * How much of the link this stream is allowed to use. 0 is the original.
   *
   * A film at eight megabits over a link that carries under two is not slow,
   * it is unwatchable, and no amount of buffering fixes a stream that arrives
   * more slowly than it plays. Stalls are counted and the answer is to ask the
   * server for less.
   */
  let rung = 0;
  let stalls = 0;
  /**
   * Which track this device is playing off a remote, or -1 for "the server's".
   *
   * Watching something yourself does not move the server's cursor -- that is
   * deliberate, because a viewer picking a film must not change what the room
   * is hearing. But every read of "the current track" went to the server's
   * index anyway, so picking one loaded it and then the next frame put the
   * title, the highlight and the length back on the server's choice. The
   * track ended and `next` stepped from the server's cursor, which is why the
   * same video played however many times you clicked another.
   */
  let watching = -1;
  /**
   * The channel this device is on, if it is on one.
   *
   * Remembered because a channel's stream ends whenever the server dials its
   * source again -- the opening boxes and the clock start over, and a browser
   * cannot follow that mid-picture -- so "ended" on a live channel means
   * "rejoin", never "play the next track in the library".
   */
  let channelOn: { id: string; name: string; video: boolean } | null = null;
  let rejoins = 0;
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A stream somebody was sent, waiting on them to sign in.
   *
   * The whole point of an invite is that the person opening it is not
   * technical: they get a link, they click it, and this page is the player.
   * They still have to be signed in -- a stream can ask to be paid for, and
   * there is nobody to charge without an account -- so the link is remembered
   * across the sign-in rather than lost by it.
   */
  let invited = "";

  let bars: number[] = new Array<number>(BAND_COUNT).fill(0);
  let peaks: number[] = new Array<number>(BAND_COUNT).fill(0);
  let edges: number[] = [];

  /**
   * Who is making the sound. Connected to a remote, the server plays and we
   * only draw it — unless "Play on this device" is ticked, and then the
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
    onEnded: () => {
      if (rejoinChannel()) return;
      void step(1);
    },
    onState: () => draw(),
    onError: (message) => {
      // A live channel that broke is a live channel to come back to.
      if (rejoinChannel()) return;
      note = message;
      draw();
      // A stream that refused to play may be a stream asking to be paid for,
      // and "that would not play" is a useless thing to tell somebody about
      // money. Asked rather than assumed, because most failures are not this.
      void whyItWouldNotPlay();
    },
  });

  const remote = new RemoteClient({
    onSnapshot: (next) => {
      // A frame without a track list has nothing new to say about it, which is
      // every frame but the first: keep what we had rather than emptying the
      // playlist twelve times a second.
      snapshot = merge(snapshot, next);
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
  /**
   * The track the player is on, from whichever cursor is actually in charge.
   *
   * Connected but playing here, that is our own; connected and letting the
   * server play, it is the server's; not connected at all, the local one.
   */
  const at = (): number => {
    if (mode !== "remote") return index;
    if (remoteDrives() || watching < 0) return snapshot.index;
    return Math.min(watching, Math.max(0, snapshot.tracks.length - 1));
  };

  const currentName = (): string => {
    // On a channel, the channel: it is not in the playlist, and naming the
    // server's own track over CNN said the wrong thing was playing.
    if (channelOn) return channelOn.name;
    const track = mode === "remote" ? snapshot.tracks[at()] : local[at()];
    return track ? displayName(track) : "Nothing loaded.";
  };

  const currentAlbum = (): string => {
    if (channelOn) return "live on this server";
    const track = mode === "remote" ? snapshot.tracks[at()] : local[at()];
    return track?.album || "—";
  };

  const duration = (): number => {
    if (remoteDrives()) return snapshot.tracks[at()]?.duration ?? 0;
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
      // Nothing is sent. Watching something yourself is not an instruction to
      // the server, and it used to be one: this sent `select`, which moves the
      // cursor everybody else is listening to. A viewer picking a film to
      // watch privately would change what the room was hearing, and whether
      // that worked depended only on which key they happened to hold.
      //
      // Driving the stream is `remoteDrives()` above, and that is refused to a
      // listen key by the server, which is where the rule belongs.
      await listenTo(next);
      return;
    }
    const track = local[next];
    if (!track) return;
    index = next;
    channelOn = null;
    await player.load(track, true);
    showVideo(track.video);
    updateMediaSession();
    draw();
  }

  /**
   * Ask for a smaller stream after the second stall.
   *
   * One stall is a seek, a hiccup, or a laptop waking from sleep. Two in the
   * same track is the link telling you it cannot carry this, and the only
   * useful reply is to want less of it.
   */
  const onStall = (): void => {
    if (mode !== "remote" || remoteDrives()) return;
    stalls += 1;
    if (stalls < 2) return;
    const next = stepDown(rung);
    if (next === null) return;
    rung = next;
    stalls = 0;
    note = `Buffering, so asking for ${rungName(rung)}.`;
    void listenTo(snapshot.index);
    draw();
  };

  async function listenTo(next: number): Promise<void> {
    const track = snapshot.tracks[next];
    if (!track) return;
    // Ours, not the server's: this is the one place that decides what this
    // device is playing, so it is the one place that records it.
    watching = next;
    channelOn = null;
    await player.load({
      title: track.title, artist: track.artist, album: track.album,
      duration: track.duration, url: remote.media(next, rung),
      // It was false for everything, so a film played its soundtrack over a
      // blank panel. The server says which tracks have a picture.
      video: track.video === true,
      objectUrl: false,
    }, true);
    showVideo(track.video === true);
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
    channelOn = null;
    player.stop();
    bars = new Array<number>(BAND_COUNT).fill(0);
    peaks = [...bars];
    draw();
  }

  // ---- drawing ------------------------------------------------------------

  /**
   * The level meter: six cells a side, a block for a lit one and a dot for a
   * dark one. The element is set in a monospace face with a reserved width,
   * because in a proportional face a dot is narrower than a block and the
   * whole row shifted sideways as the level moved -- a meter that shakes.
   */
  const meter = (l: number, r: number): string =>
    `L${"▮".repeat(Math.round(l * 6)).padEnd(6, "·")} R${"▮".repeat(Math.round(r * 6)).padEnd(6, "·")}`;

  const RAMP = "▁▂▃▄▅▆▇█";
  const glyph = (value: number): string =>
    RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.round(value * (RAMP.length - 1))))] as string;

  function draw(): void {
    const total = count();
    const live = playing();
    dom.status.textContent = live ? "▶ PLAYING" : "■ STOPPED";
    dom.status.dataset.playing = String(live);
    dom.title.textContent = currentName();
    // The tab says what is on, the way a radio does, so a row of tabs reads
    // as "CNN" rather than as five copies of the site's name.
    const tab = live ? `${currentName()} · ${baseTitle}` : baseTitle;
    if (document.title !== tab) document.title = tab;
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
    // Connected, the list is that server's files, and says so; on its own it
    // is a playlist of what was picked.
    dom.playlistTitle.dataset.title = mode === "remote"
      ? `Files on ${serverName || "this server"} (${total.toLocaleString()})`
      : `Playlist (${total})`;
    dom.source.textContent = mode === "remote"
      ? `connected · ${serverName || remote.address.replace(/^https?:\/\//, "") || "—"}`
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
      meter(l, r);
  }

  let renderedFor = "";
  /** The row the list was last scrolled to, so it is only done when it moves. */
  let scrolledTo = -1;
  /**
   * The folder being looked at, "" for the top of the library.
   *
   * A way of looking, not a different playlist: what plays is still a track
   * number the server knows, and next and previous still walk the whole thing.
   * Somebody browsing for something to watch should not thereby have changed
   * what happens when the current track ends.
   */
  let openFolder = "";

  /** The path back out, one clickable step at a time. */
  function drawCrumbs(needed: boolean): void {
    dom.crumbs.hidden = !needed;
    if (!needed) return;
    const parts = openFolder === "" ? [] : openFolder.split("/");
    const step = (label: string, to: string, last: boolean): HTMLElement => {
      if (last) {
        const here = document.createElement("span");
        here.className = "here";
        here.textContent = label;
        return here;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        openFolder = to;
        renderedFor = "";
        renderPlaylist();
      });
      return button;
    };

    const children: HTMLElement[] = [step("All files", "", parts.length === 0)];
    let walked = "";
    parts.forEach((part, i) => {
      walked = walked === "" ? part : `${walked}/${part}`;
      const sep = document.createElement("span");
      sep.textContent = "/";
      children.push(sep, step(part, walked, i === parts.length - 1));
    });
    dom.crumbs.replaceChildren(...children);
  }

  /** A folder in the list: its name, and how much is inside it. */
  function folderRow(name: string, count: number): HTMLElement {
    const item = document.createElement("li");
    item.className = "folder";
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = `${name}/`;
    const amount = document.createElement("span");
    amount.className = "count";
    amount.textContent = `${count} file${count === 1 ? "" : "s"}`;
    item.append(label, amount);
    item.addEventListener("click", () => {
      openFolder = openFolder === "" ? name : `${openFolder}/${name}`;
      renderedFor = "";
      renderPlaylist();
    });
    return item;
  }
  function renderPlaylist(): void {
    // A row is a name, a length, where it sits, and which pile it is in.
    //
    // Where it sits is what turns a library into something you can look
    // through. Five thousand files listed one after another is a list nobody
    // can find anything in, however carefully it is sorted -- so the folders
    // are folders here, and you walk into them.
    const all = mode === "remote"
      ? snapshot.tracks.map((t) => ({
          name: displayName(t), seconds: t.duration, group: t.group ?? "", folder: t.folder ?? "",
          remote: t.remote === true,
        }))
      : local.map((t) => ({
          name: displayName(t), seconds: t.duration, group: "", folder: "", remote: false,
        }));

    // Only what belongs to this server. Anything re-streamed into it is a live
    // stream and lives in the list of live streams -- having the two mixed in
    // one list is what made moving between a channel and an album so
    // confusing, because they are different kinds of thing.
    const wanted = dom.filter.value.trim().toLowerCase();
    const rows = all
      .map((row, index) => ({ ...row, index }))
      .filter((row) => !row.remote)
      .filter((row) => wanted === "" || `${row.folder}/${row.name}`.toLowerCase().includes(wanted));

    // Everything under the folder we are looking at, and the folders directly
    // inside it. A track sitting deeper than here belongs to one of those, not
    // to this list.
    // A filter searches the whole library: looking for a name is not the same
    // as looking in a place, and having to find the folder first would defeat
    // the point of typing the name.
    const inside = (folder: string): boolean =>
      wanted !== "" || openFolder === "" || folder === openFolder || folder.startsWith(`${openFolder}/`);
    const here = (folder: string): boolean => wanted !== "" || folder === openFolder;
    const below = (folder: string): string => {
      const rest = openFolder === "" ? folder : folder.slice(openFolder.length + 1);
      const at = rest.indexOf("/");
      return at === -1 ? rest : rest.slice(0, at);
    };

    const folders = new Map<string, number>();
    for (const row of rows) {
      if (!inside(row.folder) || here(row.folder)) continue;
      const name = below(row.folder);
      if (name !== "") folders.set(name, (folders.get(name) ?? 0) + 1);
    }
    const files = rows.filter((row) => here(row.folder) && inside(row.folder));

    const key = `${mode}:${openFolder}:${wanted}:${[...folders].join(",")}:${files
      .map((r) => `${r.index}@${r.name}@${r.seconds}@${r.group}`)
      .join("|")}`;
    if (key !== renderedFor) {
      renderedFor = key;
      // No crumbs while filtering: what is on screen is not a place.
      drawCrumbs(wanted === "" && ([...folders.keys()].length > 0 || openFolder !== ""));
      const children: HTMLElement[] = [];

      for (const [name, count] of [...folders].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        children.push(folderRow(name, count));
      }

      let heading = "";
      // Only worth a heading over the library itself if something else is
      // here too; on an ordinary server every track is the library and a
      // heading saying so is noise.
      const grouped = files.some((row) => row.group !== "");
      for (const row of files) {
        if (row.group !== heading && (grouped || row.group !== "")) {
          heading = row.group;
          children.push(groupHeading(row.group));
        }
        const item = document.createElement("li");
        item.className = "row";
        // The index into the whole playlist, not into what is on screen: what
        // plays is a track number the server knows, and folders are a way of
        // looking rather than a different list.
        item.dataset.index = String(row.index);
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = String(row.index + 1).padStart(2, " ");
        const label = document.createElement("span");
        label.className = "name";
        label.textContent = row.name;
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = row.seconds > 0 ? formatTime(row.seconds) : "--:--";
        item.append(n, label, time);
        // The file's own address, for whoever wants it somewhere other than
        // here. A picked file is a blob in this tab and has no address.
        if (mode === "remote") {
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "row-copy";
          copy.textContent = "⧉";
          copy.title = "Copy this file's URL";
          copy.setAttribute("aria-label", `Copy the URL of ${row.name}`);
          copy.addEventListener("click", (event) => {
            // Copying is not choosing: the row's own click plays it.
            event.stopPropagation();
            void copyText(remote.media(row.index), copy, "✓");
          });
          item.append(copy);
        }
        children.push(item);
      }
      dom.playlist.replaceChildren(...children);
    }
    const active = at();
    const live = playing();
    let selected: HTMLElement | undefined;
    for (const child of Array.from(dom.playlist.children)) {
      const row = child as HTMLElement;
      // By the index it carries, not by where it sits: headings are rows in
      // the list too, and counting them as tracks lit up the wrong one.
      const index = Number(row.dataset.index);
      const isActive = Number.isInteger(index) && index === active;
      row.classList.toggle("selected", isActive);
      row.classList.toggle("playing", isActive && live);
      if (isActive) selected = row;
    }

    // Only when the track actually changed.
    //
    // This used to run on every draw, and a draw happens twelve times a
    // second, so the list dragged itself back to the playing row a moment
    // after any attempt to scroll away from it. Scrolling up through a
    // playlist was impossible -- it read as the list scrolling forever on its
    // own -- and the fix is not to scroll when there is no news.
    if (active !== scrolledTo) {
      scrolledTo = active;
      selected?.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * The heading over a block of the playlist.
   *
   * An empty name is the library -- what this server was started on -- and it
   * cannot be removed from here, because removing it is not a playlist edit;
   * it is what the command line is for.
   */
  function groupHeading(group: string): HTMLElement {
    const item = document.createElement("li");
    item.className = "group";
    const label = document.createElement("span");
    label.className = "group-name";
    label.textContent = group === "" ? "This server's library" : group;
    item.append(label);
    if (group !== "" && !dom.adminPanel.hidden) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "group-remove";
      remove.textContent = "×";
      remove.title = `Remove ${group} from the playlist`;
      remove.setAttribute("aria-label", `Remove ${group} from the playlist`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeGroup(group);
      });
      item.append(remove);
    }
    return item;
  }

  async function removeGroup(group: string): Promise<void> {
    try {
      const answer = await fetch(remote.url("/api/source/remove"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group }),
      });
      const body = (await answer.json()) as { error?: string; removed?: number };
      said(answer.ok
        ? `Removed ${body.removed ?? 0} tracks from ${group}.`
        : (body.error ?? "that did not work"));
    } catch {
      said("could not reach the server");
    }
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
        meter(l, r);
      dom.elapsed.textContent = formatTime(position());
      const of = duration();
      if (!scrubbing && of > 0) dom.seek.value = String(Math.round((position() / of) * 1000));
    }
    requestAnimationFrame(frame);
  }

  function showVideo(on: boolean): void {
    dom.video.hidden = !on;
    // The button goes with the picture. Over a song there is nothing to make
    // full screen, and a control that can only do nothing is worse than none.
    dom.fullscreen.hidden = !on;
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

  dom.filter.addEventListener("input", () => {
    renderedFor = "";
    renderPlaylist();
  });

  dom.playlist.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("li");
    const chosen = Number(row?.dataset.index);
    if (Number.isInteger(chosen)) void playAt(chosen);
  });

  /**
   * Fill the screen with the picture.
   *
   * Offered only when there is a picture to fill it with, which is why it is
   * hidden alongside the video element rather than sitting there greyed out
   * over a song.
   *
   * iOS Safari has no Fullscreen API on a <video>; it has
   * webkitEnterFullscreen, which is the native player and the only way a video
   * goes full screen on an iPhone at all. Asked for in that order, because the
   * standard one exists on iPad and the WebKit one does not always.
   */
  dom.fullscreen.addEventListener("click", () => {
    const video = dom.video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitSupportsFullscreen?: boolean;
    };
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (typeof video.requestFullscreen === "function") {
      video.requestFullscreen().catch(() => {
        // Refused, or not allowed from here. The iPhone path is the fallback.
        video.webkitEnterFullscreen?.();
      });
      return;
    }
    video.webkitEnterFullscreen?.();
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
    const typed = dom.remoteUrl.value;
    // What people paste is a share link: an address with a key on the end of
    // it. Taken whole it is not an address -- there is no /admin/KEY/api/health,
    // and asking for one gets a 404 that reads as "no nixamp answered there",
    // which is how connecting to your own server failed while the server was
    // healthy the entire time. The directory's Listen button hands this the
    // same shape, so it failed the same way.
    const { base, key } = splitShareLink(typed);
    if (base === "") {
      note = "That is not an address.";
      draw();
      return;
    }
    void (async () => {
      remoteStatus = "connecting";
      draw();
      // Asked before trying, because the browser will refuse this one without
      // ever sending it and "no nixamp answered there" would be a lie.
      const blocked = blockedAsMixedContent(base);
      if (blocked) {
        remoteStatus = "error";
        remoteDetail = blocked;
        note = blocked;
        mode = "local";
        draw();
        return;
      }
      // With the key, because a keyed server answers 401 to everything without
      // it -- including the health check that decides whether to go on.
      const version = await probeServer(base, undefined, key);
      if (version === null) {
        remoteStatus = "error";
        // A certificate cannot be issued for an IP, so this one never had a
        // chance and the server is very likely running perfectly.
        const nameless = needsAName(base);
        remoteDetail = nameless ? "needs the server's name" : "not answering";
        // The reasons are different problems and deserve different sentences:
        // a machine that is off needs starting, an address that is wrong needs
        // correcting, and an https link to an IP needs a name.
        note = nameless
          ? nameless
          : `Nothing answered at ${base}. If that is your machine, it is off or ` +
            "nixamp is not running on it; otherwise check the address.";
        mode = "local";
        draw();
        return;
      }
      // Health answers to anybody -- it is how you check a port is open -- so
      // it says nothing about whether we may drive this server. Asked properly
      // before connecting, because the event stream cannot report a 401: it
      // just retries, and the page said "reconnecting..." forever about a
      // server that had already made up its mind.
      const refusal = await refusesUs(base, key);
      if (refusal) {
        remoteStatus = "error";
        remoteDetail = refusal;
        note = refusal;
        mode = "local";
        draw();
        return;
      }
      mode = "remote";
      note = "";
      // The link as it was given, key and all: saving the bare address would
      // mean the next visit reconnects to a server that then refuses it.
      try { localStorage.setItem(REMOTE_KEY, typed.trim()); } catch { /* private mode */ }
      remote.connect(typed);
      void loadOnAir();
      watchOnAir(true);
      // Asked of the server we just connected to. Whether you may administer
      // it is a question about that machine, and it was being answered by
      // whatever host served this page -- so the Admin panel appeared or did
      // not for reasons that had nothing to do with the server in front of you.
      void checkAdmin();
      void loadShare();
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

    let streams: {
      id: string;
      name: string;
      url: string;
      tracks: number;
      nowPlaying: string;
      /** The account behind the stream. Empty on an instance without accounts. */
      ownerId?: string;
      /** The phone code, and how many people are on the line for it. */
      code?: string;
      callers?: number;
      /** Whether its player is running, and the live channels on it by name. */
      playing?: boolean;
      channels?: string[];
    }[];
    try {
      const response = await fetch("/api/directory");
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as {
        streams?: typeof streams;
        recent?: RecentStream[];
      };
      streams = body.streams ?? [];
      showRecent(body.recent ?? []);
    } catch {
      dom.directoryNote.textContent = "The directory is not answering. Type an address instead.";
      return;
    }

    if (streams.length === 0) {
      dom.directoryNote.textContent = "Nobody is streaming right now.";
      return;
    }

    dom.directoryNote.textContent =
      `${streams.length} ${streams.length === 1 ? "server is" : "servers are"} on. ` +
      "Connect to one to browse its files and watch what is live on it. No account needed.";
    for (const stream of streams) {
      const item = document.createElement("li");

      // A server, and what a visitor would find on it: how much there is to
      // browse, what its player is doing, and which channels are live. Then
      // Connect. The row used to be one button whose only word was the
      // server's name, which said nothing about what connecting would get you.
      // textContent, never innerHTML: these names are written by strangers.
      const label = document.createElement("span");
      label.className = "server-label";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = stream.name;
      const detail = document.createElement("span");
      detail.className = "detail";
      const parts: string[] = [`${stream.tracks.toLocaleString()} files to browse`];
      if (stream.playing !== false && stream.nowPlaying) parts.push(`playing ${stream.nowPlaying}`);
      else parts.push("player idle");
      // The call-in code earns its place in the list: it is the only way to
      // hear this from a phone, and a code you cannot see is a code you
      // cannot dial.
      if (stream.code) {
        parts.push(
          stream.callers ? `☎ ${stream.code} · ${stream.callers} on the phone` : `☎ ${stream.code}`,
        );
      }
      detail.textContent = parts.join(" · ");
      label.append(name, detail);
      if (stream.channels && stream.channels.length > 0) {
        const live = document.createElement("span");
        live.className = "detail live";
        live.textContent = `● live: ${stream.channels.join(", ")}`;
        label.append(live);
      }

      const connect = document.createElement("button");
      connect.type = "button";
      connect.className = "button";
      connect.textContent = "Connect";
      connect.addEventListener("click", () => {
        dom.remoteUrl.value = stream.url;
        dom.directory.hidden = true;
        dom.remoteForm.requestSubmit();
      });
      item.append(label, connect);
      // A heart, for somebody signed in: the way back to a server you liked.
      if (meId) item.append(heartButton(stream.url, stream.name));

      // Following is for other people's streams, and only once we know who you
      // are: an anonymous visitor has nowhere to be notified.
      if (stream.ownerId && meId && stream.ownerId !== meId) {
        item.append(followButton(stream.ownerId, stream.name));
      }
      // Your own, on the other hand, you can take down. A listing outlives the
      // server that made it by up to a couple of minutes, and a machine that
      // was stopped without saying goodbye leaves one sitting there for
      // everybody to click on and get nothing from.
      if (stream.ownerId && meId && stream.ownerId === meId) {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "ghost";
        stop.textContent = "Take off the list";
        stop.addEventListener("click", (event) => {
          event.stopPropagation();
          stop.disabled = true;
          void (async () => {
            try {
              const answer = await fetch(`/api/directory?id=${encodeURIComponent(stream.id)}`, {
                method: "DELETE",
              });
              const body = (await answer.json().catch(() => ({}))) as { error?: string };
              dom.directoryNote.textContent = answer.ok
                ? `${stream.name} is off the list.`
                : (body.error ?? "that did not work");
            } catch {
              dom.directoryNote.textContent = "could not reach the directory";
            } finally {
              await loadDirectory();
            }
          })();
        });
        item.append(stop);
      }
      dom.directoryList.append(item);
    }
  };

  // /directory is a page, not a drawer. Opening it showed the player with the
  // list somewhere below the fold, which read as "the directory is broken".
  if (location.pathname.replace(/\/+$/, "") === "/directory") {
    document.body.classList.add("route-directory");
    const back = document.getElementById("directory-back");
    if (back) back.hidden = false;
    void loadDirectory();
  }

  // --- administering ----------------------------------------------------
  //
  // The panel appears only for someone the server will actually obey: the
  // holder of its control link, or the nixamp.com account that owns it. The
  // server decides, and says so at /api/admin, so the page never has to guess
  // from a token it can see.
  let adminTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Where somebody is, in words rather than in network jargon.
   *
   * "cgnat" said nothing to anybody and, worse, read as an accusation: the
   * 100.64.0.0/10 range belongs to carrier-grade NAT, which is what a phone on
   * a mobile network comes from -- and also what Tailscale uses. Saying
   * "tailscale" would be a guess, and it was frightening when wrong.
   */
  const networkName = (network: string): string =>
    network === "cgnat"
      ? "mobile or tailscale"
      : network === "private"
        ? "your network"
        : network === "local"
          ? "this machine"
          : network === "public"
            ? "the internet"
            : network;

  /** What a connection is doing, rather than which route it came down. */
  const kindName = (kind: string): string =>
    kind === "events"
      ? "watching the panel"
      : kind === "page"
        ? "opened the page"
        : kind === "media"
          ? "playing a track"
          : kind === "stream"
            ? "listening live"
            : kind;

  /**
   * What the last draw was of, so an unchanged poll changes nothing.
   *
   * These are rebuilt every two seconds. Rebuilding a table whose height
   * depends on how many rows it has moves every panel below it, twice a
   * minute, whether or not anything happened -- which is what "the panels jump
   * around" was.
   */
  let drawnConnections = "";
  let drawnPublish = "";

  const drawConnections = (rows: {
    address: string;
    network: string;
    kind: string;
    agent: string;
    track: string;
    bytes: number;
    endedAt: number | null;
  }[]): void => {
    const key = rows.map((r) => `${r.address}|${r.kind}|${r.track}|${Math.round(r.bytes / 4096)}|${r.endedAt}`).join("~");
    if (key === drawnConnections) return;
    drawnConnections = key;

    dom.adminConnections.replaceChildren();
    const head = document.createElement("tr");
    for (const label of ["Where", "Network", "Kind", "Client", "Track", "Sent"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.append(th);
    }
    dom.adminConnections.append(head);

    for (const row of rows.slice(0, 40)) {
      const tr = document.createElement("tr");
      if (row.endedAt !== null) tr.className = "ended";
      const cells: [string, string][] = [
        [row.address, ""],
        [networkName(row.network), `network-${row.network}`],
        [kindName(row.kind), ""],
        [row.agent, ""],
        [row.track || "—", ""],
        [`${Math.round(row.bytes / 1024)} KiB`, ""],
      ];
      for (const [text, className] of cells) {
        const td = document.createElement("td");
        // textContent, never innerHTML: a user agent is written by whoever
        // connected.
        td.textContent = text;
        if (className) td.className = className;
        tr.append(td);
      }
      dom.adminConnections.append(tr);
    }
  };

  /**
   * Report what an admin action just did, somewhere it will still be there.
   *
   * The status line above it refreshes every two seconds with a listener
   * count, so an answer written there was gone before it could be read --
   * which made adding a folder look like it had done nothing at all, even
   * though it had.
   */
  function said(message: string): void {
    dom.adminSaid.textContent = message;
    dom.adminSaid.hidden = message === "";
  }

  const refreshAdmin = async (): Promise<void> => {
    try {
      // The connected server, with its key -- not whatever origin this page
      // was served from, which has no idea who is listening to your machine.
      const answer = await fetch(remote.url("/api/connections"));
      if (!answer.ok) return;
      const body = (await answer.json()) as {
        connections?: Parameters<typeof drawConnections>[0];
        active?: number;
        publish?: { id: string; url: string }[];
        channels?: { id: string }[];
        home?: string;
        root?: string;
      };
      // Said in full, because "0 listening now" over a table with rows in it
      // reads as a contradiction. Only media and live connections are
      // listeners; a panel open in a browser is not one, and it is the row
      // most likely to be there.
      const rows = body.connections ?? [];
      const others = rows.filter((row) => row.endedAt === null && row.kind !== "media" && row.kind !== "stream").length;
      const listening = body.active ?? 0;
      dom.adminNote.textContent = others === 0
        ? `${listening} listening now.`
        : `${listening} listening now, and ${others} with the page open.`;
      drawConnections(body.connections ?? []);
      drawPublish(body.publish ?? [], (body.channels ?? []).map((one) => one.id));
      drawHome(body.home ?? "", body.root ?? "");
      void loadOnAir();
    } catch {
      dom.adminNote.textContent = "lost touch with the server";
    }
  };

  /**
   * Where OBS points, one row per stream this server will take.
   *
   * There is no single link, and that is the answer to "how would several
   * streams work with one link" -- they would not. ffmpeg's RTMP listener
   * takes one connection per process, so each simultaneous publisher gets its
   * own port and its own URL, and the channel it lands on is named beside it.
   */
  function drawPublish(entries: { id: string; url: string }[], busy: string[]): void {
    // A server started without --rtmp-in cannot be published to at all, so the
    // panel is not there rather than being there and saying no.
    dom.publishPanel.hidden = entries.length === 0;
    const key = `${entries.map((e) => `${e.id}=${e.url}`).join("~")}::${busy.join(",")}`;
    if (key === drawnPublish) return;
    drawnPublish = key;

    if (entries.length === 0) {
      dom.publishList.replaceChildren();
      return;
    }
    const free = entries.length - busy.length;
    dom.publishNote.textContent =
      `Point OBS, Larix or ffmpeg at one of these. One publisher per URL — ` +
      `${entries.length} at once, ${free} free right now.`;

    dom.publishList.replaceChildren(...entries.map((entry) => {
      const inUse = busy.includes(entry.id);
      const item = document.createElement("li");
      if (inUse) item.className = "in-use";
      const slot = document.createElement("span");
      slot.className = "slot";
      // Which slot, and whether anybody is on it -- the question you actually
      // have when you are about to point OBS at one of three addresses.
      slot.textContent = inUse ? `${entry.id} · live` : entry.id;
      const box = document.createElement("input");
      box.type = "text";
      box.readOnly = true;
      box.value = entry.url;
      box.setAttribute("aria-label", `RTMP URL for ${entry.id}`);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        box.select();
        void navigator.clipboard?.writeText(entry.url).catch(() => {});
      });
      item.append(slot, box, copy);
      return item;
    }));
  }

  const checkAdmin = async (): Promise<void> => {
    // Nothing to administer until you are connected to something.
    //
    // Asked with no remote, this went to whichever host served the page -- and
    // nixamp.com runs with no share key, which means "anyone who can reach
    // this port may drive it", so it answered yes to everybody. The result was
    // an Admin panel, for nixamp.com, sitting there before you had connected
    // anywhere: a re-stream box that belonged to the wrong machine and did
    // nothing useful when you typed in it.
    if (mode !== "remote") {
      dom.adminPanel.hidden = true;
      dom.publishPanel.hidden = true;
      if (adminTimer) clearInterval(adminTimer);
      adminTimer = null;
      return;
    }

    let allowed = false;
    let as: string | null = null;
    let claimedOwner = false;
    try {
      // The server this page is connected to, not the origin the page came
      // from. Relative, these two calls asked nixamp.com whether somebody may
      // administer a machine nixamp.com has never heard of.
      const answer = await fetch(remote.url("/api/admin"));
      if (answer.ok) {
        const body = (await answer.json()) as { allowed?: boolean; as?: string | null; claimed?: boolean };
        allowed = body.allowed === true;
        as = body.as ?? null;
        claimedOwner = body.claimed === true;
      }
    } catch {
      allowed = false;
    }

    dom.adminPanel.hidden = !allowed;
    if (adminTimer) clearInterval(adminTimer);
    adminTimer = null;
    // The list of what is live carries Restart and Remove only for somebody
    // who may, and it was usually drawn before this answer arrived -- so it
    // is drawn again now, with the answer.
    void loadOnAir();
    // Whether you may administer this server decides whether Go live is
    // offered, and this is the answer to that question -- so the share panel
    // is drawn again now rather than from whatever was known before it.
    void loadShare();

    // Say why, rather than leaving a gap where the controls were.
    //
    // A server hands out two links: one that drives it and one that only
    // hears it. Connected with the listening one, everything works except the
    // things that change what is playing -- and those simply were not there,
    // with nothing to say that the link was the reason. "The re-stream option
    // is missing" is what that looked like.
    dom.listenOnly.hidden = allowed;
    if (!allowed) {
      dom.listenOnly.textContent = claimedOwner
        ? "This is a listen-only link: you can hear this server but not change what it plays. " +
          "Use its control link — the first one it printed — or sign in as its owner."
        : "This is a listen-only link: you can hear this server but not change what it plays. " +
          "Use its control link, the first one it printed.";
      return;
    }

    dom.adminNote.textContent = as === "owner" ? "You own this server." : "You hold this server's control link.";
    void refreshAdmin();
    adminTimer = setInterval(() => void refreshAdmin(), 2000);
  };

  /**
   * Put something on the air, as a channel of its own.
   *
   * Not as a playlist track. A server plays one track at a time, so a second
   * re-stream added that way sat there saying "stopped" -- and two people
   * could not watch two different things, which is most of the point of a
   * server that carries streams. A channel is its own process with its own
   * audience and its own address, and a server carries as many as it can
   * decode.
   */
  function goLive(source: string, named: string, at?: number): void {
    // Named by hand where possible, because a URL ending in /932 is not a
    // name and the stream calls itself Service01.
    const id = (named || source)
      .toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
      || `s${Math.random().toString(16).slice(2, 8)}`;
    said(`Starting ${named || source}…`);
    void (async () => {
      try {
        const answer = await fetch(remote.url(`/api/channels/${encodeURIComponent(id)}/pull`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(at === undefined ? { source } : { at }),
            ...(named ? { name: named } : {}),
          }),
        });
        const body = (await answer.json()) as { error?: string; channel?: { name: string } };
        if (!answer.ok) {
          said(body.error ?? "that did not work");
          return;
        }
        said(`${body.channel?.name || named || source} is on the air.`);
        dom.adminSource.value = "";
        dom.adminName.value = "";
        void loadShare();
        void loadOnAir();
      } catch {
        said("could not reach the server");
      }
    })();
  }

  dom.adminRestream.addEventListener("submit", (event) => {
    event.preventDefault();
    const source = dom.adminSource.value.trim();
    if (!source) return;
    goLive(source, dom.adminName.value.trim());
  });

  dom.adminAdd.addEventListener("click", () => {
    const source = dom.adminSource.value.trim();
    if (!source) return;
    said(`Reading ${source}…`);
    // Adding is the default, because adding an album is what people do and
    // losing a five-thousand-track library to it is not what they meant.
    const replace = dom.adminReplace.checked;
    const named = dom.adminName.value.trim();
    void (async () => {
      try {
        const answer = await fetch(remote.url("/api/source"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source,
            // Optional, and worth a lot: a channel called "932" tells nobody
            // anything, and its own stream calls itself "Service01".
            ...(named ? { name: named } : {}),
            ...(replace ? { replace: true } : {}),
          }),
        });
        const body = (await answer.json()) as { error?: string; added?: number };
        said(!answer.ok
          ? (body.error ?? "that did not work")
          : replace
            ? `Now serving ${source}.`
            : body.added === 0
              ? "Everything there was already in the playlist."
              : `Added ${body.added ?? 0} tracks from ${source}.`);
        if (answer.ok) {
          dom.adminSource.value = "";
          dom.adminName.value = "";
          // Re-streaming something is usually the moment you want people to
          // find it, and a server that is not listed is not findable -- which
          // is why the directory kept saying nobody was streaming while you
          // were. The panel with the Go live button is redrawn here so it is
          // in front of you rather than somewhere to go looking for.
          void loadShare();
          void loadOnAir();
        }
      } catch {
        said("could not reach the server");
      }
    })();
  });

  interface RecentStream {
    name: string;
    ownerId: string;
    nowPlaying: string;
    endedAt: number;
  }

  /** "12 minutes ago", roughly. Precision here would be false precision. */
  const ago = (at: number): string => {
    const minutes = Math.max(1, Math.round((Date.now() - at) / 60000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  };

  /**
   * The people who were on recently, and are not on now.
   *
   * There is nothing to click through to -- they stopped -- so these are rows
   * with a follow button and no listen button. That is the whole point of
   * them: an empty directory used to mean nobody to follow, which made
   * following useless exactly when it was most useful.
   */
  const showRecent = (recent: RecentStream[]): void => {
    dom.recentList.replaceChildren();
    const followable = meId ? recent.filter((r) => r.ownerId && r.ownerId !== meId) : [];
    dom.recentNote.hidden = followable.length === 0;
    if (followable.length === 0) return;

    for (const stream of followable) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.className = "recent-label";

      // textContent, never innerHTML: these names are written by strangers.
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = stream.name;
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = stream.nowPlaying
        ? `${stream.nowPlaying} · ended ${ago(stream.endedAt)}`
        : `ended ${ago(stream.endedAt)}`;

      label.append(name, detail);
      item.append(label, followButton(stream.ownerId, stream.name));
      dom.recentList.append(item);
    }
  };

  /**
   * Who you follow, so it can be undone.
   *
   * Following was write-only until this: the API could list it and nothing
   * asked. Somebody who followed a stream once had no way to see it again, let
   * alone stop it, which is not a thing to ship and call finished.
   */
  /**
   * The machines on this account.
   *
   * A share link printed in a terminal you have since closed is a server you
   * have lost, so the list lives against the account and reads the same here,
   * in the CLI and in the desktop app. Where the key was kept with the entry
   * the link opens straight into the player; where it was not, the address is
   * still the thing you needed.
   */
  // ---- favourites: the servers you hearted ----------------------------------
  //
  // Kept against the nixamp.com account, so they are the same on every device.
  // A favourite is the link that opens the server, matched by its origin,
  // because the same machine can be reached by its view link and its admin
  // link and either one is "that server".
  let favoriteUrls = new Set<string>();

  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };
  const isFavorite = (url: string): boolean =>
    [...favoriteUrls].some((one) => originOf(one) === originOf(url));

  async function loadFavorites(): Promise<void> {
    if (!meId) {
      favoriteUrls = new Set();
      dom.favoritesPanel.hidden = true;
      updateFavHere();
      return;
    }
    try {
      const answer = await fetch("/api/v1/favorites");
      if (!answer.ok) {
        dom.favoritesPanel.hidden = true;
        return;
      }
      const body = (await answer.json()) as {
        favorites?: { url: string; name: string; live: boolean; nowPlaying: string; channels: string[] }[];
      };
      const list = body.favorites ?? [];
      favoriteUrls = new Set(list.map((one) => one.url));
      dom.favoritesPanel.hidden = list.length === 0;
      dom.favoritesNote.textContent = "Servers you hearted. Connect to one, or let it go.";
      dom.favoritesList.replaceChildren(...list.map((fav) => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.className = "server-label";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = fav.name || fav.url.replace(/^https?:\/\//, "");
        const detail = document.createElement("span");
        detail.className = fav.live ? "detail live" : "detail";
        detail.textContent = fav.live
          ? [
              "● on now",
              fav.nowPlaying ? `playing ${fav.nowPlaying}` : "",
              fav.channels.length > 0 ? `live: ${fav.channels.join(", ")}` : "",
            ].filter(Boolean).join(" · ")
          : "not on right now";
        label.append(name, detail);

        const connect = document.createElement("button");
        connect.type = "button";
        connect.className = "button";
        connect.textContent = "Connect";
        connect.addEventListener("click", () => {
          dom.remoteUrl.value = fav.url;
          dom.remoteForm.requestSubmit();
        });
        item.append(label, connect, heartButton(fav.url, fav.name));
        return item;
      }));
    } catch {
      dom.favoritesPanel.hidden = true;
    }
    updateFavHere();
  }

  async function setFavorite(url: string, name: string, on: boolean): Promise<void> {
    try {
      const answer = on
        ? await fetch("/api/v1/favorites", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, name }),
          })
        : await fetch(`/api/v1/favorites?url=${encodeURIComponent(url)}`, { method: "DELETE" });
      if (!answer.ok) {
        note = on ? "Could not save that favourite." : "Could not remove that favourite.";
        draw();
        return;
      }
    } catch {
      note = "could not reach nixamp.com";
      draw();
      return;
    }
    if (on) favoriteUrls.add(url);
    else for (const one of [...favoriteUrls]) if (originOf(one) === originOf(url)) favoriteUrls.delete(one);
    await loadFavorites();
  }

  /** ♡ or ♥ for one server, wherever it is listed. */
  function heartButton(url: string, name: string): HTMLButtonElement {
    const heart = document.createElement("button");
    heart.type = "button";
    heart.className = "heart";
    const paint = (): void => {
      const on = isFavorite(url);
      heart.textContent = on ? "♥" : "♡";
      heart.dataset.on = on ? "yes" : "no";
      heart.title = on ? "Remove from favourites" : "Add to favourites";
      heart.setAttribute("aria-label", heart.title);
    };
    paint();
    heart.addEventListener("click", (event) => {
      event.stopPropagation();
      // The favourite is the link that stays, not the admin link, if we have
      // a choice: removing goes by origin, so either form takes it off.
      const stored = [...favoriteUrls].find((one) => originOf(one) === originOf(url)) ?? url;
      void setFavorite(isFavorite(url) ? stored : url, name, !isFavorite(url)).then(paint);
    });
    return heart;
  }

  /** The heart in the header, for the server we are connected to. */
  function updateFavHere(): void {
    const link = mode === "remote" ? remote.shareLink : "";
    dom.favHere.hidden = !(meId && link);
    if (dom.favHere.hidden) return;
    const on = isFavorite(link);
    dom.favHere.textContent = on ? "♥" : "♡";
    dom.favHere.dataset.on = on ? "yes" : "no";
    dom.favHere.title = on ? "Remove this server from your favourites" : "Add this server to your favourites";
    dom.favHere.setAttribute("aria-label", dom.favHere.title);
  }

  dom.favHere.addEventListener("click", () => {
    const link = remote.shareLink;
    if (!link) return;
    const stored = [...favoriteUrls].find((one) => originOf(one) === originOf(link)) ?? link;
    void setFavorite(isFavorite(link) ? stored : link, serverName || remote.address, !isFavorite(link))
      .then(updateFavHere);
  });

  const loadServers = async (): Promise<void> => {
    dom.serversList.replaceChildren();
    try {
      const answer = await fetch("/api/v1/servers");
      if (!answer.ok) {
        dom.serversPanel.hidden = true;
        return;
      }
      const body = (await answer.json()) as {
        servers?: { id: string; name: string; url: string; key: string }[];
      };
      const list = body.servers ?? [];
      dom.serversPanel.hidden = false;
      dom.serversNote.textContent = list.length === 0
        ? "No servers yet. `nixamp server add --here` remembers the one you are running."
        : "The machines on your account. Open one, or forget it.";

      for (const entry of list) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.className = "recent-label";

        // textContent, never innerHTML: a name is whatever somebody typed.
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = entry.name;
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = entry.url;
        label.append(name, detail);

        // Connects here rather than navigating to the server's own copy of
        // this same page. Going there gains nothing -- it is the same player
        // against the same server -- and it loses the account you are signed
        // in to, which is the half that knows who you are.
        const open = document.createElement("button");
        open.type = "button";
        open.className = "button";
        open.textContent = "Open";
        open.addEventListener("click", () => {
          // The key kept against your account is the one that administers.
          dom.remoteUrl.value = entry.key ? `${entry.url}/admin/${entry.key}` : entry.url;
          dom.remoteForm.requestSubmit();
        });

        // Asked rather than assumed. A machine you turned off looks exactly
        // like a machine that is up until you click Open and nothing happens,
        // and "nothing happens" is the least useful thing a list can say.
        void probeServer(entry.url).then((version) => {
          if (version !== null) {
            detail.textContent = `${entry.url} · ${version}`;
            return;
          }
          detail.textContent = `${entry.url} · not answering`;
          item.classList.add("offline");
          open.disabled = true;
          open.title = "That machine is not answering. Start nixamp on it.";
        });

        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "ghost";
        forget.textContent = "Forget";
        forget.addEventListener("click", () => {
          void (async () => {
            forget.disabled = true;
            try {
              await fetch(`/api/v1/servers/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
              await loadServers();
            } catch {
              forget.disabled = false;
            }
          })();
        });

        item.append(label, open, forget);
        dom.serversList.append(item);
      }
    } catch {
      dom.serversPanel.hidden = true;
    }
  };

  const loadFollowing = async (): Promise<void> => {
    dom.followingList.replaceChildren();
    try {
      const answer = await fetch("/api/v1/follows");
      if (!answer.ok) {
        dom.followingNote.hidden = true;
        return;
      }
      const body = (await answer.json()) as {
        following?: { id: string; name: string; live: boolean }[];
      };
      const list = body.following ?? [];
      dom.followingNote.hidden = list.length === 0;

      for (const who of list) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.className = "recent-label";

        const name = document.createElement("span");
        name.className = "name";
        // Somebody who has never streamed has no name we know. Saying so beats
        // showing a bare account id nobody can recognise.
        name.textContent = who.name || "a nixamp";
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = who.live ? "live now" : "not streaming";
        label.append(name, detail);

        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "ghost follow";
        stop.textContent = "Unfollow";
        stop.addEventListener("click", () => {
          void (async () => {
            stop.disabled = true;
            try {
              await fetch(`/api/v1/follows/${encodeURIComponent(who.id)}`, { method: "DELETE" });
              item.remove();
              if (dom.followingList.children.length === 0) dom.followingNote.hidden = true;
            } finally {
              stop.disabled = false;
            }
          })();
        });

        item.append(label, stop);
        dom.followingList.append(item);
      }
    } catch {
      dom.followingNote.hidden = true;
    }
  };

  /**
   * A follow button that knows its own state.
   *
   * Asked per stream rather than fetched as a set, because the directory is
   * short and a list of who you follow is a second thing to keep in step with
   * the first. It reads "Following" once you do, and clicking again undoes it.
   */
  const followButton = (streamerId: string, name: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost follow";
    button.textContent = "Follow";
    button.setAttribute("aria-label", `Follow ${name}`);

    const draw = (following: boolean): void => {
      button.textContent = following ? "Following" : "Follow";
      button.dataset["following"] = following ? "yes" : "no";
    };

    void (async () => {
      try {
        const answer = await fetch(`/api/v1/follows/${encodeURIComponent(streamerId)}`);
        if (answer.ok) draw(((await answer.json()) as { following?: boolean }).following === true);
      } catch {
        // A directory that lists is more use than one that refuses to render
        // because it could not colour a button in.
      }
    })();

    button.addEventListener("click", () => {
      void (async () => {
        const following = button.dataset["following"] === "yes";
        button.disabled = true;
        try {
          const answer = await fetch(`/api/v1/follows/${encodeURIComponent(streamerId)}`, {
            method: following ? "DELETE" : "PUT",
            headers: { "content-type": "application/json" },
            body: following ? undefined : "{}",
          });
          if (answer.ok) {
            draw(!following);
            // The panel is the other half of this: following from the
            // directory should show up in the list that undoes it.
            void loadFollowing();
          }
        } catch {
          // Leave the button as it was rather than lying about the result.
        } finally {
          button.disabled = false;
        }
      })();
    });
    return button;
  };

  // --- notifications ------------------------------------------------------
  //
  // Three switches and a phone number. The web one is different from the other
  // two: it needs the browser's permission as well as our preference, and the
  // browser will only ask in response to a click, so it cannot be turned on
  // from a page load however much the stored preference says it should be.

  /** VAPID keys travel as base64url and the API wants bytes. */
  const keyBytes = (base64: string): Uint8Array<ArrayBuffer> => {
    const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const raw = atob(padded);
    // Built on an explicit ArrayBuffer rather than Uint8Array.from: the push
    // API wants a BufferSource, and a plain Uint8Array is typed over
    // ArrayBufferLike, which admits SharedArrayBuffer and so is not assignable.
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  };

  const pushable = (): boolean =>
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const subscribeThisDevice = async (): Promise<boolean> => {
    if (!pushable()) {
      dom.notifyNote.textContent = "This browser cannot show notifications.";
      return false;
    }
    if (Notification.permission === "denied") {
      dom.notifyNote.textContent =
        "This browser is blocking notifications. Allow them in site settings first.";
      return false;
    }
    if ((await Notification.requestPermission()) !== "granted") {
      dom.notifyNote.textContent = "Not allowed, so nothing will be sent here.";
      return false;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const answer = await fetch("/api/v1/notify/key");
      const { publicKey } = (await answer.json()) as { publicKey?: string };
      if (!publicKey) {
        dom.notifyNote.textContent = "This server is not set up to send notifications.";
        return false;
      }
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required by every browser: a push must result in something the
          // person can see, which is exactly what this one does.
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      const sent = await fetch("/api/v1/notify/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!sent.ok) throw new Error(String(sent.status));
      dom.notifyNote.textContent = "This device will be told.";
      return true;
    } catch {
      dom.notifyNote.textContent = "Could not set this device up.";
      return false;
    }
  };

  const forgetThisDevice = async (): Promise<void> => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      await fetch(`/api/v1/notify/subscribe?endpoint=${encodeURIComponent(subscription.endpoint)}`, {
        method: "DELETE",
      });
      await subscription.unsubscribe();
    } catch {
      // Nothing to undo that matters: the server drops a dead endpoint on the
      // next push anyway.
    }
  };

  const saveNotify = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const answer = await fetch("/api/v1/notify/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await answer.json()) as { error?: string; phone?: string };
      dom.notifyPhoneNote.textContent = answer.ok ? "" : (body.error ?? "that did not save");
      if (answer.ok && typeof body.phone === "string") dom.notifyPhone.value = body.phone;
    } catch {
      dom.notifyPhoneNote.textContent = "could not reach nixamp.com";
    }
  };

  const loadNotify = async (): Promise<void> => {
    try {
      const answer = await fetch("/api/v1/notify/prefs");
      if (!answer.ok) return;
      const prefs = (await answer.json()) as {
        phone?: string;
        wantsEmail?: boolean;
        wantsSms?: boolean;
        wantsWeb?: boolean;
      };
      dom.notifyEmail.checked = prefs.wantsEmail !== false;
      dom.notifySms.checked = prefs.wantsSms === true;
      dom.notifyPhone.value = prefs.phone ?? "";
      // The preference is only half of it: a device is only really on when the
      // browser has also granted permission and we hold a subscription.
      const granted = pushable() && Notification.permission === "granted";
      const subscribed = granted
        ? (await (await navigator.serviceWorker.ready).pushManager.getSubscription()) !== null
        : false;
      dom.notifyWeb.checked = prefs.wantsWeb !== false && subscribed;
      dom.notifyNote.textContent = subscribed
        ? "Get told when someone you follow goes live."
        : "Turn on “On this device” to be told here.";
    } catch {
      // Leave the panel at its defaults rather than blanking it.
    }
  };

  dom.notifyWeb.addEventListener("change", () => {
    void (async () => {
      if (dom.notifyWeb.checked) {
        const ok = await subscribeThisDevice();
        dom.notifyWeb.checked = ok;
        await saveNotify({ wantsWeb: ok });
        return;
      }
      await forgetThisDevice();
      await saveNotify({ wantsWeb: false });
      dom.notifyNote.textContent = "Turn on “On this device” to be told here.";
    })();
  });

  dom.notifyEmail.addEventListener("change", () => {
    void saveNotify({ wantsEmail: dom.notifyEmail.checked });
  });

  dom.notifySms.addEventListener("change", () => {
    void (async () => {
      // A text with no number to send it to is a switch that does nothing, so
      // say that rather than storing a preference we cannot act on.
      if (dom.notifySms.checked && !dom.notifyPhone.value.trim()) {
        dom.notifyPhoneNote.textContent = "Add a phone number first.";
        dom.notifySms.checked = false;
        dom.notifyPhone.focus();
        return;
      }
      await saveNotify({ wantsSms: dom.notifySms.checked });
    })();
  });

  dom.notifyPhoneForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveNotify({ phone: dom.notifyPhone.value.trim() });
  });

  // --- the account ------------------------------------------------------
  //
  // The session is a cookie the server sets, so nothing here holds a token:
  // the browser attaches it, and a page reload asks who is signed in rather
  // than remembering an answer that may have expired.
  let creating = false;
  /** The signed-in account, so the directory knows whose stream is whose. */
  let meId = "";

  const showAccount = (email: string | null): void => {
    const signedIn = email !== null;
    // Following and notifications belong to an account; there is nowhere to
    // notify a stranger.
    dom.notifyPanel.hidden = !signedIn;
    if (signedIn) {
      void loadNotify();
      void loadFollowing();
      void loadServers();
    } else {
      dom.serversPanel.hidden = true;
      dom.followingNote.hidden = true;
      dom.followingList.replaceChildren();
      dom.recentNote.hidden = true;
      dom.recentList.replaceChildren();
    }
    dom.accountForm.hidden = signedIn;
    dom.accountProviders.hidden = signedIn || dom.accountProviders.childElementCount === 0;
    dom.accountSignOut.hidden = !signedIn;
    dom.accountNote.textContent = signedIn
      ? `Signed in as ${email}.`
      : creating
        ? "Create an account on nixamp.com."
        : "Listening needs no account. Sign in to keep favourites, follow people, and publish.";
    dom.accountSubmit.textContent = creating ? "Create account" : "Sign in";
    dom.accountToggle.textContent = creating ? "I have one" : "Create one";
    dom.accountPassword.autocomplete = creating ? "new-password" : "current-password";
  };

  /**
   * The providers this deployment can sign you in with.
   *
   * An account made by signing in with GitHub has no password at all, so
   * without these buttons its owner could use the terminal and never the site.
   * Each one is a plain link out to the server, which sets the session cookie
   * and sends the browser back here.
   */
  const showProviders = async (): Promise<void> => {
    let offered: { id: string; name: string }[] = [];
    let keepsAccounts = false;
    try {
      const answer = await fetch("/api/v1/auth/providers");
      if (answer.ok) {
        keepsAccounts = true;
        const body = (await answer.json()) as { providers?: { id: string; name: string }[] };
        offered = body.providers ?? [];
      }
    } catch {
      // A nixamp on a laptop keeps no accounts and answers nothing here.
    }
    dom.accountProviders.replaceChildren();
    dom.accountProviders.hidden = offered.length === 0;
    // A nixamp on your own machine keeps no accounts: its /api/v1/auth/* is
    // not there at all, and offering a sign-in form that can only answer "no
    // such endpoint" is worse than offering nothing. Accounts live at
    // nixamp.com, so that is where the panel points instead.
    dom.accountPanel.hidden = !keepsAccounts;
    dom.accountElsewhere.hidden = keepsAccounts;
    for (const provider of offered) {
      const link = document.createElement("a");
      link.className = "button";
      link.href = `/api/v1/${encodeURIComponent(provider.id)}/oauth/start`;
      link.textContent = `Continue with ${provider.name}`;
      dom.accountProviders.append(link);
    }
  };

  const askWhoIsSignedIn = async (): Promise<void> => {
    try {
      const answer = await fetch("/api/v1/auth/me");
      const body = (await answer.json()) as { account?: { email?: string; id?: string } };
      meId = answer.ok ? (body.account?.id ?? "") : "";
      showAccount(answer.ok ? (body.account?.email ?? "you") : null);
    } catch {
      meId = "";
      showAccount(null);
    }
    // Signed in or not decides whether there is anybody to keep favourites for.
    void loadFavorites();
    openInvitedStream();
  };

  /**
   * Open the stream this page was linked to, once there is somebody to open it.
   *
   * Called after every answer about who is signed in, including the one that
   * comes back after signing in, so an invited link survives the detour.
   */
  function openInvitedStream(): void {
    if (invited === "") return;
    // Opened straight away, signed in or not.
    //
    // It used to wait for an account, on the reasoning that a stream can ask
    // to be paid for and there is nobody to charge without one. But only the
    // audio is ever gated, and only once a stream is busier than its free
    // allowance -- so demanding a sign-up before anybody has even seen what
    // they were sent walls off exactly the person an invite is for. The
    // payment moment is when the server answers 402, and that is where the
    // asking belongs.
    const stream = invited;
    invited = "";
    dom.remoteUrl.value = stream;
    dom.remoteForm.requestSubmit();
  }

  dom.accountToggle.addEventListener("click", () => {
    creating = !creating;
    showAccount(null);
  });

  dom.accountForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = dom.accountEmail.value.trim();
    const password = dom.accountPassword.value;
    void (async () => {
      dom.accountSubmit.disabled = true;
      try {
        const answer = await fetch(`/api/v1/auth/${creating ? "signup" : "login"}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const body = (await answer.json()) as {
          account?: { email?: string; id?: string };
          error?: string;
        };
        if (!answer.ok) {
          dom.accountNote.textContent = body.error ?? "that did not work";
          return;
        }
        meId = body.account?.id ?? "";
        // Never leave a password sitting in the DOM after it has been used.
        dom.accountPassword.value = "";
        showAccount(body.account?.email ?? email);
        // Signing in may have made you this server's owner.
        void checkAdmin();
        // And it is what an invited link was waiting for.
        openInvitedStream();
      } catch {
        dom.accountNote.textContent = "could not reach nixamp.com";
      } finally {
        dom.accountSubmit.disabled = false;
      }
    })();
  });

  dom.accountSignOut.addEventListener("click", () => {
    void (async () => {
      try {
        await fetch("/api/v1/auth/logout", { method: "POST" });
      } catch {
        // The cookie is the session; failing to say so does not keep it.
      }
      meId = "";
      showAccount(null);

      // Leaving means leaving. Signing out used to clear the account and
      // nothing else, so the server stayed connected and its address stayed
      // saved -- and finding yourself still driving somebody's machine after
      // logging out is a reasonable thing to be alarmed by.
      //
      // The key itself lives in a cookie on that server's own origin and this
      // page cannot reach across to delete it; what it can do is let go and
      // forget. `--new-key` on the server is what actually revokes a link.
      remote.close();
      watching = -1;
      mode = "local";
      remoteStatus = "idle";
      remoteDetail = "";
      dom.remoteUrl.value = "";
      dom.sharePanel.hidden = true;
      dom.publishPanel.hidden = true;
      dom.adminPanel.hidden = true;
      dom.onairPanel.hidden = true;
      dom.listenOnly.hidden = true;
      watchOnAir(false);
      try {
        localStorage.removeItem(REMOTE_KEY);
      } catch { /* private mode */ }
      note = "Signed out, and disconnected from the server.";

      void checkAdmin();
      draw();
    })();
  });

  // Somebody was sent here to watch something, and the address is in the link.
  // Read before anybody is asked who is signed in, because the answer to that
  // question is what opens it: set afterwards, the invite arrived too late and
  // the page just sat there.
  try {
    const asked = new URL(globalThis.location.href).searchParams.get("url") ?? "";
    if (asked !== "") {
      invited = asked;
      dom.remoteUrl.value = asked;
      note = "Opening the stream you were sent…";
      // Not something to leave in the address bar: it carries a key.
      globalThis.history?.replaceState(null, "", globalThis.location.pathname);
    }
  } catch { /* a URL we cannot read is a URL with no invite in it */ }

  void showProviders();
  void askWhoIsSignedIn();
  void checkAdmin();

  dom.browse.addEventListener("click", () => {
    if (!dom.directory.hidden) {
      dom.directory.hidden = true;
      return;
    }
    void loadDirectory();
    dom.directory.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  dom.disconnect.addEventListener("click", () => {
    remote.close();
    dom.listenOnly.hidden = true;
    watching = -1;
    dom.sharePanel.hidden = true;
    dom.publishPanel.hidden = true;
    dom.adminPanel.hidden = true;
    dom.onairPanel.hidden = true;
    dom.onairPanel.dataset.title = "Live on this server";
    serverName = "";
    updateFavHere();
    watchOnAir(false);
    mode = "local";
    remoteStatus = "idle";
    remoteDetail = "";
    draw();
  });

  /**
   * Fill in the one panel that answers "how do I send this to somebody?".
   *
   * Three things and no jargon: a link that opens this stream on nixamp.com, a
   * number to call, and the code to key. The link is the important one -- most
   * people have a browser in their hand -- and the phone is the fallback that
   * needs no browser at all. The call is not another way to hear the stream:
   * it is the room where the people watching talk to each other.
   */
  // A declaration, not a const: checkAdmin runs during startup, well before
  // this line is reached, and an arrow assigned here would not exist yet.
  async function loadShare(): Promise<void> {
    if (mode !== "remote" || remote.shareLink === "") {
      dom.sharePanel.hidden = true;
      return;
    }
    dom.sharePanel.hidden = false;

    // Through this page, so the person opening it gets a player rather than a
    // server's API. An http stream cannot be reached from an https page at
    // all, so that one is sent as itself.
    //
    // Filled in below with the server's own view-only link when it offers one.
    // Handing over the link you are holding would hand over the controls with
    // it if you are an admin, which is not what "share this" means.
    let stream = remote.shareLink;
    const here = globalThis.location.origin;
    dom.shareLink.value = stream.startsWith("https://")
      ? `${here}/?url=${encodeURIComponent(stream)}`
      : stream;

    dom.shareNote.textContent = "Anyone with this link can watch. They sign in once, then it opens.";

    // The phone code comes from being listed, and being listed is something
    // the server either is or is not -- so it is asked, rather than guessed at
    // by hunting a directory this stream may not be in.
    dom.sharePhone.hidden = true;
    dom.shareSend.hidden = true;
    dom.liveControls.hidden = true;

    let callIn = "";
    try {
      const answer = await fetch("/api/directory");
      if (answer.ok) callIn = ((await answer.json()) as { callIn?: string }).callIn ?? "";
    } catch {
      // The page's own host keeps no directory. The link still works.
    }

    interface LiveState { live: boolean; code: string; possible: boolean; url?: string }
    let live: LiveState | null = null;
    try {
      const answer = await fetch(remote.url("/api/live/state"));
      if (answer.ok) live = (await answer.json()) as LiveState;
      if (live?.url) {
        stream = live.url;
        dom.shareLink.value = stream.startsWith("https://")
          ? `${here}/?url=${encodeURIComponent(stream)}`
          : stream;
      }
    } catch {
      // An older server, or one we may not administer.
    }
    if (!live) return;

    // Only somebody who can administer this server may list it, and only a
    // machine the world can reach can be listed at all.
    dom.liveControls.hidden = dom.adminPanel.hidden || !live.possible;
    dom.goLive.hidden = live.live;
    dom.stopLive.hidden = !live.live;

    dom.sharePhone.hidden = false;
    if (!live.live) {
      dom.sharePhone.textContent = live.possible
        ? "Not listed, so nobody can find this in the directory. Go live to list it, " +
          "with a phone number and a code anyone can call."
        : "This machine has no address the world can reach, so it cannot be listed.";
      return;
    }
    if (!callIn) {
      dom.sharePhone.textContent = `Listed. The code for the phone line is ${live.code}.`;
      dom.shareSend.hidden = false;
      return;
    }
    dom.sharePhone.replaceChildren(
      document.createTextNode("To talk about it, call "),
      boldly(callIn),
      document.createTextNode(" and key "),
      boldly(live.code),
      document.createTextNode(". That is a room with everyone else watching — not the stream itself."),
    );
    dom.shareSend.hidden = false;
  }

  interface OnAir {
    server: {
      name: string; nowPlaying: string; tracks: number; playing: boolean;
      live: boolean; listed?: boolean; code: string; url: string;
    };
    channels: {
      id: string; name: string; via: string; listeners: number; startedAt: number;
      kind?: "audio" | "video"; redials?: number; error?: string;
    }[];
    restreams?: { name: string; at: number; tracks: number }[];
  }

  let drawnOnAir = "";
  /**
   * Its own timer, because a viewer has no admin tick to ride on.
   *
   * Slow on purpose: this changes when somebody starts or stops publishing,
   * which is a thing that happens a few times an hour, not a few times a
   * second. The redraw is skipped entirely when nothing has changed.
   */
  let onAirTimer: ReturnType<typeof setInterval> | null = null;

  const watchOnAir = (on: boolean): void => {
    if (onAirTimer) clearInterval(onAirTimer);
    onAirTimer = null;
    if (!on) return;
    onAirTimer = setInterval(() => void loadOnAir(), 6000);
  };

  /**
   * What is live on the server you are connected to.
   *
   * Its own stream -- the playlist it is serving, which is what it is listed
   * in the directory as -- and anybody publishing into it from OBS or a phone.
   * A row is worth clicking: the server's plays what it is playing, and a
   * channel's plays that channel.
   */
  async function loadOnAir(): Promise<void> {
    if (mode !== "remote") {
      dom.onairPanel.hidden = true;
      return;
    }
    let air: OnAir;
    try {
      const answer = await fetch(remote.url("/api/streams"));
      if (!answer.ok) {
        dom.onairPanel.hidden = true;
        return;
      }
      air = (await answer.json()) as OnAir;
      // The server's own name for itself, which is what the panels are
      // titled with: "Files on ubuntu" says where you are, "Playlist" did not.
      if (air.server.name && air.server.name !== serverName) {
        serverName = air.server.name;
        dom.onairPanel.dataset.title = `Live on ${serverName}`;
        updateFavHere();
        draw();
      }
    } catch {
      dom.onairPanel.hidden = true;
      return;
    }

    dom.onairPanel.hidden = false;
    // Part of the key, because the admin's buttons are part of the drawing:
    // learning you may drive this server is news even when nothing on the
    // air has changed.
    const key = `${dom.adminPanel.hidden ? "view" : "drive"}:${JSON.stringify(air)}`;
    if (key === drawnOnAir) return;
    drawnOnAir = key;

    const restreams = air.restreams ?? [];
    const others = air.channels.length + restreams.length;
    dom.onairNote.textContent = others === 0
      ? "One stream, from this server's own files."
      : `${others + 1} streams: this server's own files, and ${others} more on it.`;

    const rows: HTMLElement[] = [];

    // The server's own stream, first, because it is the one that is always
    // there and the one the directory listing points at.
    // Whether anything is actually running is the thing worth saying first.
    // A stopped server used to advertise a live stream of a film nobody was
    // watching, and everybody who joined started it from the beginning on
    // their own -- which is not a stream, it is several private screenings.
    const running = air.server.playing;
    const canDrive = !dom.adminPanel.hidden;
    rows.push(onAirRow({
      title: air.server.name,
      detail: [
        running
          ? `playing ${air.server.nowPlaying}`
          : air.server.nowPlaying
            ? `stopped on ${air.server.nowPlaying}`
            : "nothing loaded",
        `${air.server.tracks} track${air.server.tracks === 1 ? "" : "s"}`,
        air.server.code ? `☎ ${air.server.code}` : "not listed",
      ].join(" · "),
      // Joining, not starting your own copy. Everybody pointed at this sees
      // whatever the server is playing, from where it has got to.
      //
      // With nothing running there is nothing to join, so somebody who can
      // drive this server is offered the thing that would fix that instead.
      playLabel: running ? "Join live" : canDrive ? "Start the stream" : "Nothing playing",
      onPlay: () => {
        if (running) {
          void joinLive(air.server.nowPlaying);
          return;
        }
        if (canDrive) void startTheStream();
      },
      link: air.server.live ? air.server.url : "",
      // The stream itself, for VLC or mpv or a <video> on some other page.
      direct: running ? remote.url("/api/live") : "",
    }));

    // Anything re-streamed into this server. These used to sit in the middle
    // of the playlist among the files, which is what made moving between a
    // channel and an album so confusing: they are different kinds of thing and
    // were in one list.
    for (const restream of restreams) {
      rows.push(onAirRow({
        title: restream.name,
        detail: restream.tracks === 1
          ? "re-streamed from the web"
          : `re-streamed from the web · ${restream.tracks} tracks`,
        onPlay: () => { void playAt(restream.at); },
        link: "",
        direct: remote.media(restream.at),
      }));
    }

    for (const channel of air.channels) {
      const withPicture = channel.kind !== "audio";
      // A channel is its own address, so playing it is pointing the player
      // at that rather than at a track number -- and that address is the
      // whole reason two of these can play in two tabs at once.
      const address = remote.url(`/api/channels/${encodeURIComponent(channel.id)}`);
      const detail = [
        channel.via === "pull"
          ? `on the air · ${channel.listeners} watching`
          : `live over ${channel.via} · ${channel.listeners} listening`,
      ];
      // How it has been going. A source that keeps dropping is worth knowing
      // about, and the last thing ffmpeg said is for whoever can act on it.
      if (channel.redials) detail.push(`redialled ${channel.redials}×`);
      if (canDrive && channel.error) detail.push(channel.error);
      rows.push(onAirRow({
        title: channel.name,
        detail: detail.join(" · "),
        onPlay: () => {
          void watchChannel({ id: channel.id, name: channel.name, video: withPicture });
        },
        link: address,
        direct: address,
        // Taking something off the air, or dialling its source again, is
        // administering the server, so those are only there for somebody
        // who may. Restarting is for what this server fetches itself: a
        // publisher's stream restarts at the publisher's end.
        onRestart: canDrive && channel.via === "pull"
          ? () => { void restartChannel(channel.id, channel.name); }
          : undefined,
        onStop: canDrive
          ? () => { void removeChannel(channel.id, channel.name); }
          : undefined,
      }));
    }
    dom.onairList.replaceChildren(...rows);
  }

  /**
   * Watch what the server is playing, from where it has got to.
   *
   * One address that keeps playing: the track changes under it when the
   * server moves on, so a room stays together instead of drifting apart.
   */
  /**
   * Whether the last failure was a stream asking to be paid for.
   *
   * A media element reports "it would not play" and nothing else -- it cannot
   * hand back a status -- so the address is asked again plainly. A 402 is the
   * server saying this stream is busy enough to charge for, which is a
   * different thing from a broken file and deserves different words.
   */
  async function whyItWouldNotPlay(): Promise<void> {
    if (mode !== "remote") return;
    try {
      const answer = await fetch(remote.media(at(), rung), { method: "GET", headers: { range: "bytes=0-1" } });
      if (answer.status !== 402) return;
      note = meId === ""
        ? "This stream is busy enough to be charging for. Sign in to nixamp.com to pay for a pass."
        : "This stream is charging for a pass. Follow the payment prompt to keep listening.";
      if (meId === "") dom.accountPanel.scrollIntoView({ behavior: "smooth", block: "center" });
      draw();
    } catch {
      // Unreachable is a different problem, and already reported.
    }
  }

  /**
   * Make the server play, so there is something to be in sync with.
   *
   * The room watches what the server is playing. Nothing was ever telling it
   * to play: "Play on this device" is on by default, so choosing a track
   * started it in your own browser and left the server stopped -- and a
   * stopped server has no position, so everybody who joined began at zero,
   * alone. This is the missing half.
   */
  async function startTheStream(): Promise<void> {
    said("Starting the stream on the server…");
    try {
      await remote.send({ type: "play", index: Math.max(0, at()) });
    } catch {
      said("could not reach the server");
      return;
    }
    // Watched from here the same way everybody else watches it, so what you
    // see is what the room sees rather than a private copy that drifts.
    await joinLive(snapshot.tracks[at()]?.title ?? "");
    said("Playing to the room. Anybody with the view link sees this.");
    await loadOnAir();
  }

  async function joinLive(title: string): Promise<void> {
    // Ours to follow, not the server's cursor: joining is a thing this device
    // is doing, and it should not look like the server moved.
    watching = -1;
    channelOn = null;
    await player.load({
      title: title || "Live", artist: "", album: "", duration: 0,
      url: remote.url("/api/live"),
      // The server decides what it sends; a film comes with its picture, and
      // the element that can show one can also play a song.
      video: true,
      objectUrl: false,
    }, true);
    showVideo(true);
    note = "Watching what this server is playing. Everyone here sees the same thing.";
    draw();
  }

  /**
   * Watch a channel: a live thing with its own address on this server.
   *
   * Fresh means a person chose it, which clears the count of rejoins; a
   * rejoin after the server dialled its source again is not fresh, and five
   * of those in a row without the picture ever settling means it is gone.
   */
  async function watchChannel(
    channel: { id: string; name: string; video: boolean },
    fresh = true,
  ): Promise<void> {
    watching = -1;
    channelOn = channel;
    if (fresh) rejoins = 0;
    await player.load({
      title: channel.name, artist: "", album: "", duration: 0,
      url: remote.url(`/api/channels/${encodeURIComponent(channel.id)}`),
      video: channel.video, objectUrl: false,
    }, true);
    showVideo(channel.video);
    note = `Watching ${channel.name}, live on this server.`;
    draw();
  }

  /**
   * The channel ended under us. Come back to it: a live channel's stream
   * ends when the server dials its source again, and the only sensible thing
   * to do with a new beginning is to join it. True when this was a channel
   * and something has been done about it, so the caller leaves it alone.
   */
  function rejoinChannel(): boolean {
    const channel = channelOn;
    if (!channel) return false;
    if (rejoinTimer) return true;
    if (rejoins >= 5) {
      note = `${channel.name} stopped, and did not come back.`;
      channelOn = null;
      draw();
      return true;
    }
    rejoins += 1;
    note = `${channel.name} started over; rejoining…`;
    draw();
    rejoinTimer = setTimeout(() => {
      rejoinTimer = null;
      if (channelOn === channel) void watchChannel(channel, false);
    }, 2000);
    return true;
  }

  async function restartChannel(id: string, name: string): Promise<void> {
    said(`Restarting ${name}…`);
    try {
      const answer = await fetch(remote.url(`/api/channels/${encodeURIComponent(id)}/restart`), {
        method: "POST",
      });
      const body = (await answer.json().catch(() => ({}))) as { error?: string };
      said(answer.ok ? `${name} is dialling its source again.` : (body.error ?? "that did not work"));
    } catch {
      said("could not reach the server");
    }
    drawnOnAir = "";
    void loadOnAir();
  }

  async function removeChannel(id: string, name: string): Promise<void> {
    try {
      const answer = await fetch(remote.url(`/api/channels/${encodeURIComponent(id)}`), { method: "DELETE" });
      said(answer.ok ? `${name} is off the air.` : "that did not work");
    } catch {
      said("could not reach the server");
    }
    // Nothing to rejoin: it was taken off on purpose.
    if (channelOn?.id === id) {
      channelOn = null;
      player.stop();
    }
    drawnOnAir = "";
    void loadOnAir();
  }

  /** Onto the clipboard, and the button says so for a moment. */
  async function copyText(text: string, button: HTMLButtonElement, done = "Copied"): Promise<void> {
    if (!text) return;
    const was = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard here -- an http origin, or a browser that asks first --
      // so show it instead, where it can be selected and copied by hand.
      note = text;
      draw();
      return;
    }
    button.textContent = done;
    setTimeout(() => { button.textContent = was; }, 1200);
  }

  /** One row of what is live: what it is, and the things you can do to it. */
  function onAirRow(row: {
    title: string; detail: string; onPlay: () => void; link: string; playLabel?: string;
    /** The stream's own address, for VLC, mpv, or a <video> somewhere else. */
    direct?: string;
    onRestart?: () => void;
    onStop?: () => void;
  }): HTMLElement {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "recent-label";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.title;
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = row.detail;
    label.append(name, detail);

    const play = document.createElement("button");
    play.type = "button";
    play.className = "button";
    play.textContent = row.playLabel ?? "Play";
    play.addEventListener("click", row.onPlay);
    item.append(label, play);

    // Only when there is a link worth copying: an unlisted server has no
    // address to hand anybody, and a button that copies nothing is a lie.
    if (row.link) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost";
      copy.textContent = "Copy link";
      copy.title = "A link that opens this in the player";
      copy.addEventListener("click", () => {
        const here = globalThis.location.origin;
        const full = row.link.startsWith("https://")
          ? `${here}/?url=${encodeURIComponent(row.link)}`
          : row.link;
        void copyText(full, copy);
      });
      item.append(copy);
    }

    // The stream itself, as distinct from a page that plays it: what you
    // paste into VLC, or into a <video> on a page of your own.
    if (row.direct) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost";
      copy.textContent = "Copy URL";
      copy.title = "The stream's own address, for VLC or mpv";
      copy.addEventListener("click", () => { void copyText(row.direct ?? "", copy); });
      item.append(copy);
    }

    if (row.onRestart) {
      const restart = document.createElement("button");
      restart.type = "button";
      restart.className = "ghost";
      restart.textContent = "Restart";
      restart.title = "Dial the source again";
      restart.addEventListener("click", row.onRestart);
      item.append(restart);
    }

    if (row.onStop) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "ghost";
      stop.textContent = "Remove";
      stop.title = "Take it off the air";
      stop.addEventListener("click", row.onStop);
      item.append(stop);
    }
    return item;
  }

  /**
   * The way back to a server's own files.
   *
   * Replacing the playlist with a stream leaves nothing pointing at the
   * library the server was started on -- and its address is a path on a
   * machine you may never have logged into, so there was no way back short of
   * restarting the daemon. It is one button, and it adds rather than replaces,
   * so whatever you were watching stays where it is.
   */
  let home = "";
  function drawHome(source: string, currentRoot: string): void {
    home = source;
    const loaded = source !== "" && currentRoot === source;
    dom.loadHome.hidden = source === "";
    dom.homeNote.hidden = source === "";
    if (source === "") return;
    dom.homeNote.textContent = loaded
      ? `This server's own files: ${source}`
      : `This server's own files are ${source}, and are not in the playlist.`;
    dom.loadHome.disabled = false;
  }

  dom.loadHome.addEventListener("click", () => {
    if (home === "") return;
    dom.loadHome.disabled = true;
    said("Reading this server's files…");
    void (async () => {
      try {
        const answer = await fetch(remote.url("/api/source"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Added, never replaced: you asked for the library back, not for
          // whatever you were watching to be thrown away.
          body: JSON.stringify({ source: home }),
        });
        const body = (await answer.json()) as { error?: string; added?: number };
        said(!answer.ok
          ? (body.error ?? "that did not work")
          : body.added === 0
            ? "This server's files are already in the playlist."
            : `Loaded ${body.added ?? 0} of this server's own files.`);
      } catch {
        said("could not reach the server");
      } finally {
        dom.loadHome.disabled = false;
      }
    })();
  });

  const setLive = async (on: boolean): Promise<void> => {
    dom.goLive.disabled = true;
    dom.stopLive.disabled = true;
    dom.shareNote.textContent = on ? "Going live…" : "Taking it off the list…";
    try {
      const answer = await fetch(remote.url(on ? "/api/live/start" : "/api/live/stop"), { method: "POST" });
      const body = (await answer.json()) as { error?: string; code?: string };
      dom.shareNote.textContent = !answer.ok
        ? (body.error ?? "that did not work")
        : on
          ? `Live. Anyone can call and key ${body.code ?? ""} to talk about it.`
          : "Taken off the list. The link still works for anybody who has it.";
    } catch {
      dom.shareNote.textContent = "could not reach the server";
    } finally {
      dom.goLive.disabled = false;
      dom.stopLive.disabled = false;
      await loadShare();
    }
  };

  dom.goLive.addEventListener("click", () => void setLive(true));
  dom.stopLive.addEventListener("click", () => void setLive(false));

  /** A span, because textContent on a parent would wipe the siblings. */
  function boldly(text: string): HTMLElement {
    const b = document.createElement("b");
    b.textContent = text;
    return b;
  }

  dom.shareCopy.addEventListener("click", () => {
    dom.shareLink.select();
    void navigator.clipboard?.writeText(dom.shareLink.value).then(
      () => { dom.shareNote.textContent = "Copied. Send it to anybody."; },
      () => { dom.shareNote.textContent = "Copy it from the box above."; },
    );
  });

  dom.shareSend.addEventListener("submit", (event) => {
    event.preventDefault();
    const to = dom.shareTo.value.trim();
    if (to === "") return;
    void (async () => {
      dom.shareNote.textContent = "Sending…";
      try {
        const answer = await fetch("/api/v1/invite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to, stream: remote.shareLink }),
        });
        const body = (await answer.json()) as { error?: string; sent?: string };
        dom.shareNote.textContent = answer.ok
          ? `Sent to ${body.sent ?? to}.`
          : (body.error ?? "that did not send");
        if (answer.ok) dom.shareTo.value = "";
      } catch {
        dom.shareNote.textContent = "could not send that";
      }
    })();
  });

  dom.listenHere.addEventListener("change", () => {
    try {
      localStorage.setItem(LISTEN_HERE_KEY, dom.listenHere.checked ? "1" : "0");
    } catch { /* private mode */ }
    if (mode !== "remote") return;
    void (async () => {
      if (dom.listenHere.checked) {
        // "on this device" means instead of over there, not as well as.
        await remote.send({ type: "stop" });
        // Start from wherever the server had got to, then go our own way.
        await listenTo(snapshot.index);
      } else {
        player.stop();
        // Back to following the server's cursor.
        watching = -1;
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
    // Only an explicit "no" turns it off; an absent setting keeps the default.
    if (localStorage.getItem(LISTEN_HERE_KEY) === "0") dom.listenHere.checked = false;
  } catch { /* private mode */ }

  // Served by a nixamp of its own? Then it has a library to show — but only
  // if there is one. The hosted copy at nixamp.com serves the same files with
  // nothing behind them, and taking that over as a "remote" would be a lie.
  void (async () => {
    if (dom.remoteUrl.value !== "") return;
    const here = globalThis.location.origin;
    if (await probeServer(here) === null) return;
    const snapshot = await fetchSnapshot(here);
    if (!snapshot || snapshot.trackCount === 0) return;
    dom.remoteUrl.value = here;
    mode = "remote";
    // The hint about picking files has been answered by the server itself.
    note = "";
    remote.connect(here);
    draw();
  })();

  // The noise it makes when it wakes up.
  //
  // Played straight away if the browser allows it. Most will not without
  // something from the person first -- an autoplaying page is a thing browsers
  // spent a decade learning to refuse -- so a refusal arms it to go on the
  // first click or keypress instead, once, and then never again this session.
  void (() => {
    if (jingled) return;

    // One of however many ship, at random. The list is written by the build
    // from whatever is in the folder, so another one is a file to drop in
    // rather than a line to remember to change.
    const chosen = async (): Promise<string> => {
      try {
        const answer = await fetch("/jingles/index.json");
        const names = (await answer.json()) as unknown;
        if (Array.isArray(names) && names.length > 0) {
          const pick = names[Math.floor(Math.random() * names.length)];
          if (typeof pick === "string") return `/jingles/${pick}`;
        }
      } catch {
        // An older build, or a host serving only the app. Nothing to play.
      }
      return "";
    };

    const jingle = new Audio();
    jingle.volume = 0.7;
    const spend = (): void => {
      jingled = true;
    };
    const armed = (): void => {
      document.removeEventListener("pointerdown", armed);
      document.removeEventListener("keydown", armed);
      spend();
      void jingle.play().catch(() => {});
    };

    void chosen().then((src) => {
      if (src === "") return;
      jingle.src = src;
      return jingle.play().then(
        spend,
        () => {
          // Refused, which is ordinary. Wait for the first thing they do.
          document.addEventListener("pointerdown", armed, { once: true });
          document.addEventListener("keydown", armed, { once: true });
        },
      );
    });
  })();

  draw();
  requestAnimationFrame(frame);
}
