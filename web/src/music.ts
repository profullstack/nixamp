/**
 * nixamp.com/music: the AI label's music, all in one place.
 *
 * One page with real addresses (/music, /music/genre/<g>, /music/artist/<server>/<key>,
 * /music/album/<server>/<artist>/<album>, /music/me), drawn from /api/v1/music (every
 * server's catalogue, gathered by nixamp.com). The player at the bottom keeps playing
 * a station while you browse; listening is free, files are bought on /buy.
 */
import "./music.css";

interface Member { slug: string; name: string; role: string; bio: string }
interface Song { n: number; title: string; seconds: number; lyrics?: string }
interface Album { key: string; title: string; year: number; concept: string; cover: boolean; complete: boolean; songs: Song[] }
interface Artist { server: string; key: string; name: string; genre: string; bio: string; follow: string; members?: Member[]; albums: Album[] }
interface Station { server: string; id: string; name: string; state: string; listen: string; token: string; nowPlaying: { title: string; artist: string } | null }
interface Catalogue { holders: string[]; genres: Array<{ genre: string; stations: Station[]; artists: Artist[] }>; stations: Station[] }

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector(selector) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | boolean> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(typeof child === "string" ? document.createTextNode(child) : child);
  return node;
}

function say(text: string): void {
  $("#sr-status").textContent = text;
}

const slug = (text: string): string => text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const file = (server: string, path: string): string => `/api/v1/music/file/${server}/${path}`;
const coverOf = (artist: Artist, album: Album): string => (album.cover ? file(artist.server, `${artist.key}/${album.key}/cover.jpg`) : "");
const portraitOf = (artist: Artist, member: Member): string => file(artist.server, `${artist.key}/members/${member.slug}.jpg`);
const artistHref = (artist: Artist): string => `/music/artist/${artist.server}/${artist.key}`;
const albumHref = (artist: Artist, album: Album): string => `/music/album/${artist.server}/${artist.key}/${album.key}`;
const memberHref = (artist: Artist, member: Member): string => `/music/member/${artist.server}/${artist.key}/${member.slug}`;
const buyHref = (artist: Artist, kind: "song" | "album" | "artist", album = "", n = 0): string =>
  `/buy?${new URLSearchParams({ server: artist.server, kind, artist: artist.key, ...(kind !== "artist" ? { album } : {}), ...(kind === "song" ? { n: String(n) } : {}) })}`;

/** An artist's picture: the newest album's cover, else the first member's portrait. */
function artOf(artist: Artist): string {
  const album = [...artist.albums].find((one) => one.cover);
  if (album) return coverOf(artist, album);
  const member = artist.members?.[0];
  return member ? portraitOf(artist, member) : "";
}

function picture(src: string, alt = ""): HTMLElement {
  return src ? el("img", { src, alt, loading: "lazy", decoding: "async", width: "200", height: "200" }) : el("div", { class: "blank", "aria-hidden": "true" });
}

let catalogue: Promise<Catalogue> | null = null;
function load(): Promise<Catalogue> {
  catalogue ??= fetch("/api/v1/music").then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<Catalogue>; })
    .catch((error: unknown) => { catalogue = null; throw error; });
  return catalogue;
}

const allArtists = (data: Catalogue): Artist[] => data.genres.flatMap((one) => one.artists);
const stationFor = (data: Catalogue, genre: string): Station | undefined => data.genres.find((one) => one.genre === genre)?.stations[0];

/* ---- views ---------------------------------------------------------------- */

function stationCard(station: Station): HTMLElement {
  const card = el("button", { type: "button", class: "card" },
    el("span", { class: "live" }, station.state === "live" ? "● LIVE" : "OFF THE AIR"),
    el("strong", {}, station.name.replace(/^Profullstack AI · /, "")),
    el("small", {}, station.nowPlaying ? [station.nowPlaying.title, station.nowPlaying.artist].filter(Boolean).join(" · ") : "Free, with a short break every 10 minutes"),
  );
  card.addEventListener("click", () => play(station));
  return card;
}

function artistCard(artist: Artist): HTMLElement {
  return el("a", { class: "card", href: artistHref(artist) }, picture(artOf(artist)), el("strong", {}, artist.name), el("small", {}, artist.genre));
}

