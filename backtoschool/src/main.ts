import { i18n } from "../../src/i18n.ts";
import { uiText, uiAttribute } from "../../web/src/i18n.ts";
import { t as uiMessage } from "../../src/i18n.ts";
import { installI18n } from "../../web/src/i18n.ts";
void installI18n();
import "./styles.css";
import { installEventWriter } from "./event-writer.ts";
import type { LiveEvent } from "../../src/live-events.ts";
import { classroomBroadcast } from "../../src/classroom.ts";
import { api, ApiError, send, type Account, type EventEnvelope } from "./api.ts";

const main = document.querySelector<HTMLElement>("#main")!;
const accountButton = document.querySelector<HTMLButtonElement>("#account-button")!;
const accountDialog = document.querySelector<HTMLDialogElement>("#account-dialog")!;
const accountForm = document.querySelector<HTMLFormElement>("#account-form")!;
const accountTitle = document.querySelector<HTMLElement>("#account-title")!;
const accountCopy = document.querySelector<HTMLElement>("#account-copy")!;
const accountError = document.querySelector<HTMLElement>("#account-error")!;
const accountMode = document.querySelector<HTMLButtonElement>("#account-mode")!;
const eventDialog = document.querySelector<HTMLDialogElement>("#event-dialog")!;
const eventForm = document.querySelector<HTMLFormElement>("#event-form")!;
const eventFormTitle = document.querySelector<HTMLElement>("#event-form-title")!;
const eventKicker = document.querySelector<HTMLElement>("#event-kicker")!;
const eventSubmit = document.querySelector<HTMLButtonElement>("#event-submit")!;
const eventError = document.querySelector<HTMLElement>("#event-error")!;
const scheduleFields = document.querySelector<HTMLElement>("#schedule-fields")!;

