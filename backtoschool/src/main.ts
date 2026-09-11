import "./styles.css";
import type { LiveEvent, LiveEventStatus } from "../../src/live-events.ts";
import type { PanelInstance } from "../../src/layouts.ts";
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
let afterSignIn: (() => void) | null = null;
let routeCleanup: (() => void) | null = null;
let envelope: EventEnvelope | null = null;
let broadcaster: { recorder: MediaRecorder; stream: MediaStream; queue: Promise<void> } | null = null;

function escape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(value));
}

function relativeStart(event: LiveEvent): string {
  if (event.status === "live") return "Live now";
  if (event.status === "ended") return event.recordingId ? "Replay available" : "Event ended";
  if (event.status === "cancelled") return "Cancelled";
  return displayDate(event.startsAt);
}

function hasPermission(permission: string): boolean {
  return envelope?.permissions.includes(permission) ?? false;
}

function updateAccountButton(): void {
  accountButton.textContent = account ? account.email.split("@")[0] || "Account" : "Sign in";
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
    accountTitle.textContent = `Signed in as ${account.email}`;
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
  accountTitle.textContent = creatingAccount ? "Create your account" : "Welcome back";
  accountCopy.textContent = creatingAccount
    ? "One NixAmp account works here and everywhere NixAmp goes."
    : "Sign in to host, chat, or raise your hand.";
  accountMode.textContent = creatingAccount ? "Already have an account? Sign in" : "New here? Create an account";
  const password = accountForm.elements.namedItem("password") as HTMLInputElement;
  password.autocomplete = creatingAccount ? "new-password" : "current-password";
  accountForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = creatingAccount ? "Create account" : "Sign in";
}