function home(data: Catalogue): HTMLElement[] {
  const out: HTMLElement[] = [
    el("h1", {}, "AI music, live and on demand"),
    el("p", { class: "lead" }, `Original bands and artists, written and sung by AI and released by ${data.holders.join(", ") || "Profullstack, Inc."}. Listen free on the live stations; follow the artists; buy the songs you love.`),
  ];
  if (data.stations.length) out.push(el("h2", {}, "Live now"), el("div", { class: "row" }, ...data.stations.map(stationCard)));
  for (const genre of data.genres) {
    if (!genre.artists.length) continue;
    out.push(el("h2", {}, el("a", { href: `/music/genre/${slug(genre.genre)}` }, genre.genre)), el("div", { class: "row" }, ...genre.artists.map(artistCard)));
  }
  if (!data.genres.length) out.push(el("p", { class: "empty" }, "The first albums are being recorded. Check back soon."));
  return out;
}

function genreView(data: Catalogue, name: string): HTMLElement[] {
  const genre = data.genres.find((one) => slug(one.genre) === name);
  if (!genre) return notFound();
  document.title = `${genre.genre} · nixamp music`;
  return [
    el("p", { class: "crumbs" }, el("a", { href: "/music" }, "Music"), " / ", genre.genre),
    el("h1", {}, genre.genre),
    ...(genre.stations.length ? [el("h2", {}, "Live"), el("div", { class: "row" }, ...genre.stations.map(stationCard))] : []),
    el("h2", {}, "Artists"),
    el("div", { class: "grid" }, ...genre.artists.map(artistCard)),
  ];
}

/** Follow / Following, from the signed-in account; signed out, a way in that comes back here. */
function followButton(artist: Artist): HTMLElement {
  const button = el("button", { type: "button", class: "btn ghost", "aria-pressed": "false" }, "Follow");
  const id = encodeURIComponent(artist.follow);
  void fetch(`/api/v1/follows/${id}`).then(async (r) => {
    if (r.status === 401) { button.dataset["out"] = "1"; return; }
    if (r.ok && ((await r.json()) as { following?: boolean }).following) { button.setAttribute("aria-pressed", "true"); button.textContent = "Following"; }
  }).catch(() => undefined);
  button.addEventListener("click", () => {
    if (button.dataset["out"]) { location.assign(`/?redirect=${encodeURIComponent(location.pathname)}#account-panel`); return; }
    const on = button.getAttribute("aria-pressed") !== "true";
    button.disabled = true;
    void fetch(`/api/v1/follows/${id}`, { method: on ? "PUT" : "DELETE" }).then((r) => {
      if (r.status === 401) { location.assign(`/?redirect=${encodeURIComponent(location.pathname)}#account-panel`); return; }
      if (!r.ok) return;
      button.setAttribute("aria-pressed", String(on));
      button.textContent = on ? "Following" : "Follow";
      say(on ? `Following ${artist.name}. You will hear when they release something.` : `No longer following ${artist.name}.`);
    }).finally(() => { button.disabled = false; });
  });
  return button;
}

function listenLive(data: Catalogue, artist: Artist): HTMLElement | null {
  const station = stationFor(data, artist.genre);
  if (!station) return null;
  const button = el("button", { type: "button", class: "btn" }, `▶ Listen live: ${artist.genre}`);
  button.addEventListener("click", () => play(station));
  return button;
}

function artistView(data: Catalogue, server: string, key: string): HTMLElement[] {
  const artist = allArtists(data).find((one) => one.server === server && one.key === key);
  if (!artist) return notFound();
  document.title = `${artist.name} · nixamp music`;
  const albums = [...artist.albums].sort((a, b) => b.year - a.year);
  return [
    el("p", { class: "crumbs" }, el("a", { href: "/music" }, "Music"), " / ", el("a", { href: `/music/genre/${slug(artist.genre)}` }, artist.genre)),
    el("div", { class: "hero" }, picture(artOf(artist), ""),
      el("div", {},
        el("div", { class: "kind" }, artist.members && artist.members.length > 1 ? "Band" : "Artist"),
        el("h1", {}, artist.name),
        artist.bio ? el("p", { class: "lead" }, artist.bio) : null,
        el("div", { class: "actions" }, listenLive(data, artist), followButton(artist), el("a", { class: "btn ghost", href: buyHref(artist, "artist") }, "Download everything · $2")),
      ),
    ),
    ...(artist.members?.length ? [
      el("h2", {}, artist.members.length > 1 ? "The band" : "Who"),
      el("ul", { class: "members" }, ...artist.members.map((member) => el("li", {},
        el("a", { href: memberHref(artist, member) }, el("img", { src: portraitOf(artist, member), alt: "", width: "64", height: "64", loading: "lazy" })),
        el("div", {}, el("a", { href: memberHref(artist, member) }, el("strong", {}, member.name)), el("span", {}, member.role)),
      ))),
    ] : []),
    el("h2", {}, "Discography"),
    albums.length
      ? el("div", { class: "grid" }, ...albums.map((album) => el("a", { class: "card", href: albumHref(artist, album) }, picture(coverOf(artist, album)), el("strong", {}, album.title), el("small", {}, `${album.year} · ${album.songs.length} songs${album.complete ? "" : " · recording"}`))))
      : el("p", { class: "empty" }, "The first album is being recorded."),
  ];
}