let account: Account | null = null;
let creatingAccount = false;
let scheduling = false;
let editing: LiveEvent | null = null;
let formPending = false;
let afterSignIn: (() => void) | null = null;
let routeCleanup: (() => void) | null = null;
let envelope: EventEnvelope | null = null;
const writer = installEventWriter(eventForm, eventDialog, () => editing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
const renderedUpdates = new WeakMap<HTMLElement, string>();
function renderUpdate(target: HTMLElement, html: string): void {
  if (renderedUpdates.get(target) === html || target.contains(document.activeElement)) return;
  target.innerHTML = html; renderedUpdates.set(target, html);
}

function escape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showClassUpdate(message: string): void {
  const notice = document.querySelector<HTMLElement>("#event-update");
  if (notice && notice.textContent !== message) notice.textContent = message;
  document.querySelector<HTMLElement>(".class-update")?.removeAttribute("hidden");
}

function eventPath(event: LiveEvent): string {
  return `/live/${encodeURIComponent(event.slug)}`;
}

function inviteQuery(): string {
  const token = new URLSearchParams(location.search).get("invite");
  return token ? `?invite=${encodeURIComponent(token)}` : "";
}

function displayDate(value: string | undefined, options: Intl.DateTimeFormatOptions = {}): string {
  if (!value) return "Time to be announced";
  return new Intl.DateTimeFormat(i18n.language, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(value));
}

function relativeStart(event: LiveEvent): string {
  if (event.status === "live") return uiMessage("Live now");
  if (event.status === "ended") return event.recordingId ? uiMessage("Replay available") : uiMessage("Event ended");
  if (event.status === "cancelled") return uiMessage("Cancelled");
  return displayDate(event.startsAt);
}

function hasPermission(permission: string): boolean {
  return envelope?.permissions.includes(permission) ?? false;
}

function updateAccountButton(): void {
  uiText(accountButton, () => account ? account.email.split("@")[0] || uiMessage("Account") : uiMessage("Sign in"));
  accountButton.classList.toggle("signed-in", Boolean(account));
}

async function readAccount(): Promise<void> {
  try {
    account = (await api<{ account: Account }>("/api/v1/auth/me")).account;
  } catch {
    account = null;
  }
  updateAccountButton();
}

function openAccount(next?: () => void): void {
  if (account) {
    accountDialog.showModal();
    const email = account.email;
    accountTitle.textContent = `Signed in as ${email}`;
    accountCopy.textContent = "Your BackToSchool identity is your NixAmp account.";
    accountForm.hidden = true;
    return;
  }
  afterSignIn = next ?? null;
  accountForm.hidden = false;
  accountError.textContent = "";
  drawAccountMode();
  accountDialog.showModal();
}

function drawAccountMode(): void {
  uiText(accountTitle, () => creatingAccount ? uiMessage("Create your account") : uiMessage("Welcome back"));
  accountCopy.textContent = creatingAccount
    ? "One NixAmp account works here and everywhere NixAmp goes."
    : "Sign in to host, chat, or raise your hand.";
  uiText(accountMode, () => creatingAccount ? uiMessage("Already have an account? Sign in") : uiMessage("New here? Create an account"));
  document.querySelector<HTMLElement>("#account-forgot")!.hidden = creatingAccount;
  const password = accountForm.elements.namedItem("password") as HTMLInputElement;
  password.autocomplete = creatingAccount ? "new-password" : "current-password";
  uiText(accountForm.querySelector<HTMLButtonElement>('button[type="submit"]')!, () => creatingAccount ? uiMessage("Create account") : uiMessage("Sign in"));
}

function localDateTime(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function openEventForm(mode: "live" | "scheduled", existing: LiveEvent | null = null): void {
  if (!account) { openAccount(() => openEventForm(mode, existing)); return; }
  if (formPending) return;
  editing = existing;
  writer.reset();
  eventForm.reset();
  scheduling = mode === "scheduled";
  scheduleFields.hidden = !scheduling;
  uiText(eventFormTitle, () => existing ? uiMessage("Edit event") : scheduling ? uiMessage("Schedule a class") : uiMessage("Go live"));
  uiText(eventKicker, () => existing ? uiMessage("Your classroom") : "Teach something live");
  uiText(eventSubmit, () => existing ? uiMessage("Save changes") : scheduling ? uiMessage("Schedule class") : uiMessage("Create live"));
  eventError.textContent = "";
  const startsAt = eventForm.elements.namedItem("startsAt") as HTMLInputElement;
  startsAt.required = scheduling && (!existing || Boolean(existing.startsAt));
  if (existing) {
    for (const key of ["title", "description", "topic", "visibility", "broadcastUrl", "hostName", "homepageUrl", "avatarUrl", "recurrence"] as const) {
      (eventForm.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement).value = existing[key] ?? (key === "recurrence" ? "none" : "");
    }
    for (const key of ["chatEnabled", "handRaiseEnabled"] as const) (eventForm.elements.namedItem(key) as HTMLInputElement).checked = existing[key];
    if (existing.startsAt) startsAt.value = localDateTime(existing.startsAt);
    const duration = eventForm.elements.namedItem("expectedDurationMinutes") as HTMLSelectElement;
    const value = String(existing.expectedDurationMinutes ?? 60);
    if (![...duration.options].some(option => option.value === value)) duration.add(new Option(`${value} minutes`, value));
    duration.value = value;
  } else if (scheduling) {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
    startsAt.value = localDateTime(soon.toISOString());
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  document.querySelector("#schedule-timezone")!.textContent = `Date and time are shown in ${zone}.` + (existing?.recurrence ? ` This class repeats in ${existing.timezone}.` : "");
  eventDialog.showModal();
}

function navigate(path: string): void {
  history.pushState(null, "", path);
  void route();
}

function eventCard(event: LiveEvent): string {
  const live = event.status === "live" || event.status === "starting";
  return `
    <article class="event-card ${live ? "is-live" : ""}">
      <a href="${eventPath(event)}" data-link>
        <div class="event-card-top">
          <span class="status-pill ${live ? "status-live" : ""}">${live ? "Live" : escape(relativeStart(event))}</span>
          ${event.topic ? `<span class="topic">${escape(event.topic)}</span>` : ""}
        </div>
        <h3>${escape(event.title)}</h3>
        <p>${escape(event.description || "Drop in and learn something with us.")}</p>
        <span class="event-link">${live ? "Watch live" : "See event"}<span aria-hidden="true">→</span></span>
      </a>
    </article>`;
}

async function home(): Promise<void> {
  document.title = "BackToSchool.help — Learn something live";
  const { events } = await api<{ events: LiveEvent[] }>("/api/v1/events?limit=60").catch(() => ({ events: [] }));
  const live = events.filter((event) => event.status === "live" || event.status === "starting");
  const upcoming = events.filter((event) => event.status === "scheduled" || event.status === "draft");
  const recent = events.filter((event) => event.status === "ended" && event.recordingId);
  main.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">Go back to school whenever you want</span>
        <h1>Learn something<br /><em>live.</em></h1>
        <p>Watch a live lesson, follow a screen share, and ask questions as you learn.</p>
        <div class="hero-actions">
          <button class="button button-primary" type="button" data-event-mode="live"><span class="live-dot"></span><span data-i18n="Go live"> Go live</span></button>
          <button class="button button-secondary" type="button" data-event-mode="scheduled" data-i18n="Schedule live">Schedule live</button>
        </div>
        <p class="hero-note">Watch classes and screen shares. No account required.</p>
      </div>
      <div class="hero-board" aria-label="What is happening today">
        <span class="tape tape-one" aria-hidden="true"></span>
        <span class="tape tape-two" aria-hidden="true"></span>
        <div class="board-rule"></div>
        <span class="board-label">Today’s lesson</span>
        <strong>${escape(live[0]?.title ?? upcoming[0]?.title ?? "The best teachers are curious people")}</strong>
        <p>${live[0] ? "Happening right now" : upcoming[0] ? relativeStart(upcoming[0]) : "Host the first live conversation"}</p>
        ${live[0] ? `<a href="${eventPath(live[0])}" data-link class="board-action"><span data-i18n="Watch now">Watch now </span><span>↗</span></a>` : `<button type="button" data-event-mode="live" class="board-action"><span data-i18n="Start a room">Start a room </span><span>↗</span></button>`}
        <div class="board-doodles" aria-hidden="true"><span>?</span><span>✦</span><span>≈</span></div>
      </div>
    </section>

    <section class="event-section" id="live">
      <div class="section-heading">
        <div><span class="eyebrow">Walk in anytime</span><h2 data-i18n="Live now">Live now</h2></div>
        <span class="section-count">${live.length} ${live.length === 1 ? "room" : "rooms"}</span>
      </div>
      <div class="event-grid">
        ${live.length ? live.map(eventCard).join("") : `<div class="empty-card"><span>☕</span><h3>The halls are quiet.</h3><p>Start a live and give people something worth dropping into.</p><button class="text-button" data-event-mode="live" data-i18n="Open a room →">Open a room →</button></div>`}
      </div>
    </section>

    <section class="event-section event-section-tint" id="upcoming">
      <div class="section-heading">
        <div><span class="eyebrow">Save your seat</span><h2 data-i18n="Coming up">Coming up</h2></div>
      </div>
      <div class="upcoming-list">
        ${upcoming.length ? upcoming.map((event) => `
          <a class="upcoming-row" href="${eventPath(event)}" data-link>
            <time>${escape(displayDate(event.startsAt, { weekday: "short", month: "short", day: "numeric" }))}</time>
            <span><strong>${escape(event.title)}</strong><small>${escape(event.topic || "Live conversation")}</small></span>
            <span class="row-arrow">→</span>
          </a>`).join("") : `<p class="empty-line">Nothing scheduled yet. Your idea could be next.</p>`}
      </div>
    </section>

    ${recent.length ? `<section class="event-section"><div class="section-heading"><div><span class="eyebrow" data-i18n="Listen after class">Listen after class</span><h2 data-i18n="Recent replays">Recent replays</h2></div></div><div class="event-grid">${recent.map(eventCard).join("")}</div></section>` : ""}

    <section class="host-callout">
      <span class="eyebrow">Know a thing or two?</span>
      <h2>Someone wants to hear it.</h2>
      <p>You don’t need a studio or a syllabus. Bring an idea and start talking.</p>
      <button class="button button-light" type="button" data-event-mode="scheduled" data-i18n="Plan a conversation">Plan a conversation</button>
    </section>`;
}

function playerPanel(event: LiveEvent): string {
  const broadcast = classroomBroadcast(event.broadcastUrl);
  if (broadcast) return `<div class="classroom-video"><iframe src="${escape(broadcast.embed)}" title="${escape(event.title)} broadcast" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
    <p class="broadcast-caption"><a class="button button-secondary" href="${escape(broadcast.join)}" target="_blank" rel="noopener noreferrer">${broadcast.provider === "pairux" ? "Join screen share on Pairux" : "Open video in Nixamp"} ↗</a></p>`;
  const invite = inviteQuery();
  const source = event.recordingId && event.status === "ended"
    ? `/api/v1/recordings/${encodeURIComponent(event.recordingId)}`
    : `/api/channels/${encodeURIComponent(event.roomId)}${invite}`;
  const available = event.status === "live" || Boolean(event.recordingId);
  return `
    <div class="listen-card ${available ? "" : "waiting"}">
      <div class="sound-orbit" aria-hidden="true"><span></span><span></span><span></span><b>▶</b></div>
      <div>
        <span class="eyebrow">${event.status === "live" ? "On air now" : event.recordingId ? uiMessage("Replay") : "The room opens soon"}</span>
        <h2>${available ? (event.status === "live" ? "Listen live" : "Listen again") : "We’ll see you here."}</h2>
        <p id="player-note">${available ? "Press play and you’re in. No sign-up, no setup." : escape(relativeStart(event))}</p>
        ${available ? `<button class="button button-primary listen-button" type="button" data-listen><span class="live-dot"></span> ${event.status === "live" ? "Listen live" : "Play replay"}</button><audio id="event-audio" preload="none" src="${escape(source)}" controls></audio>` : ""}
      </div>
    </div>`;
}

function chatPanel(event: LiveEvent): string {
  if (!event.chatEnabled) return `<div class="panel-empty">Chat is off for this event.</div>`;
  return `
    <div id="chat-messages" class="chat-messages"><p class="muted">Loading the conversation…</p></div>
    ${account ? `<form id="chat-form" class="inline-form"><input name="body" maxlength="1000" placeholder="Add to the conversation" data-i18n-placeholder="Add to the conversation" aria-label="Chat message" data-i18n-aria-label="Chat message" required /><button class="button button-small" type="submit" data-i18n="Send">Send</button></form>` : `<button class="text-button" type="button" data-sign-in>Sign in to join the chat →</button>`}`;
}

function panelBody(type: string, event: LiveEvent): string | null {
  switch (type) {
    case "event-header":
      return `<div class="event-heading"><span class="status-pill ${event.status === "live" ? "status-live" : ""}">${escape(relativeStart(event))}</span>${event.topic ? `<span class="topic">${escape(event.topic)}</span>` : ""}<h1>${escape(event.title)}</h1><p>${escape(event.description || "A live conversation powered by NixAmp.")}</p></div>`;
    case "player": return playerPanel(event);
    case "stage": return `<div class="stage-card"><span class="stage-avatar">${escape(event.title.slice(0, 1).toUpperCase())}</span><div><span class="eyebrow" data-i18n="Host stage">Host stage</span><h2>${escape(event.title)}</h2><p id="broadcast-note">${event.status === "live" ? "This event is live." : "Start when you’re ready."}</p></div></div>`;
    case "host": return `<div class="host-line">${event.avatarUrl ? `<img class="avatar host-avatar" src="${escape(event.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : `<span class="avatar">${escape((event.hostName || event.title).slice(0, 1))}</span>`}<div><small data-i18n="Your host">Your host</small><strong>${escape(event.hostName || uiMessage("Class host"))}</strong>${event.homepageUrl ? `<a href="${escape(event.homepageUrl)}" target="_blank" rel="noopener noreferrer">Visit homepage ↗</a>` : ""}</div></div>`;
    case "about": return `<p class="reading-copy">${escape(event.description || "Come listen, learn, and ask a question live.")}</p>${event.topic ? `<span class="topic topic-large">${escape(event.topic)}</span>` : ""}`;
    case "join": return account ? `<p class="panel-empty">You’re signed in and ready to participate.</p>` : `<div class="join-line"><div><strong>Want to ask something?</strong><p>Join with your NixAmp account.</p></div><button class="button button-secondary" type="button" data-sign-in data-i18n="Join in">Join in</button></div>`;
    case "chat": return chatPanel(event);
    case "questions": return `<div class="panel-empty">Questions shared in chat can be brought onto the stage.</div>`;
    case "resources": return `<div class="panel-empty">The host hasn’t added resources yet.</div>`;
    case "participants": return `<div class="metric"><strong id="listener-count">—</strong><span>listening now</span></div>`;
    case "speakers": return `<div class="people-row"><span class="avatar">H</span><span><strong data-i18n="Host">Host</strong><small>On stage</small></span></div>`;
    case "raise-hand": return event.handRaiseEnabled ? `<div class="join-line"><div><strong>Have something to add?</strong><p>Let the host know you’d like to speak.</p></div><button class="button button-secondary" type="button" data-raise-hand data-i18n="Raise hand">Raise hand</button></div>` : null;
    case "hand-raises": return `<div id="hand-raises" class="hand-raises"><p class="muted">No hands raised.</p></div>`;
    case "invite": return `<form id="invite-form" class="form-stack compact"><label><span data-i18n="Email">Email</span><input name="email" type="email" placeholder="someone@example.com" required /></label><label><span data-i18n="Invite as">Invite as</span><select name="role"><option value="listener" data-i18n="Listener">Listener</option><option value="speaker" data-i18n="Speaker">Speaker</option><option value="moderator" data-i18n="Moderator">Moderator</option></select></label><button class="button button-small" type="submit" data-i18n="Create invite">Create invite</button><p id="invite-note" class="form-note"></p></form>`;
    case "share": return `<div class="share-box"><input id="share-url" value="${escape(location.href)}" readonly aria-label="Event URL" /><button class="button button-small" type="button" data-copy data-i18n="Copy link">Copy link</button></div>`;
    case "event-controls": return `<div class="control-stack">
      <a href="https://pairux.com/dashboard" target="_blank" rel="noopener noreferrer" data-i18n="Screen share with Pairux ↗">Screen share with Pairux ↗</a>
      <a href="https://nixamp.com/#files-panel" target="_blank" rel="noopener noreferrer" data-i18n="Upload &amp; broadcast in Nixamp ↗">Upload &amp; broadcast in Nixamp ↗</a>
      ${["draft", "scheduled", "starting"].includes(event.status) ? `<button class="button button-primary" type="button" data-start-event data-i18n="Start class">Start class</button>` : ""}
      <button class="button button-danger" type="button" data-end-event ${event.status === "live" ? "" : "hidden"}>${event.recurrence ? "End session & schedule next" : uiMessage("End event")}</button>
      <p id="broadcast-note" class="form-note" role="status">${event.broadcastUrl ? "Start the broadcast in Pairux or Nixamp, then start the class here." : "Add your broadcast link with Edit event."}</p>
      </div>`;
    case "schedule": return `<div class="metric"><strong>${escape(displayDate(event.startsAt, {timeZone: event.timezone}))}</strong><span>${escape(event.timezone)}${event.recurrence ? ` · Repeats ${event.recurrence}` : ""}</span></div>`;
    case "recording": return `<div class="control-line"><span>${event.recordingEnabled ? "Recording requested" : "Recording is off"}</span><span class="status-dot ${event.recordingEnabled ? "on" : ""}"></span></div>`;
    default: return null;
  }
}

async function eventPage(slug: string): Promise<void> {
  const result = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(slug)}${inviteQuery()}`);
  routeCleanup?.(); routeCleanup = null;
  envelope = result;
  const event = result.event;
  document.title = `${event.title} — BackToSchool.help`;
  document.querySelector('meta[name="description"]')?.setAttribute("content", event.description || `Listen to ${event.title} live on BackToSchool.help.`);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", event.title);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", event.description || uiMessage("Learn something live."));

  const panel = (type: string, title: string) => `<section class="event-panel panel-${type}"><h2 class="panel-title">${title}</h2>${panelBody(type, event) ?? ""}</section>`;
  main.innerHTML = `
    <div class="event-shell">
      <div class="event-toolbar"><a class="back-link" href="/" data-link>← Explore more lives</a>${account?.id === event.ownerId ? `<button class="button button-secondary" type="button" data-edit-event data-i18n="Edit event">Edit event</button>` : ""}</div>
      <div class="class-update" hidden><p id="event-update" role="status" class="form-note"></p><button class="text-button" data-refresh-event>Refresh class details</button><button class="text-button" data-dismiss-update>Dismiss</button></div>
      <div class="event-layout">
        <div class="region region-primary">${panel("event-header", "Live classroom")}${panel("player", "Watch class")}${panel("chat", "Class chat")}</div>
        <aside class="region region-secondary">${panel("host", "Meet your host")}${panel("schedule", uiMessage("Schedule"))}${account?.id === event.ownerId ? panel("event-controls", "Host controls") : panel("join", "Join the class")}${account?.id === event.ownerId && event.visibility === "private" ? `<details class="event-panel"><summary>Invite students</summary>${panelBody("invite", event)}</details>` : ""}${panel("share", "Share class")}${account?.id === event.ownerId && event.handRaiseEnabled ? panel("hand-raises", "Raised hands") : event.handRaiseEnabled ? panel("raise-hand", "Ask a question") : ""}</aside>
      </div>
    </div>`;
  bindEventPage(event);
}

function bindEventPage(event: LiveEvent): void {
  document.querySelector<HTMLButtonElement>("[data-listen]")?.addEventListener("click", async (click) => {
    const button = click.currentTarget as HTMLButtonElement;
    const audio = document.querySelector<HTMLAudioElement>("#event-audio");
    if (!audio) return;
    button.disabled = true;
    uiText(button, () => uiMessage("Connecting…"));
    try {
      await audio.play();
      button.textContent = "You’re listening";
      document.querySelector("#player-note")!.textContent = "Live audio from this NixAmp room.";
    } catch {
      button.disabled = false;
      button.textContent = "Try listening again";
      document.querySelector("#player-note")!.textContent = "The host may still be getting ready. Try again in a moment.";
    }
  });

  const chatForm = document.querySelector<HTMLFormElement>("#chat-form");
  chatForm?.addEventListener("submit", (submit) => {
    submit.preventDefault();
    const input = chatForm.elements.namedItem("body") as HTMLInputElement;
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    void send(`/api/v1/events/${encodeURIComponent(event.id)}/chat`, { body: value })
      .then(() => loadChat(event))
      .catch((error) => { input.placeholder = error instanceof Error ? error.message : "Could not send"; });
  });

  const inviteForm = document.querySelector<HTMLFormElement>("#invite-form");
  inviteForm?.addEventListener("submit", (submit) => {
    submit.preventDefault();
    const data = new FormData(inviteForm);
    const note = document.querySelector<HTMLElement>("#invite-note")!;
    note.textContent = "Creating invite…";
    void api<{ inviteUrl: string; sent: boolean }>(`/api/v1/events/${encodeURIComponent(event.id)}/invitations`, {
      method: "POST",
      body: JSON.stringify({ email: data.get("email"), role: data.get("role") }),
    }).then(async ({ inviteUrl, sent }) => {
      await navigator.clipboard?.writeText(inviteUrl).catch(() => undefined);
      note.textContent = sent ? "Invite sent. The link is copied too." : `Invite link copied: ${inviteUrl}`;
      inviteForm.reset();
    }).catch((error) => { note.textContent = error instanceof Error ? error.message : "Could not invite"; });
  });

  document.querySelector<HTMLButtonElement>("[data-raise-hand]")?.addEventListener("click", (click) => {
    const button = click.currentTarget as HTMLButtonElement;
    button.disabled = true;
    void send(`/api/v1/events/${encodeURIComponent(event.id)}/hand-raises`, {}).then(() => {
      uiText(button, () => uiMessage("Hand raised ✓"));
    }).catch((error) => {
      button.disabled = false;
      button.textContent = error instanceof ApiError && error.status === 401 ? "Sign in to raise hand" : "Try again";
    });
  });

  document.querySelector("[data-edit-event]")?.addEventListener("click", () => openEventForm("scheduled", envelope!.event));
  document.querySelector("[data-start-event]")?.addEventListener("click", () => void startClass());
  document.querySelector("[data-dismiss-update]")?.addEventListener("click", () => document.querySelector<HTMLElement>(".class-update")!.hidden = true);
  document.querySelector("[data-refresh-event]")?.addEventListener("click", () => navigate(eventPath(event) + inviteQuery()));
  document.querySelector<HTMLButtonElement>("[data-end-event]")?.addEventListener("click", () => void endEvent());
  document.querySelector<HTMLButtonElement>("[data-copy]")?.addEventListener("click", async (click) => {
    await navigator.clipboard.writeText(location.href);
    uiText((click.currentTarget as HTMLButtonElement), () => uiMessage("Copied ✓"));
  });

  let chatTimer = 0; let raiseTimer = 0;
  if (event.chatEnabled) {
    void loadChat(event);
    chatTimer = window.setInterval(() => void loadChat(event), 4000);
    raiseTimer = hasPermission("event.moderate")
      ? window.setInterval(() => void loadHandRaises(event), 3000)
      : 0;
    void loadHandRaises(event);
  }
  let lastNotifiedVersion = event.version;
  const eventTimer = window.setInterval(() => void api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(event.id)}${inviteQuery()}`).then(latest => {
    if (latest.event.version === envelope?.event.version || latest.event.version === lastNotifiedVersion) return;
    lastNotifiedVersion = latest.event.version;
    const status = document.querySelector(".event-heading .status-pill");
    const label = relativeStart(latest.event);
    if (status && status.textContent !== label) { status.textContent = label; status.classList.toggle("status-live", latest.event.status === "live"); }
    showClassUpdate("The host updated this class. Refresh the details when you’re ready.");
    // Keep the viewer's player, chat field, focus, and scroll exactly where they are.
  }).catch(() => undefined), 5000);
  routeCleanup = () => { clearInterval(chatTimer); clearInterval(raiseTimer); clearInterval(eventTimer); };
  void loadListeners(event);
}