function openEventForm(mode: "live" | "scheduled"): void {
  if (!account) {
    openAccount(() => openEventForm(mode));
    return;
  }
  scheduling = mode === "scheduled";
  scheduleFields.hidden = !scheduling;
  eventFormTitle.textContent = scheduling ? "Schedule a live" : "Go live";
  eventKicker.textContent = scheduling ? "Put it on the calendar" : "Start a conversation";
  eventSubmit.textContent = scheduling ? "Schedule live" : "Create live";
  eventError.textContent = "";
  const startsAt = eventForm.elements.namedItem("startsAt") as HTMLInputElement;
  startsAt.required = scheduling;
  if (scheduling && !startsAt.value) {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
    startsAt.value = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}T${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;
  }
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
        <span class="event-link">${live ? "Listen live" : "See event"}<span aria-hidden="true">→</span></span>
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
        <p>Drop into thoughtful conversations, ask real questions, or start a room about something you know.</p>
        <div class="hero-actions">
          <button class="button button-primary" type="button" data-event-mode="live"><span class="live-dot"></span> Go live</button>
          <button class="button button-secondary" type="button" data-event-mode="scheduled">Schedule live</button>
        </div>
        <p class="hero-note">Listening is always one tap away. No account required.</p>
      </div>
      <div class="hero-board" aria-label="What is happening today">
        <span class="tape tape-one" aria-hidden="true"></span>
        <span class="tape tape-two" aria-hidden="true"></span>
        <div class="board-rule"></div>
        <span class="board-label">Today’s lesson</span>
        <strong>${escape(live[0]?.title ?? upcoming[0]?.title ?? "The best teachers are curious people")}</strong>
        <p>${live[0] ? "Happening right now" : upcoming[0] ? relativeStart(upcoming[0]) : "Host the first live conversation"}</p>
        ${live[0] ? `<a href="${eventPath(live[0])}" data-link class="board-action">Listen now <span>↗</span></a>` : `<button type="button" data-event-mode="live" class="board-action">Start a room <span>↗</span></button>`}
        <div class="board-doodles" aria-hidden="true"><span>?</span><span>✦</span><span>≈</span></div>
      </div>
    </section>

    <section class="event-section" id="live">
      <div class="section-heading">
        <div><span class="eyebrow">Walk in anytime</span><h2>Live now</h2></div>
        <span class="section-count">${live.length} ${live.length === 1 ? "room" : "rooms"}</span>
      </div>
      <div class="event-grid">
        ${live.length ? live.map(eventCard).join("") : `<div class="empty-card"><span>☕</span><h3>The halls are quiet.</h3><p>Start a live and give people something worth dropping into.</p><button class="text-button" data-event-mode="live">Open a room →</button></div>`}
      </div>
    </section>

    <section class="event-section event-section-tint" id="upcoming">
      <div class="section-heading">
        <div><span class="eyebrow">Save your seat</span><h2>Coming up</h2></div>
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

    ${recent.length ? `<section class="event-section"><div class="section-heading"><div><span class="eyebrow">Listen after class</span><h2>Recent replays</h2></div></div><div class="event-grid">${recent.map(eventCard).join("")}</div></section>` : ""}

    <section class="host-callout">
      <span class="eyebrow">Know a thing or two?</span>
      <h2>Someone wants to hear it.</h2>
      <p>You don’t need a studio or a syllabus. Bring an idea and start talking.</p>
      <button class="button button-light" type="button" data-event-mode="scheduled">Plan a conversation</button>
    </section>`;
}

function playerPanel(event: LiveEvent): string {
  const invite = inviteQuery();
  const source = event.recordingId && event.status === "ended"
    ? `/api/v1/recordings/${encodeURIComponent(event.recordingId)}`
    : `/api/channels/${encodeURIComponent(event.roomId)}${invite}`;
  const available = event.status === "live" || Boolean(event.recordingId);
  return `
    <div class="listen-card ${available ? "" : "waiting"}">
      <div class="sound-orbit" aria-hidden="true"><span></span><span></span><span></span><b>▶</b></div>
      <div>
        <span class="eyebrow">${event.status === "live" ? "On air now" : event.recordingId ? "Replay" : "The room opens soon"}</span>
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
    ${account ? `<form id="chat-form" class="inline-form"><input name="body" maxlength="1000" placeholder="Add to the conversation" aria-label="Chat message" required /><button class="button button-small" type="submit">Send</button></form>` : `<button class="text-button" type="button" data-sign-in>Sign in to join the chat →</button>`}`;
}

function panelBody(panel: PanelInstance, event: LiveEvent): string | null {
  switch (panel.type) {
    case "event-header":
      return `<div class="event-heading"><span class="status-pill ${event.status === "live" ? "status-live" : ""}">${escape(relativeStart(event))}</span>${event.topic ? `<span class="topic">${escape(event.topic)}</span>` : ""}<h1>${escape(event.title)}</h1><p>${escape(event.description || "A live conversation powered by NixAmp.")}</p></div>`;
    case "player": return playerPanel(event);
    case "stage": return `<div class="stage-card"><span class="stage-avatar">${escape(event.title.slice(0, 1).toUpperCase())}</span><div><span class="eyebrow">Host stage</span><h2>${escape(event.title)}</h2><p id="broadcast-note">${event.status === "live" ? "This event is live." : "Start when you’re ready."}</p></div></div>`;
    case "host": return `<div class="host-line"><span class="avatar">N</span><div><small>Hosted with</small><strong>NixAmp Live</strong></div></div>`;
    case "about": return `<p class="reading-copy">${escape(event.description || "Come listen, learn, and ask a question live.")}</p>${event.topic ? `<span class="topic topic-large">${escape(event.topic)}</span>` : ""}`;
    case "join": return account ? `<p class="panel-empty">You’re signed in and ready to participate.</p>` : `<div class="join-line"><div><strong>Want to ask something?</strong><p>Join with your NixAmp account.</p></div><button class="button button-secondary" type="button" data-sign-in>Join in</button></div>`;
    case "chat": return chatPanel(event);
    case "questions": return `<div class="panel-empty">Questions shared in chat can be brought onto the stage.</div>`;
    case "resources": return `<div class="panel-empty">The host hasn’t added resources yet.</div>`;
    case "participants": return `<div class="metric"><strong id="listener-count">—</strong><span>listening now</span></div>`;
    case "speakers": return `<div class="people-row"><span class="avatar">H</span><span><strong>Host</strong><small>On stage</small></span></div>`;
    case "raise-hand": return event.handRaiseEnabled ? `<div class="join-line"><div><strong>Have something to add?</strong><p>Let the host know you’d like to speak.</p></div><button class="button button-secondary" type="button" data-raise-hand>Raise hand</button></div>` : null;
    case "hand-raises": return `<div id="hand-raises" class="hand-raises"><p class="muted">No hands raised.</p></div>`;
    case "invite": return `<form id="invite-form" class="form-stack compact"><label>Email<input name="email" type="email" placeholder="someone@example.com" required /></label><label>Invite as<select name="role"><option value="listener">Listener</option><option value="speaker">Speaker</option><option value="moderator">Moderator</option></select></label><button class="button button-small" type="submit">Create invite</button><p id="invite-note" class="form-note"></p></form>`;
    case "share": return `<div class="share-box"><input id="share-url" value="${escape(location.href)}" readonly aria-label="Event URL" /><button class="button button-small" type="button" data-copy>Copy link</button></div>`;
    case "event-controls": return `<div class="control-stack"><button class="button button-primary" type="button" data-broadcast>${event.status === "live" ? "Use this microphone" : "Start live audio"}</button>${event.status === "live" ? `<button class="button button-danger" type="button" data-end-event>End event</button>` : ""}</div>`;
    case "schedule": return `<div class="metric"><strong>${escape(displayDate(event.startsAt))}</strong><span>${escape(event.timezone)}</span></div>`;
    case "recording": return `<div class="control-line"><span>${event.recordingEnabled ? "Recording requested" : "Recording is off"}</span><span class="status-dot ${event.recordingEnabled ? "on" : ""}"></span></div>`;
    default: return null;
  }
}

function panelCard(panel: PanelInstance, event: LiveEvent): string {
  try {
    if (!panel.enabled || !panel.visible) return "";
    if ((panel.permissions ?? []).some((permission) => !hasPermission(permission))) return "";
    const content = panelBody(panel, event);
    if (content === null) return "";
    const title = panel.title || panel.type.replaceAll("-", " ");
    return `<section class="event-panel panel-${escape(panel.type)}" data-panel="${escape(panel.id)}"><span class="panel-title">${escape(title)}</span>${content}</section>`;
  } catch {
    return `<section class="event-panel panel-failed"><span class="panel-title">Panel unavailable</span><p>This part didn’t load. The audio player is unaffected.</p></section>`;
  }
}

async function eventPage(slug: string): Promise<void> {
  const result = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(slug)}${inviteQuery()}`);
  envelope = result;
  const event = result.event;
  document.title = `${event.title} — BackToSchool.help`;
  document.querySelector('meta[name="description"]')?.setAttribute("content", event.description || `Listen to ${event.title} live on BackToSchool.help.`);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", event.title);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", event.description || "Learn something live.");

  const regions = new Map<string, string[]>();
  for (const panel of [...result.layout.panels].sort((a, b) => a.order - b.order)) {
    const rendered = panelCard(panel, event);
    if (!rendered) continue;
    const list = regions.get(panel.region) ?? [];
    list.push(rendered);
    regions.set(panel.region, list);
  }
  main.innerHTML = `
    <div class="event-shell">
      <a class="back-link" href="/" data-link>← Explore more lives</a>
      <div class="event-layout">
        <div class="region region-primary">${(regions.get("primary") ?? []).join("")}</div>
        <aside class="region region-secondary">${(regions.get("secondary") ?? []).join("")}</aside>
        ${(regions.get("sidebar") ?? []).length ? `<aside class="region region-sidebar">${regions.get("sidebar")!.join("")}</aside>` : ""}
        ${(regions.get("bottom") ?? []).length ? `<div class="region region-bottom">${regions.get("bottom")!.join("")}</div>` : ""}
        ${(regions.get("drawer") ?? []).length ? `<div class="region region-drawer">${regions.get("drawer")!.join("")}</div>` : ""}
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
    button.textContent = "Connecting…";
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
      button.textContent = "Hand raised ✓";
    }).catch((error) => {
      button.disabled = false;
      button.textContent = error instanceof ApiError && error.status === 401 ? "Sign in to raise hand" : "Try again";
    });
  });

  document.querySelector<HTMLButtonElement>("[data-broadcast]")?.addEventListener("click", () => void startBroadcast());
  document.querySelector<HTMLButtonElement>("[data-end-event]")?.addEventListener("click", () => void endEvent());
  document.querySelector<HTMLButtonElement>("[data-copy]")?.addEventListener("click", async (click) => {
    await navigator.clipboard.writeText(location.href);
    (click.currentTarget as HTMLButtonElement).textContent = "Copied ✓";
  });

  if (event.chatEnabled) {
    void loadChat(event);
    const chatTimer = window.setInterval(() => void loadChat(event), 4000);
    const raiseTimer = hasPermission("event.moderate")
      ? window.setInterval(() => void loadHandRaises(event), 3000)
      : 0;
    void loadHandRaises(event);
    routeCleanup = () => {
      clearInterval(chatTimer);
      if (raiseTimer) clearInterval(raiseTimer);
    };
  }
  void loadListeners(event);
}

async function loadChat(event: LiveEvent): Promise<void> {
  const target = document.querySelector<HTMLElement>("#chat-messages");
  if (!target) return;
  try {
    const { messages } = await api<{ messages: Array<{ id: string; authorName: string; body: string; createdAt: string }> }>(`/api/v1/events/${encodeURIComponent(event.id)}/chat${inviteQuery()}`);
    target.innerHTML = messages.length ? messages.map((message) => `<div class="chat-message"><span class="avatar avatar-small">${escape(message.authorName.slice(0, 1).toUpperCase())}</span><p><strong>${escape(message.authorName)}</strong><span>${escape(message.body)}</span></p></div>`).join("") : `<p class="muted">No messages yet. Say hello when you’re ready.</p>`;
    target.scrollTop = target.scrollHeight;
  } catch {
    target.innerHTML = `<p class="muted">Chat is taking a break. The audio still works.</p>`;
  }
}

async function loadHandRaises(event: LiveEvent): Promise<void> {
  const target = document.querySelector<HTMLElement>("#hand-raises");
  if (!target || !hasPermission("event.moderate")) return;
  try {
    const { handRaises } = await api<{ handRaises: Array<{ accountId: string; displayName: string; state: string; raisedAt: string }> }>(`/api/v1/events/${encodeURIComponent(event.id)}/hand-raises`);
    target.innerHTML = handRaises.length ? handRaises.map((raise) => `<div class="raise-row"><span><strong>${escape(raise.displayName)}</strong><small>${escape(raise.state)}</small></span><div><button class="text-button" data-hand="${escape(raise.accountId)}" data-state="invited">Invite</button><button class="text-button" data-hand="${escape(raise.accountId)}" data-state="dismissed">Dismiss</button></div></div>`).join("") : `<p class="muted">No hands raised.</p>`;
  } catch {
    target.innerHTML = `<p class="muted">Could not refresh hand raises.</p>`;
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

async function startBroadcast(): Promise<void> {
  if (!envelope || broadcaster) return;
  const button = document.querySelector<HTMLButtonElement>("[data-broadcast]");
  const note = document.querySelector<HTMLElement>("#broadcast-note");
  try {
    button?.setAttribute("disabled", "true");
    if (note) note.textContent = "Asking for your microphone…";
    let event = envelope.event;
    if (event.status !== "live") {
      const result = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(event.id)}/start`, {
        method: "POST",
        body: JSON.stringify({ version: event.version }),
      });
      envelope = result;
      event = result.event;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const choices = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = choices.find((choice) => MediaRecorder.isTypeSupported(choice)) ?? "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const state = { recorder, stream, queue: Promise.resolve() };
    broadcaster = state;
    recorder.addEventListener("dataavailable", (chunk) => {
      if (!chunk.data.size) return;
      state.queue = state.queue.then(async () => {
        const answer = await fetch(`/api/channels/${encodeURIComponent(event.roomId)}/chunk?format=${encodeURIComponent(recorder.mimeType || "webm")}&name=${encodeURIComponent(event.title)}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": recorder.mimeType || "audio/webm" },
          body: chunk.data,
        });
        if (!answer.ok) throw new Error("NixAmp could not publish this audio");
      });
    });
    recorder.start(1000);
    if (button) {
      button.disabled = false;
      button.textContent = "Stop this microphone";
      button.dataset.stopBroadcast = "true";
      button.onclick = () => void stopMicrophone();
    }
    if (note) note.textContent = "Your microphone is live through NixAmp.";
  } catch (error) {
    if (button) button.disabled = false;
    if (note) note.textContent = error instanceof Error ? error.message : "Could not start the microphone.";
  }
}

async function stopMicrophone(): Promise<void> {
  const active = broadcaster;
  if (!active) return;
  broadcaster = null;
  const stopped = new Promise<void>((resolve) => active.recorder.addEventListener("stop", () => resolve(), { once: true }));
  active.recorder.stop();
  active.stream.getTracks().forEach((track) => track.stop());
  await stopped;
  await active.queue.catch(() => undefined);
  const note = document.querySelector<HTMLElement>("#broadcast-note");
  if (note) note.textContent = "This microphone is off. The event is still open.";
  const button = document.querySelector<HTMLButtonElement>("[data-broadcast]");
  if (button) {
    button.textContent = "Use this microphone";
    button.onclick = () => void startBroadcast();
  }
}

async function endEvent(): Promise<void> {
  if (!envelope) return;
  await stopMicrophone();
  const event = envelope.event;
  try {
    const result = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(event.id)}/end`, {
      method: "POST",
      body: JSON.stringify({ version: event.version }),
    });
    envelope = result;
    await fetch(`/api/channels/${encodeURIComponent(event.roomId)}`, { method: "DELETE", credentials: "same-origin" });
    await eventPage(event.slug);
  } catch (error) {
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
  main.focus({ preventScroll: true });
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

eventForm.addEventListener("submit", (submit) => {
  submit.preventDefault();
  const data = new FormData(eventForm);
  eventSubmit.disabled = true;
  eventError.textContent = "";
  const starts = String(data.get("startsAt") ?? "");
  const input = {
    title: data.get("title"),
    description: data.get("description"),
    topic: data.get("topic"),
    visibility: data.get("visibility"),
    chatEnabled: data.get("chatEnabled") === "on",
    handRaiseEnabled: data.get("handRaiseEnabled") === "on",
    recordingEnabled: data.get("recordingEnabled") === "on",
    ...(scheduling ? {
      startsAt: new Date(starts).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      expectedDurationMinutes: Number(data.get("expectedDurationMinutes")),
    } : {}),
  };
  void api<EventEnvelope>("/api/v1/events", { method: "POST", body: JSON.stringify(input) })
    .then(async (created) => {
      let current = created;
      if (!scheduling) {
        current = await api<EventEnvelope>(`/api/v1/events/${encodeURIComponent(created.event.id)}/start`, {
          method: "POST",
          body: JSON.stringify({ version: created.event.version }),
        });
      }
      eventDialog.close();
      eventForm.reset();
      navigate(eventPath(current.event));
    })
    .catch((error) => { eventError.textContent = error instanceof Error ? error.message : "Could not create the event."; })
    .finally(() => { eventSubmit.disabled = false; });
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
window.addEventListener("beforeunload", () => {
  broadcaster?.stream.getTracks().forEach((track) => track.stop());
});

void readAccount().then(() => route());