function albumView(data: Catalogue, server: string, key: string, albumKey: string): HTMLElement[] {
  const artist = allArtists(data).find((one) => one.server === server && one.key === key);
  const album = artist?.albums.find((one) => one.key === albumKey);
  if (!artist || !album) return notFound();
  document.title = `${album.title} by ${artist.name} · nixamp music`;
  const length = album.songs.reduce((sum, one) => sum + one.seconds, 0);
  return [
    el("p", { class: "crumbs" }, el("a", { href: "/music" }, "Music"), " / ", el("a", { href: artistHref(artist) }, artist.name)),
    el("div", { class: "hero" }, picture(coverOf(artist, album), `Cover of ${album.title}`),
      el("div", {},
        el("div", { class: "kind" }, "Album"),
        el("h1", {}, album.title),
        el("p", { class: "lead" }, el("a", { href: artistHref(artist) }, artist.name), ` · ${album.year} · ${album.songs.length} songs, ${clock(length)}${album.complete ? "" : " · still recording"}`),
        album.concept ? el("p", { class: "lead" }, album.concept) : null,
        el("div", { class: "actions" }, listenLive(data, artist), el("a", { class: "btn ghost", href: buyHref(artist, "album", album.key) }, "Download the album · $1")),
      ),
    ),
    el("ol", { class: "tracks" }, ...album.songs.map((song) => el("li", {},
      el("div", { class: "track" },
        el("span", { class: "n" }, String(song.n)),
        el("span", {}, song.title),
        el("span", { class: "t" }, clock(song.seconds)),
        el("a", { class: "buy", href: buyHref(artist, "song", album.key, song.n) }, "10¢"),
      ),
      song.lyrics ? el("details", { class: "words" }, el("summary", {}, "Lyrics"), el("pre", {}, song.lyrics)) : null,
    ))),
    el("p", { class: "muted" }, "Every song plays free on the live station. A download is the MP3s with the cover art and lyrics, yours to keep."),
  ];
}

interface Bought { id: string; kind: string; title: string; artistName: string; paidAt: number; zip?: string; link?: string }

async function meView(): Promise<HTMLElement[]> {
  document.title = "My music · nixamp";
  const out: HTMLElement[] = [el("h1", {}, "My music")];
  const bought = await fetch("/api/v1/store/purchases");
  if (bought.status === 401) {
    out.push(el("p", { class: "lead" }, "Sign in to see what you bought and who you follow."),
      el("div", { class: "actions" }, el("a", { class: "btn", href: `/?redirect=${encodeURIComponent("/music/me")}#account-panel` }, "Sign in with nixamp"),
        el("a", { class: "btn ghost", href: `/api/v1/coinpay/oauth/start?redirect=${encodeURIComponent("/music/me")}` }, "Sign in with CoinPay")));
    return out;
  }
  const body = (await bought.json().catch(() => ({}))) as { purchases?: Bought[] };
  out.push(el("h2", {}, "Bought"));
  out.push(body.purchases?.length
    ? el("div", { class: "list" }, ...body.purchases.map((one) => el("div", { class: "item" },
      el("div", { class: "grow" }, el("strong", {}, one.title), el("div", { class: "muted" }, `${one.artistName} · ${one.kind} · ${new Date(one.paidAt).toLocaleDateString()}`)),
      one.zip ? el("a", { class: "btn", href: one.zip }, "Download") : null,
      one.link ? el("a", { class: "btn ghost", href: one.link }, "Receipt") : null)))
    : el("p", { class: "empty" }, "Nothing yet: every album page has a Download button."));
  const follows = await fetch("/api/v1/follows").then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as { following?: string[] };
  const data = await load().catch(() => null);
  const followed = (follows.following ?? []).filter((one) => one.startsWith("artist:"));
  out.push(el("h2", {}, "Following"));
  const artists = data ? allArtists(data).filter((one) => followed.includes(one.follow)) : [];
  out.push(artists.length ? el("div", { class: "grid" }, ...artists.map(artistCard)) : el("p", { class: "empty" }, "Follow an artist to hear when they release something."));
  return out;
}