async function loadChat(event: LiveEvent): Promise<void> {
  const target = document.querySelector<HTMLElement>("#chat-messages");
  if (!target) return;
  try {
    const { messages } = await api<{ messages: Array<{ id: string; authorName: string; body: string; createdAt: string }> }>(`/api/v1/events/${encodeURIComponent(event.id)}/chat${inviteQuery()}`);
    renderUpdate(target, messages.length ? messages.map((message) => `<div class="chat-message"><span class="avatar avatar-small">${escape(message.authorName.slice(0, 1).toUpperCase())}</span><p><strong>${escape(message.authorName)}</strong><span>${escape(message.body)}</span></p></div>`).join("") : `<p class="muted">No messages yet. Say hello when you’re ready.</p>`);

  } catch {
    target.innerHTML = `<p class="muted">Chat is taking a break. You can still watch the class.</p>`;
  }
}

async function loadHandRaises(event: LiveEvent): Promise<void> {
  const target = document.querySelector<HTMLElement>("#hand-raises");
  if (!target || !hasPermission("event.moderate")) return;
  try {
    const { handRaises } = await api<{ handRaises: Array<{ accountId: string; displayName: string; state: string; raisedAt: string }> }>(`/api/v1/events/${encodeURIComponent(event.id)}/hand-raises`);
    if (target.contains(document.activeElement)) return;
    renderUpdate(target, handRaises.length ? handRaises.map((raise) => `<div class="raise-row"><span><strong>${escape(raise.displayName)}</strong><small>${escape(raise.state)}</small></span><div><button class="text-button" data-hand="${escape(raise.accountId)}" data-state="invited"><span data-i18n="Invite">Invite</span></button><button class="text-button" data-hand="${escape(raise.accountId)}" data-state="dismissed">Dismiss</button></div></div>`).join("") : `<p class="muted">No hands raised.</p>`);
  } catch {
    if (!target.contains(document.activeElement)) target.innerHTML = `<p class="muted">Could not refresh hand raises.</p>`;
  }
}

