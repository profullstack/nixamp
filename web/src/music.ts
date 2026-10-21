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
        el("img", { src: portraitOf(artist, member), alt: "", width: "64", height: "64", loading: "lazy" }),
        el("div", {}, el("strong", {}, member.name), el("span", {}, member.role),
          el("a", { href: file(artist.server, `${artist.key}/members/${member.slug}.md`), class: "muted" }, " profile")),
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

function notFound(): HTMLElement[] {
  return [el("h1", {}, "Not here"), el("p", { class: "lead" }, "That page is not in the catalogue (yet)."), el("a", { href: "/music" }, "Back to the music")];
}

/* ---- the player ------------------------------------------------------------- */

let playing: Station | null = null;
let nowTimer: ReturnType<typeof setInterval> | undefined;

function play(station: Station): void {
  const audio = $<HTMLAudioElement>("#audio");
  playing = station;
  audio.src = `${station.listen}/stream?t=${encodeURIComponent(station.token)}`;
  void audio.play().catch(() => undefined);
  $("#player").hidden = false;
  $("#player-title").textContent = station.nowPlaying?.title || station.name;
  $("#player-by").textContent = station.nowPlaying?.artist || station.name;
  $("#player-toggle").textContent = "❚❚";
  $("#player-toggle").setAttribute("aria-label", "Pause");
  say(`Playing ${station.name}`);
  clearInterval(nowTimer);
  void refreshNow();
  nowTimer = setInterval(() => void refreshNow(), 10_000);
}

interface Facts { title?: string; artist?: string; album?: string; art?: string; lyrics?: string }

/** What is on the station now: title, artist, cover; the words when the panel is open. */
async function refreshNow(): Promise<void> {
  if (!playing) return;
  const base = new URL(playing.listen).origin;
  const answer = await fetch(`${playing.listen}/now?t=${encodeURIComponent(playing.token)}`).then((r) => r.json()).catch(() => null) as { facts?: Facts | null } | null;
  const facts = answer?.facts;
  if (!facts) return;
  $("#player-title").textContent = facts.title || playing.name;
  $("#player-by").textContent = [facts.artist, facts.album].filter(Boolean).join(" · ");
  const art = $<HTMLImageElement>("#player-art");
  if (facts.art && art.dataset["src"] !== facts.art) { art.dataset["src"] = facts.art; art.src = base + facts.art; }
  const panel = $("#lyrics-panel");
  if (!panel.hidden && facts.lyrics && panel.dataset["src"] !== facts.lyrics) {
    panel.dataset["src"] = facts.lyrics;
    const words = await fetch(base + facts.lyrics).then((r) => r.json()).catch(() => null) as { lyrics?: { title: string; text: string } } | null;
    $("#lyrics-title").textContent = words?.lyrics?.title ? `Lyrics · ${words.lyrics.title}` : "Lyrics";
    $("#lyrics-text").replaceChildren(...(words?.lyrics?.text ?? "No lyrics for this one.").split(/\n{2,}/).map((stanza) =>
      /^\[[^\]]+\]$/.test(stanza.trim()) ? el("p", { class: "section" }, stanza.trim().slice(1, -1)) : el("p", {}, stanza.replace(/^\[[^\]]+\]\n/, ""))));
  }
}

function wirePlayer(): void {
  const audio = $<HTMLAudioElement>("#audio");
  $("#player-toggle").addEventListener("click", () => {
    if (!playing) return;
    if (audio.paused) {
      // Live: rejoin where the station is now, not where it was paused.
      audio.src = `${playing.listen}/stream?t=${encodeURIComponent(playing.token)}`;
      void audio.play().catch(() => undefined);
      $("#player-toggle").textContent = "❚❚";
      $("#player-toggle").setAttribute("aria-label", "Pause");
    } else {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      $("#player-toggle").textContent = "▶";
      $("#player-toggle").setAttribute("aria-label", "Play");
    }
  });
  $("#player-lyrics").addEventListener("click", () => {
    const panel = $("#lyrics-panel");
    panel.hidden = !panel.hidden;
    $("#player-lyrics").setAttribute("aria-expanded", String(!panel.hidden));
    delete panel.dataset["src"];
    if (!panel.hidden) void refreshNow();
  });
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
