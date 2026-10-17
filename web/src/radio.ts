/**
 * Library and Radio: the owner's console for what this server has and the
 * stations it runs.
 *
 * A page of its own beside the player, on the same origin, so it is driven by
 * the same key cookie the player's admin link set. Everything it shows comes
 * from /api/v1/library and /api/v1/stations; everything it writes into the
 * page that came from a file (titles, names, folders) goes in as text, never
 * as markup, because tags are whatever somebody's ripper put there.
 */
import "./styles.css";
import "./radio.css";

type Json = Record<string, unknown>;

interface Item {
  id: string;
  rel: string;
  state: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
}

interface Station {
  id: string;
  name: string;
  state: string;
  desired: string;
  visibility: string;
  listed: boolean;
  shuffle: boolean;
  repeat: boolean;
  bitrate: number;
  items: string[];
  listeners: number;
  error: string;
  excluded: string[];
  rights: { basis: string; note: string } | null;
  links: { page: string; stream: string; m3u: string };
}

interface Playlist {
  id: string;
  name: string;
  count: number;
  revision: number;
  items?: Item[];
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector(selector) as T;

/** An element, its attributes, and its children as nodes or text. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | boolean> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function say(text: string): void {
  $("#sr-status").textContent = text;
}

function notice(text: string): void {
  const box = $("#notice");
  box.textContent = text;
  box.hidden = text === "";
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new ApiError(response.status, String(parsed["code"] ?? response.status), String(parsed["error"] ?? `HTTP ${response.status}`));
  return parsed as T;
}

/** Run something the person asked for; say what went wrong in words if it did. */
async function act(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
    notice("");
  } catch (error) {
    notice(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clock(seconds: number): string {
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

const STATE_WORDS: Record<string, string> = {
  live: "Live", starting: "Starting", recovering: "Coming back", offline: "Offline", stopped: "Off the air",
};

/* ---- stations ------------------------------------------------------------ */

let stations: Station[] = [];
let editing: Station | null = null;

async function loadStations(): Promise<void> {
  const answer = await api<{ stations: Station[] }>("GET", "/api/v1/stations?limit=200");
  stations = answer.stations;
  drawStations();
}

function drawStations(): void {
  const list = $("#station-list");
  list.replaceChildren();
  if (stations.length === 0) {
    list.append(el("p", { class: "hint" }, "No stations yet. Make one below from a folder or a playlist."));
    return;
  }
  for (const station of stations) {
    const running = station.desired === "running";
    const shareable = station.visibility !== "private";
    const copy = el("button", { type: "button", class: "ghost", disabled: !shareable, title: shareable ? "Copy the listening link" : "Private: make it unlisted or public to share" }, "Copy link");
    copy.addEventListener("click", () => void act("Copy", async () => {
      await navigator.clipboard.writeText(station.links.page);
      say(`Link to ${station.name} copied`);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy link"; }, 1500);
    }));
    const toggle = el("button", { type: "button" }, running ? "Stop" : "Start");
    toggle.addEventListener("click", () => void act(running ? "Stop" : "Start", async () => {
      await api("POST", `/api/v1/stations/${station.id}/${running ? "stop" : "start"}`, {});
      say(`${station.name} ${running ? "stopped" : "started"}`);
      await loadStations();
    }));
    const skip = el("button", { type: "button", class: "ghost", disabled: station.state !== "live" }, "Skip");
    skip.addEventListener("click", () => void act("Skip", async () => {
      await api("POST", `/api/v1/stations/${station.id}/skip`, {});
      say("Skipped");
    }));
    const access = el("button", { type: "button", class: "ghost" }, "Who can listen…");
    access.addEventListener("click", () => openPublish(station));
    const remove = el("button", { type: "button", class: "ghost danger" }, "Delete");
    remove.addEventListener("click", () => void act("Delete", async () => {
      if (!confirm(`Delete the station "${station.name}"? Its files are not touched.`)) return;
      await api("DELETE", `/api/v1/stations/${station.id}`);
      say(`${station.name} deleted`);
      await loadStations();
    }));
    const retry = station.excluded.length
      ? el("button", { type: "button", class: "ghost" }, `Retry ${station.excluded.length} left out`)
      : null;
    retry?.addEventListener("click", () => void act("Retry", async () => {
      await api("POST", `/api/v1/stations/${station.id}/retry`, {});
      await loadStations();
    }));
    list.append(el("article", { class: "station", "aria-label": station.name },
      el("div", { class: "station-head" },
        el("span", { class: `state state-${station.state}` }, STATE_WORDS[station.state] ?? station.state),
        el("h3", {}, station.name),
        el("span", { class: "muted" }, `${station.visibility}${station.listed ? ", listed" : ""}`),
      ),
      el("p", { class: "muted" },
        `${station.items.length} files · ${station.shuffle ? "shuffle" : "in order"} · ${station.repeat ? "repeating" : "once"} · ${station.bitrate} kbps · ${station.listeners} listening`,
      ),
      station.error && station.state !== "live" ? el("p", { class: "warn" }, station.error) : null,
      shareable ? el("p", { class: "link" }, el("a", { href: station.links.page, target: "_blank", rel: "noopener" }, "Open the listening page")) : null,
      el("div", { class: "actions" }, toggle, skip, copy, access, retry, remove),
    ));
  }
}

function openPublish(station: Station): void {
  editing = station;
  const form = $<HTMLFormElement>("#publish-form");
  (form.elements.namedItem("visibility") as RadioNodeList).value = station.visibility;
  (form.elements.namedItem("listed") as HTMLInputElement).checked = station.visibility === "public" ? station.listed : true;
  (form.elements.namedItem("basis") as HTMLSelectElement).value = station.rights?.basis ?? "";
  (form.elements.namedItem("note") as HTMLInputElement).value = station.rights?.note ?? "";
  syncPublic();
  $<HTMLDialogElement>("#publish-dialog").showModal();
}

function syncPublic(): void {
  const form = $<HTMLFormElement>("#publish-form");
  $("#public-only").hidden = (form.elements.namedItem("visibility") as RadioNodeList).value !== "public";
}

async function savePublish(): Promise<void> {
  if (!editing) return;
  const form = $<HTMLFormElement>("#publish-form");
  const visibility = (form.elements.namedItem("visibility") as RadioNodeList).value;
  const basis = (form.elements.namedItem("basis") as HTMLSelectElement).value;
  const note = (form.elements.namedItem("note") as HTMLInputElement).value;
  const answer = await api<{ dropped: number }>("POST", `/api/v1/stations/${editing.id}/access`, {
    visibility,
    listed: visibility === "public" && (form.elements.namedItem("listed") as HTMLInputElement).checked,
    ...(basis ? { rights: { basis, note } } : {}),
  });
  say(answer.dropped ? `Saved; ${answer.dropped} listeners disconnected` : "Saved");
  await loadStations();
}

/* ---- library ------------------------------------------------------------- */

let results: Item[] = [];
const selected = new Set<string>();
let playlists: Playlist[] = [];
let signedIn = true;

async function loadSummary(): Promise<void> {
  const summary = await api<{ items: number; counts: Record<string, number>; sources: Array<Json> }>("GET", "/api/v1/library");
  const counts = Object.entries(summary.counts).filter(([state, count]) => count > 0 && state !== "ready").map(([state, count]) => `${count} ${state}`);
  const running = summary.sources.some((one) => (one["lastScan"] as Json | null)?.["status"] === "running");
  $("#library-summary").textContent = `${summary.counts["ready"] ?? 0} ready to play${counts.length ? ` (${counts.join(", ")})` : ""}${running ? " · reading new files…" : ""}`;
  const sources = $("#sources");
  sources.replaceChildren();
  for (const source of summary.sources) {
    const scan = el("button", { type: "button", class: "ghost" }, "Scan again");
    scan.addEventListener("click", () => void act("Scan", async () => {
      await api("POST", `/api/v1/library/sources/${String(source["id"])}/scan`, {});
      say("Scanning");
      setTimeout(() => void loadSummary(), 1500);
    }));
    const last = source["lastScan"] as Json | null;
    sources.append(el("p", { class: "source" },
      el("code", {}, String(source["root"] ?? source["id"])),
      ` ${source["enabled"] ? "" : "(off) "}`,
      last ? el("span", { class: "muted" }, `last scan ${String(last["status"])}: ${String(last["found"])} found, ${String(last["probed"])} read`) : el("span", { class: "muted" }, "never scanned"),
      " ", scan,
    ));
  }
}

/** Only the latest search draws: an earlier one that answers late must not replace it. */
let asked = 0;

async function search(q: string): Promise<void> {
  const mine = ++asked;
  const answer = await api<{ items: Item[]; total: number }>("GET", `/api/v1/library/items?${new URLSearchParams({ q, limit: "100", sort: q ? "artist" : "recent" })}`);
  if (mine !== asked) return;
  results = answer.items;
  selected.clear();
  drawResults(answer.total);
}

function drawResults(total: number): void {
  const box = $("#results");
  box.replaceChildren();
  if (results.length === 0) {
    box.append(el("p", { class: "hint" }, "Nothing matches."));
    drawSelection();
    return;
  }
  const table = el("table", { class: "items" },
    el("caption", { class: "sr-only" }, "Library items"),
    el("thead", {}, el("tr", {},
      el("th", { scope: "col" }, el("span", { class: "sr-only" }, "Select")),
      el("th", { scope: "col" }, "Title"), el("th", { scope: "col" }, "Artist"), el("th", { scope: "col" }, "Album"), el("th", { scope: "col" }, "Time"),
      el("th", { scope: "col" }, el("span", { class: "sr-only" }, "Play")),
    )),
  );
  const body = el("tbody");
  for (const item of results) {
    const check = el("input", { type: "checkbox", "aria-label": `Select ${item.title}` }) as HTMLInputElement;
    check.addEventListener("change", () => {
      if (check.checked) selected.add(item.id); else selected.delete(item.id);
      drawSelection();
    });
    const play = el("button", { type: "button", class: "ghost", "aria-label": `Play ${item.title}` }, "▶");
    play.addEventListener("click", () => void playList([item.id], 0));
    body.append(el("tr", {},
      el("td", {}, check),
      el("td", { title: item.rel }, item.title),
      el("td", {}, item.artist),
      el("td", {}, item.album),
      el("td", { class: "muted" }, clock(item.duration)),
      el("td", {}, play),
    ));
  }
  table.append(body);
  box.append(table);
  if (total > results.length) box.append(el("p", { class: "muted" }, `Showing ${results.length} of ${total}. Narrow the search to see the rest.`));
  drawSelection();
}

function drawSelection(): void {
  $("#selection").hidden = selected.size === 0;
  $("#selection-count").textContent = `${selected.size} selected`;
  const into = $<HTMLSelectElement>("#add-to");
  into.replaceChildren(...playlists.map((one) => el("option", { value: one.id }, one.name)));
  $("#add-selection").toggleAttribute("disabled", playlists.length === 0);
  ($("#new-playlist") as HTMLButtonElement).disabled = !signedIn;
}

async function browse(kind: string): Promise<void> {
  const answer = await api<{ groups: Array<{ name: string; count: number; artist?: string }> }>("GET", `/api/v1/library/browse/${kind}?limit=500`);
  const box = $("#groups");
  box.replaceChildren();
  box.hidden = false;
  for (const group of answer.groups) {
    const chip = el("button", { type: "button", class: "group" }, `${group.name}${group.artist ? ` — ${group.artist}` : ""} (${group.count})`);
    chip.addEventListener("click", () => void act("Browse", async () => {
      const field = kind === "artists" ? "artist" : kind === "albums" ? "album" : kind === "genres" ? "genre" : "folder";
      const filter: Record<string, string> = { [field]: group.name };
      const mine = ++asked;
      const found = await api<{ items: Item[]; total: number }>("GET", `/api/v1/library/items?${new URLSearchParams({ ...filter, limit: "500", sort: "album" })}`);
      if (mine !== asked) return;
      results = found.items;
      selected.clear();
      drawResults(found.total);
    }));
    box.append(chip);
  }
}

async function loadPlaylists(): Promise<void> {
  try {
    playlists = (await api<{ playlists: Playlist[] }>("GET", "/api/v1/library/playlists")).playlists;
    signedIn = true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "sign_in_required") {
      signedIn = false;
      playlists = [];
    } else throw error;
  }
  const box = $("#playlists");
  box.replaceChildren();
  if (!signedIn) {
    box.append(el("p", { class: "hint" }, "Sign in to nixamp.com (or open this server with its control link) to keep playlists and pick up where you left off on another device."));
  } else if (playlists.length === 0) {
    box.append(el("p", { class: "hint" }, "No playlists yet. Select some items above and choose New playlist."));
  }
  for (const list of playlists) {
    const open = el("button", { type: "button", class: "ghost" }, "Open");
    open.addEventListener("click", () => void act("Open playlist", () => showPlaylist(list.id)));
    const play = el("button", { type: "button" }, "Play");
    play.addEventListener("click", () => void act("Play", async () => {
      const full = (await api<{ playlist: Playlist }>("GET", `/api/v1/library/playlists/${list.id}`)).playlist;
      await playList((full.items ?? []).filter((one) => one.state === "ready").map((one) => one.id), 0);
    }));
    const station = el("button", { type: "button", class: "ghost" }, "Make a station");
    station.addEventListener("click", () => void act("Make station", async () => {
      await api("POST", "/api/v1/stations", { name: list.name, playlist: list.id });
      say(`Station ${list.name} made; it is private and stopped`);
      await loadStations();
      document.querySelector("#stations")?.scrollIntoView();
    }));
    const remove = el("button", { type: "button", class: "ghost danger" }, "Delete");
    remove.addEventListener("click", () => void act("Delete playlist", async () => {
      if (!confirm(`Delete the playlist "${list.name}"?`)) return;
      await api("DELETE", `/api/v1/library/playlists/${list.id}`);
      await loadPlaylists();
    }));
    box.append(el("div", { class: "playlist", id: `playlist-${list.id}` },
      el("strong", {}, list.name), el("span", { class: "muted" }, ` ${list.count} items `),
      el("span", { class: "actions" }, play, open, station, remove),
    ));
  }
  drawSelection();
  drawStationSources();
}

async function showPlaylist(id: string): Promise<void> {
  const list = (await api<{ playlist: Playlist }>("GET", `/api/v1/library/playlists/${id}`)).playlist;
  const holder = $(`#playlist-${id}`);
  holder.querySelector("ol")?.remove();
  const items = list.items ?? [];
  const ol = el("ol", { class: "playlist-items" });
  items.forEach((item, at) => {
    const move = (by: number) => async (): Promise<void> => {
      const order = items.map((one) => one.id);
      const [moved] = order.splice(at, 1);
      order.splice(Math.max(0, Math.min(order.length, at + by)), 0, moved!);
      await api("PATCH", `/api/v1/library/playlists/${id}`, { items: order, revision: list.revision });
      await showPlaylist(id);
    };
    const up = el("button", { type: "button", class: "ghost", disabled: at === 0, "aria-label": `Move ${item.title ?? "item"} up` }, "↑");
    up.addEventListener("click", () => void act("Move", move(-1)));
    const down = el("button", { type: "button", class: "ghost", disabled: at === items.length - 1, "aria-label": `Move ${item.title ?? "item"} down` }, "↓");
    down.addEventListener("click", () => void act("Move", move(1)));
    const out = el("button", { type: "button", class: "ghost", "aria-label": `Remove ${item.title ?? "item"}` }, "✕");
    out.addEventListener("click", () => void act("Remove", async () => {
      await api("PATCH", `/api/v1/library/playlists/${id}`, { items: items.filter((_, index) => index !== at).map((one) => one.id), revision: list.revision });
      await showPlaylist(id);
      await loadPlaylists();
    }));
    ol.append(el("li", {},
      `${item.title ?? item.id}${item.artist ? ` — ${item.artist}` : ""}`,
      item.state !== "ready" ? el("span", { class: "warn" }, ` (${item.state})`) : null,
      " ", up, down, out,
    ));
  });
  holder.append(ol);
}

/* ---- playing and the queue ------------------------------------------------ */

let queue: string[] = [];
let at = 0;
let lastSaved = 0;
const device = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "phone" : "computer";

async function playList(ids: string[], start: number, position = 0): Promise<void> {
  if (ids.length === 0) return;
  queue = ids;
  at = start;
  if (signedIn) await api("PUT", "/api/v1/library/queue", { items: ids, device }).catch(() => undefined);
  await playCurrent(position);
}

async function playCurrent(position = 0): Promise<void> {
  const id = queue[at];
  if (!id) return;
  const audio = $<HTMLAudioElement>("#audio");
  audio.src = `/api/v1/library/items/${id}/stream`;
  if (position > 0) audio.currentTime = position;
  const item = results.find((one) => one.id === id) ?? (await api<{ item: Item }>("GET", `/api/v1/library/items/${id}`).then((one) => one.item).catch(() => null));
  $("#now").textContent = item ? `${item.title}${item.artist ? ` — ${item.artist}` : ""}` : "";
  await audio.play().catch(() => undefined);
  if (signedIn) await api("PATCH", "/api/v1/library/queue", { at, position, device }).catch(() => undefined);
}

function wirePlayer(): void {
  const audio = $<HTMLAudioElement>("#audio");
  audio.addEventListener("ended", () => {
    if (at + 1 < queue.length) {
      at += 1;
      void playCurrent();
    }
  });
  // Where you are, every ten seconds or so, for the next device.
  audio.addEventListener("timeupdate", () => {
    if (!signedIn || Date.now() - lastSaved < 10_000) return;
    lastSaved = Date.now();
    void api("PATCH", "/api/v1/library/queue", { at, position: audio.currentTime, device }).catch(() => undefined);
  });
}

async function offerResume(): Promise<void> {
  if (!signedIn) return;
  const answer = await api<{ queue: { items: Item[]; at: number; position: number; device: string } }>("GET", "/api/v1/library/queue").catch(() => null);
  const saved = answer?.queue;
  const current = saved?.items[saved.at];
  if (!saved || !current || saved.items.length === 0) return;
  const box = $("#resume");
  const go = el("button", { type: "button" }, "Resume");
  go.addEventListener("click", () => void act("Resume", async () => {
    queue = saved.items.map((one) => one.id);
    at = saved.at;
    await playCurrent(saved.position);
    box.hidden = true;
  }));
  box.replaceChildren(el("span", {}, `Where you left off${saved.device ? ` on your ${saved.device}` : ""}: ${current.title ?? ""} at ${clock(saved.position) || "the start"}. `), go);
  box.hidden = false;
}

/* ---- making a station ----------------------------------------------------- */

async function drawStationSources(): Promise<void> {
  const from = $<HTMLSelectElement>("#station-from");
  const folders = await api<{ groups: Array<{ name: string; count: number }> }>("GET", "/api/v1/library/browse/folders?limit=500").catch(() => ({ groups: [] }));
  from.replaceChildren(
    el("option", { value: "folder:" }, "The whole library"),
    ...(playlists.length ? [el("optgroup", { label: "Playlists" }, ...playlists.map((one) => el("option", { value: `playlist:${one.id}` }, `${one.name} (${one.count})`)))] : []),
    el("optgroup", { label: "Folders" }, ...folders.groups.map((one) => el("option", { value: `folder:${one.name}` }, `${one.name} (${one.count})`))),
  );
}

async function makeStation(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const [kind, value] = String(data.get("from") ?? "folder:").split(/:(.*)/s);
  await api("POST", "/api/v1/stations", {
    name: String(data.get("name") ?? ""),
    ...(kind === "playlist" ? { playlist: value } : { folder: value ?? "" }),
    shuffle: data.get("shuffle") === "on",
    repeat: data.get("repeat") === "on",
    bitrate: Number(data.get("bitrate") ?? 128),
  });
  form.reset();
  ($("#new-station") as HTMLDetailsElement).open = false;
  say("Station made; it is private and stopped");
  await loadStations();
}

/* ---- start --------------------------------------------------------------- */

async function start(): Promise<void> {
  wirePlayer();
  $("#who").textContent = location.host;
  $<HTMLFormElement>("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const browseKind = (form.elements.namedItem("browse") as HTMLSelectElement).value;
    const q = (form.elements.namedItem("q") as HTMLInputElement).value.trim();
    $("#groups").hidden = true;
    void act("Search", () => (browseKind && !q ? browse(browseKind) : search(q)));
  });
  $<HTMLSelectElement>("#search-form select").addEventListener("change", (event) => {
    const kind = (event.currentTarget as HTMLSelectElement).value;
    if (kind) void act("Browse", () => browse(kind));
  });
  $("#play-selection").addEventListener("click", () => void act("Play", () => playList(results.filter((one) => selected.has(one.id)).map((one) => one.id), 0)));
  $("#new-playlist").addEventListener("click", () => void act("New playlist", async () => {
    const name = prompt("Name the playlist");
    if (!name) return;
    await api("POST", "/api/v1/library/playlists", { name, items: results.filter((one) => selected.has(one.id)).map((one) => one.id) });
    say(`Playlist ${name} made`);
    await loadPlaylists();
  }));
  $("#add-selection").addEventListener("click", () => void act("Add to playlist", async () => {
    const id = $<HTMLSelectElement>("#add-to").value;
    await api("POST", `/api/v1/library/playlists/${id}/items`, { items: results.filter((one) => selected.has(one.id)).map((one) => one.id) });
    say("Added");
    await loadPlaylists();
  }));
  $<HTMLFormElement>("#station-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void act("Make station", () => makeStation(event.currentTarget as HTMLFormElement));
  });
  $<HTMLFormElement>("#source-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const root = (form.elements.namedItem("root") as HTMLInputElement).value.trim();
    void act("Add source", async () => {
      await api("POST", "/api/v1/library/sources", { root });
      form.reset();
      say("Added; reading its files");
      setTimeout(() => void loadSummary(), 1500);
    });
  });
  const publish = $<HTMLFormElement>("#publish-form");
  publish.addEventListener("change", syncPublic);
  $<HTMLDialogElement>("#publish-dialog").addEventListener("close", () => {
    if ($<HTMLDialogElement>("#publish-dialog").returnValue === "save") void act("Who can listen", savePublish);
  });

  try {
    await Promise.all([loadSummary(), loadStations(), loadPlaylists(), search("")]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      notice("This page manages the server it is on. Open it from your server's admin link (nixamp admin prints it), or sign in as its owner.");
    } else if (error instanceof ApiError && error.status === 404) {
      notice("This server has no library or stations here: it needs nixamp 0.32 or later.");
    } else {
      notice(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  await offerResume();
  // Stations change on their own: live, recovering, listeners.
  setInterval(() => void loadStations().catch(() => undefined), 5_000);
  setInterval(() => void loadSummary().catch(() => undefined), 15_000);
  if (location.hash === "#stations") document.querySelector("#stations")?.scrollIntoView();
}

void start();