async function loadListeners(event: LiveEvent): Promise<void> {
  const target = document.querySelector<HTMLElement>("#listener-count");
  if (!target) return;
  try {
    const { channels } = await api<{ channels: Array<{ id: string; listeners: number }> }>("/api/channels");
    target.textContent = String(channels.find((channel) => channel.id === event.roomId)?.listeners ?? 0);
  } catch {
    target.textContent = "0";
  }
}

async function startClass(): Promise<void> {
  if (!envelope) return;
  const note = document.querySelector<HTMLElement>("#broadcast-note");
  const button = document.querySelector<HTMLButtonElement>("[data-start-event]");
  if (!envelope.event.broadcastUrl) { if (note) note.textContent = "Add a Pairux or Nixamp broadcast link with Edit event first."; return; }
  if (button?.getAttribute("aria-disabled") === "true") return;
  button?.setAttribute("aria-disabled", "true");
  try {
    envelope = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(envelope.event.id)}/start`, { method: "POST", body: JSON.stringify({ version: envelope.event.version }) });
    if (button) button.textContent = "Class is live";
    document.querySelector<HTMLElement>("[data-end-event]")?.removeAttribute("hidden");
    const status = document.querySelector(".event-heading .status-pill");
    if (status) { uiText(status, () => uiMessage("Live now")); status.classList.add("status-live"); }
    if (note) note.textContent = "Your class is live. Viewers can join using this page.";
  } catch (error) { button?.removeAttribute("aria-disabled"); if (note) note.textContent = error instanceof Error ? error.message : "Could not start the class."; }
}

async function endEvent(): Promise<void> {
  const endButton = document.querySelector<HTMLButtonElement>("[data-end-event]");
  if (!envelope || endButton?.getAttribute("aria-disabled") === "true") return;
  endButton?.setAttribute("aria-disabled", "true");

  const event = envelope.event;
  try {
    const result = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(event.id)}/end`, {
      method: "POST",
      body: JSON.stringify({ version: event.version }),
    });
    envelope = result;
    const status = document.querySelector(".event-heading .status-pill");
    if (status) { status.textContent = relativeStart(result.event); status.classList.remove("status-live"); }
    await fetch(`/api/channels/${encodeURIComponent(event.roomId)}`, { method: "DELETE", credentials: "same-origin" });
    const note = document.querySelector<HTMLElement>("#broadcast-note");
    if (note) note.textContent = result.event.recurrence ? `Session ended. Next class: ${displayDate(result.event.startsAt)}. End the broadcast in Pairux or Nixamp too.` : "Event ended. End the broadcast in Pairux or Nixamp too.";
    const button = document.querySelector<HTMLButtonElement>("[data-end-event]");
    if (button) { uiText(button, () => uiMessage("Session ended")); button.setAttribute("aria-disabled", "true"); }
    showClassUpdate("This session has ended. Refresh to see the latest schedule.");
  } catch (error) {
    endButton?.removeAttribute("aria-disabled");
    const note = document.querySelector<HTMLElement>("#broadcast-note");
    if (note) note.textContent = error instanceof Error ? error.message : "Could not end the event.";
  }
}