interface MemberProfile {
  name: string; role: string; job: string; band: { name: string; url: string }; avatar: string;
  bio: string; look: string; voice: string; personality: string; influences: string; source: string;
}

/** A band member's OpenProfile as a page: their photo, what they do in the band, who they are. */
async function memberView(data: Catalogue, server: string, key: string, who: string): Promise<HTMLElement[]> {
  const artist = allArtists(data).find((one) => one.server === server && one.key === key);
  const member = artist?.members?.find((one) => one.slug === who);
  if (!artist || !member) return notFound();
  const json = `/api/v1/music/member/${server}/${key}/${who}.json`;
  const answer = await fetch(json).catch(() => null);
  const profile = answer?.ok ? (await answer.json()) as MemberProfile : null;
  const role = profile?.role || member.role || "member";
  document.title = `${member.name} · ${role} in ${artist.name} · nixamp music`;
  const fact = (label: string, text: string | undefined): HTMLElement[] => (text ? [el("dt", {}, label), el("dd", {}, text)] : []);
  const facts = profile ? [...fact("Look", profile.look), ...fact(artist.members!.length > 1 && /vocal|sing/i.test(role) ? "Voice" : "Sound", profile.voice), ...fact("Personality", profile.personality), ...fact("Influences", profile.influences)] : [];
  const others = artist.members!.filter((one) => one.slug !== who);
  return [
    el("p", { class: "crumbs" }, el("a", { href: "/music" }, "Music"), " / ", el("a", { href: artistHref(artist) }, artist.name)),
    el("div", { class: "hero" }, picture(portraitOf(artist, member), `${member.name}`),
      el("div", {},
        el("div", { class: "kind" }, `${role.charAt(0).toUpperCase()}${role.slice(1)} · `, el("a", { href: artistHref(artist) }, artist.name)),
        el("h1", {}, member.name),
        (profile?.bio || member.bio) ? el("p", { class: "lead" }, profile?.bio || member.bio) : null,
        el("div", { class: "actions" },
          listenLive(data, artist),
          followButton(artist),
          el("a", { class: "btn ghost", href: json, title: "This profile as OpenProfile JSON, for apps and agents" }, "JSON"),
          el("a", { class: "btn ghost", href: file(server, `${key}/members/${who}.md`), title: "The OpenProfile page this is read from" }, "OpenProfile source"),
        ),
      ),
    ),
    ...(facts.length ? [el("h2", {}, "About"), el("dl", { class: "facts" }, ...facts)] : []),
    ...(others.length ? [
      el("h2", {}, `Also in ${artist.name}`),
      el("ul", { class: "members" }, ...others.map((one) => el("li", {},
        el("a", { href: memberHref(artist, one) }, el("img", { src: portraitOf(artist, one), alt: "", width: "64", height: "64", loading: "lazy" })),
        el("div", {}, el("a", { href: memberHref(artist, one) }, el("strong", {}, one.name)), el("span", {}, one.role)),
      ))),
    ] : []),
    el("p", { class: "muted" }, "A fictional musician, made with AI. ", profile ? "" : "Their full profile did not load; try again in a moment."),
  ];
}

function notFound(): HTMLElement[] {
  return [el("h1", {}, "Not here"), el("p", { class: "lead" }, "That page is not in the catalogue (yet)."), el("a", { href: "/music" }, "Back to the music")];
}

/* ---- the player ------------------------------------------------------------- */

let playing: Station | null = null;
/** This page's stream, named so its server can say what the player is hearing (/clock). */
let nonce = "";
/** What the server said the player heard at a currentTime: the song's clock runs on from there. */
let clockSeen: { nonce: string; ct: number; position: number; duration: number; break: boolean; title: string } | null = null;
let clockAsked = 0;
/** The song the now-playing card shows; a different one on the clock refreshes it at once. */
let shownTitle = "";