async function route(): Promise<void> {
  routeCleanup?.();
  routeCleanup = null;
  envelope = null;
  const match = /^\/live\/([^/]+)\/?$/.exec(location.pathname);
  try {
    if (match) await eventPage(decodeURIComponent(match[1]!));
    else await home();
  } catch (error) {
    const message = error instanceof ApiError && error.status === 404
      ? "That live event isn’t available."
      : "We couldn’t open this page.";
    main.innerHTML = `<section class="error-page"><span class="eyebrow">Class dismissed?</span><h1>${escape(message)}</h1><p>${escape(error instanceof Error ? error.message : "Try again in a moment.")}</p><a href="/" data-link class="button button-primary">Back to live events</a></section>`;
  }

}

accountButton.addEventListener("click", () => {
  if (!account) {
    openAccount();
    return;
  }
  const leave = confirm(`Signed in as ${account.email}. Sign out?`);
  if (!leave) return;
  void api("/api/v1/auth/logout", { method: "POST" }).finally(() => {
    account = null;
    updateAccountButton();
    void route();
  });
});

accountMode.addEventListener("click", () => {
  creatingAccount = !creatingAccount;
  accountError.textContent = "";
  drawAccountMode();
});

accountForm.addEventListener("submit", (submit) => {
  submit.preventDefault();
  const data = new FormData(accountForm);
  const button = accountForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.disabled = true;
  accountError.textContent = "";
  void api<{ account: Account }>(`/api/v1/auth/${creatingAccount ? "signup" : "login"}`, {
    method: "POST",
    body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
  }).then((result) => {
    account = result.account;
    updateAccountButton();
    accountForm.reset();
    accountDialog.close();
    const next = afterSignIn;
    afterSignIn = null;
    if (next) next(); else void route();
  }).catch((error) => {
    accountError.textContent = error instanceof Error ? error.message : "That did not work.";
  }).finally(() => { button.disabled = false; });
});