interface SyncedLine { start: number; end: number; text: string; words: Array<{ start: number; end: number; text: string }> }
/** Karaoke in the lyrics panel: the timed lines, their elements, the line being sung, and which song they are. */
let karaoke: { lines: SyncedLine[]; els: HTMLElement[]; words: HTMLElement[][]; at: number; title: string } | null = null;

const audioEl = (): HTMLAudioElement => $<HTMLAudioElement>("#audio");
const q = (station: Station): string => `t=${encodeURIComponent(station.token)}`;

/** (Re)join the live stream, under a fresh name for the clock. */
function join(): void {
  if (!playing) return;
  nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  clockSeen = null;
  const audio = audioEl();
  audio.src = `${playing.listen}/stream?${q(playing)}&n=${nonce}`;
  void audio.play().catch(() => undefined);
  $("#player-toggle").textContent = "❚❚";
  $("#player-toggle").setAttribute("aria-label", "Pause");
}

function play(station: Station): void {
  playing = station;
  shownTitle = "";
  karaoke = null;
  join();
  $("#player").hidden = false;
  $("#player-title").textContent = station.nowPlaying?.title || station.name;
  $("#player-by").textContent = station.nowPlaying?.artist || station.name;
  say(`Playing ${station.name}`);
  void refreshNow();
}

/** Which second of which song the player is on, by its own currentTime: exact, whatever it has buffered. */
async function askClock(): Promise<void> {
  const audio = audioEl();
  const station = playing;
  const name = nonce;
  if (!station || !name || audio.paused || audio.readyState < 2) return;
  clockAsked = Date.now();
  const ct = audio.currentTime;
  try {
    const r = await fetch(`${station.listen}/clock?${q(station)}&n=${encodeURIComponent(name)}&ct=${ct.toFixed(3)}`, { cache: "no-store" });
    if (name !== nonce) return;
    if (!r.ok) { clockSeen = null; return; }
    const body = await r.json() as { position: number; duration: number; break: boolean; nowPlaying: { title: string } | null };
    clockSeen = { nonce: name, ct, position: body.position, duration: body.duration, break: body.break, title: body.nowPlaying?.title ?? "" };
    // A new song: its title, artist, cover and words now, not on the next round.
    if (clockSeen.title && clockSeen.title !== shownTitle) void refreshNow();
  } catch {
    // The estimate carries on until the next answer.
  }
}

const clockText = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** Ten times a second: the progress bar and the words, from the last clock and the player's own time since. */
function tick(): void {
  const audio = audioEl();
  const clock = clockSeen && clockSeen.nonce === nonce && !audio.paused ? clockSeen : null;
  const progress = $("#player-progress");
  if (!clock) { progress.hidden = true; $("#player-break").hidden = true; return; }
  const heard = clock.position + (audio.currentTime - clock.ct);
  // Past the song's end the player is on the next one: ask again (not more than once a second).
  if (clock.duration > 0 && heard > clock.duration && Date.now() - clockAsked > 1000) void askClock();
  $("#player-break").hidden = !clock.break;
  if (clock.break || clock.duration <= 0) { progress.hidden = true; return; }
  const at = Math.min(clock.duration, Math.max(0, heard));
  const bar = $<HTMLProgressElement>("#player-bar");
  bar.max = clock.duration;
  bar.value = at;
  bar.setAttribute("aria-valuetext", `${clockText(at)} of ${clockText(clock.duration)}`);
  $("#player-at").textContent = clockText(at);
  $("#player-length").textContent = clockText(clock.duration);
  progress.hidden = false;
  // The words light only for the song being heard: they may arrive a moment before it does.
  if (karaoke && (!karaoke.title || !clock.title || karaoke.title.trim().toLowerCase() === clock.title.trim().toLowerCase())) highlight(heard);
}