eventForm.querySelector<HTMLSelectElement>('[name="recurrence"]')?.addEventListener("change", () => {
  const repeat = (eventForm.elements.namedItem("recurrence") as HTMLSelectElement).value;
  if (repeat !== "none") {
    scheduling = true; scheduleFields.hidden = false;
    (eventForm.elements.namedItem("startsAt") as HTMLInputElement).required = true;
  }
});

eventForm.addEventListener("submit", (submit) => {
  submit.preventDefault();
  if (formPending) return;
  const data = new FormData(eventForm);
  const existing = editing;
  const starts = String(data.get("startsAt") ?? "");
  const changedTime = !existing?.startsAt || starts !== localDateTime(existing.startsAt);
  const recurrence = String(data.get("recurrence"));
  if (recurrence !== "none" && !starts && !scheduling) {
    scheduling = true; scheduleFields.hidden = false;
    (eventForm.elements.namedItem("startsAt") as HTMLInputElement).required = true;
    eventError.textContent = "Choose the first class date and time for this recurring schedule."; return;
  }
  formPending = true; eventSubmit.setAttribute("aria-disabled", "true"); eventForm.setAttribute("aria-busy", "true");
  eventError.textContent = "";
  const input = {
    title: data.get("title"), description: data.get("description"), topic: data.get("topic"),
    visibility: data.get("visibility"), broadcastUrl: data.get("broadcastUrl"),
    hostName: data.get("hostName"), homepageUrl: data.get("homepageUrl"), avatarUrl: data.get("avatarUrl"), recurrence,
    chatEnabled: data.get("chatEnabled") === "on", handRaiseEnabled: data.get("handRaiseEnabled") === "on",
    ...(existing ? { version: existing.version } : {kind: "class"}),
    ...(scheduling ? {
      startsAt: starts ? changedTime ? new Date(starts).toISOString() : existing!.startsAt : null,
      timezone: changedTime ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : existing!.timezone,
      expectedDurationMinutes: Number(data.get("expectedDurationMinutes")),
    } : {}),
  };
  void api<EventEnvelope>(existing ? `/api/v1/events/${encodeURIComponent(existing.id)}` : "/api/v1/events", { method: existing ? "PATCH" : "POST", body: JSON.stringify(input) })
    .then(async (created) => {
      // A new class opens after its broadcast is ready; creating it never
      // claims that an empty audio room is already on air.
      if (existing) {
        await eventPage(created.event.slug);
        eventDialog.close();
        document.querySelector<HTMLButtonElement>("[data-edit-event]")?.focus({ preventScroll: true });
      } else { eventDialog.close(); navigate(eventPath(created.event)); }
      eventForm.reset(); editing = null;
    })
    .catch((error) => { eventError.textContent = error instanceof Error ? error.message : "Could not save the event."; })
    .finally(() => { formPending = false; eventSubmit.removeAttribute("aria-disabled"); eventForm.removeAttribute("aria-busy"); });
});

document.addEventListener("click", (click) => {
  const target = click.target as Element;
  const link = target.closest<HTMLAnchorElement>("a[data-link]");
  if (link && link.origin === location.origin) {
    click.preventDefault();
    navigate(`${link.pathname}${link.search}`);
    return;
  }
  const eventMode = target.closest<HTMLElement>("[data-event-mode]")?.dataset.eventMode;
  if (eventMode === "live" || eventMode === "scheduled") openEventForm(eventMode);
  if (target.closest("[data-sign-in]")) openAccount(() => void route());
  const close = target.closest<HTMLElement>("[data-close]");
  if (close) (close.closest("dialog") as HTMLDialogElement | null)?.close();
  const hand = target.closest<HTMLButtonElement>("[data-hand]");
  if (hand && envelope) {
    hand.disabled = true;
    void send(`/api/v1/events/${encodeURIComponent(envelope.event.id)}/hand-raises/${encodeURIComponent(hand.dataset.hand ?? "")}`, { state: hand.dataset.state }, "PATCH")
      .then(() => loadHandRaises(envelope!.event))
      .finally(() => { hand.disabled = false; });
  }
});

window.addEventListener("popstate", () => void route());


void readAccount().then(() => route());