/** The line being sung, and its words as they are sung; Follow along keeps it in view inside the panel only. */
function highlight(heard: number): void {
  if (!karaoke) return;
  const { lines, els, words } = karaoke;
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i]!.start <= heard + 0.1) at = i;
  if (at >= 0 && at < karaoke.at && heard > lines[karaoke.at]!.start - 1) at = karaoke.at;
  if (at !== karaoke.at) {
    els.forEach((one, i) => { one.classList.toggle("now", i === at); one.classList.toggle("past", i < at); });
    karaoke.at = at;
    const panel = $("#lyrics-panel");
    if (at >= 0 && !panel.hidden && $<HTMLInputElement>("#lyrics-follow").checked) {
      const line = els[at]!;
      const top = line.offsetTop - panel.scrollTop;
      if (top < panel.clientHeight * 0.2 || top + line.clientHeight > panel.clientHeight * 0.6) panel.scrollTo({ top: Math.max(0, line.offsetTop - panel.clientHeight / 3), behavior: "smooth" });
    }
  }
  if (at >= 0) words[at]!.forEach((span, i) => span.classList.toggle("sung", lines[at]!.words[i]!.start <= heard));
}

interface Facts { title?: string; artist?: string; album?: string; art?: string; lyrics?: string }

/** What is on the station now: title, artist, cover, and the words (timed when the song has them). */
async function refreshNow(): Promise<void> {
  const station = playing;
  if (!station) return;
  const base = new URL(station.listen).origin;
  const answer = await fetch(`${station.listen}/now?${q(station)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { facts?: Facts | null } | null;
  const facts = answer?.facts;
  if (!facts || station !== playing) return;
  shownTitle = clockSeen?.title || facts.title || "";
  $("#player-title").textContent = facts.title || station.name;
  $("#player-by").textContent = [facts.artist, facts.album].filter(Boolean).join(" · ");
  const art = $<HTMLImageElement>("#player-art");
  if (facts.art && art.dataset["src"] !== facts.art) { art.dataset["src"] = facts.art; art.src = base + facts.art; }
  const panel = $("#lyrics-panel");
  if (facts.lyrics && panel.dataset["src"] !== facts.lyrics) {
    panel.dataset["src"] = facts.lyrics;
    const words = await fetch(base + facts.lyrics).then((r) => r.json()).catch(() => null) as { lyrics?: { title: string; text: string; synced?: SyncedLine[] } } | null;
    drawLyrics(words?.lyrics ?? null);
  } else if (!facts.lyrics) {
    delete panel.dataset["src"];
    drawLyrics(null);
  }
}

function drawLyrics(words: { title: string; text: string; synced?: SyncedLine[] } | null): void {
  $("#lyrics-title").textContent = words?.title ? `Lyrics · ${words.title}` : "Lyrics";
  const box = $("#lyrics-text");
  if (words?.synced?.length) {
    const els: HTMLElement[] = [];
    const spans: HTMLElement[][] = [];
    for (const line of words.synced) {
      const parts = line.words.map((word, i) => el("span", { class: "word" }, (i ? " " : "") + word.text));
      els.push(parts.length ? el("p", { class: "line" }, ...parts) : el("p", { class: "line" }, line.text));
      spans.push(parts);
    }
    box.replaceChildren(...els);
    box.classList.add("synced");
    karaoke = { lines: words.synced, els, words: spans, at: -1, title: words.title };
    $("#lyrics-follow-box").hidden = false;
    return;
  }
  karaoke = null;
  box.classList.remove("synced");
  $("#lyrics-follow-box").hidden = true;
  box.replaceChildren(...(words?.text ?? "No lyrics for this one.").split(/\n{2,}/).map((stanza) =>
    /^\[[^\]]+\]$/.test(stanza.trim()) ? el("p", { class: "section" }, stanza.trim().slice(1, -1)) : el("p", {}, stanza.replace(/^\[[^\]]+\]\n/, ""))));
}

const remember = (name: string, value: string): void => { try { localStorage.setItem(`nixamp.music.${name}`, value); } catch { /* fine */ } };
const recall = (name: string): string | null => { try { return localStorage.getItem(`nixamp.music.${name}`); } catch { return null; } };

function wirePlayer(): void {
  const audio = audioEl();
  $("#player-toggle").addEventListener("click", () => {
    if (!playing) return;
    if (audio.paused) join();
    else {
      // Live: paused is gone, and play rejoins where the station is now.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      clockSeen = null;
      $("#player-toggle").textContent = "▶";
      $("#player-toggle").setAttribute("aria-label", "Play");
    }
  });
  // Volume and mute, kept for next time.
  const volume = $<HTMLInputElement>("#player-volume");
  const mute = $<HTMLButtonElement>("#player-mute");
  const showMute = (): void => {
    mute.textContent = audio.muted || audio.volume === 0 ? "🔇" : audio.volume < 0.5 ? "🔉" : "🔊";
    mute.setAttribute("aria-pressed", String(audio.muted));
    mute.setAttribute("aria-label", audio.muted ? "Unmute" : "Mute");
  };
  const saved = Number(recall("volume") ?? "1");
  audio.volume = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  volume.value = String(audio.volume);
  audio.muted = recall("muted") === "1";
  showMute();
  volume.addEventListener("input", () => {
    audio.volume = Number(volume.value);
    if (audio.volume > 0 && audio.muted) audio.muted = false;
    remember("volume", volume.value);
    remember("muted", audio.muted ? "1" : "0");
    showMute();
  });
  mute.addEventListener("click", () => {
    audio.muted = !audio.muted;
    remember("muted", audio.muted ? "1" : "0");
    showMute();
  });
  $("#player-lyrics").addEventListener("click", () => {
    const panel = $("#lyrics-panel");
    panel.hidden = !panel.hidden;
    $("#player-lyrics").setAttribute("aria-expanded", String(!panel.hidden));
    if (karaoke) karaoke.at = -1;
  });
  // Follow along is the listener's: scrolling the words yourself turns it off.
  const follow = $<HTMLInputElement>("#lyrics-follow");
  follow.checked = recall("follow") !== "0";
  follow.addEventListener("change", () => remember("follow", follow.checked ? "1" : "0"));
  for (const kind of ["wheel", "touchmove"]) $("#lyrics-panel").addEventListener(kind, () => { if (follow.checked) { follow.checked = false; remember("follow", "0"); } }, { passive: true });
  audio.addEventListener("playing", () => void askClock());
  setInterval(() => void askClock(), 2000);
  setInterval(tick, 100);
  // A server without /clock (older) still gets its now-playing card refreshed.
  setInterval(() => { if (playing && !audio.paused && !clockSeen) void refreshNow(); }, 15_000);
}

/* ---- routing --------------------------------------------------------------- */

async function render(): Promise<void> {
  const view = $("#view");
  const parts = location.pathname.replace(/\/+$/, "").split("/").slice(2);
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) {
    const current = (link.dataset["nav"] === "me" && parts[0] === "me") || (link.dataset["nav"] === "home" && parts[0] !== "me");
    if (current) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  document.title = "Music · nixamp";
  let nodes: HTMLElement[];
  try {
    if (parts[0] === "me") nodes = await meView();
    else {
      const data = await load();
      nodes = parts[0] === "genre" && parts[1] ? genreView(data, parts[1])
        : parts[0] === "artist" && parts[2] ? artistView(data, parts[1]!, parts[2])
        : parts[0] === "album" && parts[3] ? albumView(data, parts[1]!, parts[2]!, parts[3])
        : parts[0] === "member" && parts[3] ? await memberView(data, parts[1]!, parts[2]!, parts[3])
        : parts.length === 0 ? home(data) : notFound();
    }
  } catch {
    nodes = [el("h1", {}, "The music did not load"), el("p", { class: "notice" }, "Try again in a moment.")];
  }
  view.replaceChildren(...nodes);
}

/** A click on a /music link is a page of this app: no reload, so the player keeps playing. */
function wireLinks(): void {
  document.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || link.target) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !/^\/music(\/|$)/.test(url.pathname)) return;
    event.preventDefault();
    if (url.pathname + url.search === location.pathname + location.search) return;
    history.pushState(null, "", url.pathname + url.search);
    void render().then(() => {
      // An explicit navigation: the new page starts at the top, focus on it.
      window.scrollTo(0, 0);
      $("#view").focus({ preventScroll: true });
    });
  });
  window.addEventListener("popstate", () => void render());
}

async function who(): Promise<void> {
  const me = await fetch("/api/v1/auth/me").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { account?: { email?: string } } | null;
  const email = me?.account?.email ?? "";
  $("#who").replaceChildren(...(email && !email.endsWith(".invalid") ? [email] : email ? ["Signed in"] : [el("a", { href: `/?redirect=${encodeURIComponent(location.pathname)}#account-panel` }, "Sign in")]));
}

wireLinks();
wirePlayer();
void who();
void render();
