import { attachSource, type AttachedSource } from "@profullstack/player";
import { classroomBroadcast } from "../../src/classroom.ts";
import { t } from "../../src/i18n.ts";
import { uiText, uiAttribute } from "../../web/src/i18n.ts";
import { classroomSource } from "./player-source.ts";
import { isTv } from "./tv.ts";

export function mountClassroomPlayer(root: HTMLElement, value: unknown): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const broadcast = classroomBroadcast(value);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.className = "player-status";
  const say = (message: string) => { if (!signal.aborted) uiText(status, () => t(message)); };
  if (broadcast?.provider === "pairux") {
    root.append(status);
    say("This Pairux broadcast opens separately. For playback here on Fire TV, the host needs to share a Nixamp stream or direct media link.");
    if (!isTv()) {
      const link = document.createElement("a"); link.className = "button button-secondary";
      link.href = broadcast.join; link.target = "_blank"; link.rel = "noopener noreferrer";
      uiText(link, () => t("Open on Pairux")); root.append(link);
    }
    return () => controller.abort();
  }
  const video = document.createElement("video");
  video.playsInline = true; video.preload = "none";
  uiAttribute(video, "aria-label", () => t("Class broadcast"));
  const controls = document.createElement("div"); controls.className = "classroom-controls";
  root.append(video, controls, status);
  let attached: AttachedSource | null = null;
  let pending = false;
  let ready = false;
  let failed = false;
  let live = false;
  let expanded = false;
  const button = (label: string, action: () => void) => {
    const el = document.createElement("button"); el.type = "button"; el.className = "button button-secondary";
    uiText(el, () => t(label)); el.addEventListener("click", action, { signal }); controls.append(el); return el;
  };
  const fail = () => { if (signal.aborted) return; failed = true; say("The broadcast could not be loaded. Try again."); uiText(play, () => t("Retry playback")); };
  const updatePlay = () => uiText(play, () => t(failed ? "Retry playback" : video.paused ? "Play" : "Pause"));
  async function toggle(): Promise<void> {
    if (pending || signal.aborted) return;
    if (ready && !failed && !video.paused) { video.pause(); return; }
    pending = true;
    try {
      if (!ready || failed) {
        ready = false; failed = false; attached?.destroy(); attached = null;
        say("Connecting…");
        const source = await classroomSource(value, signal);
        if (signal.aborted) return;
        if (!source) throw new Error("No playable source");
        live = source.live;
        const connection = await attachSource(video, {
          ...source, isTv: isTv(),
          onError: fail,
          onReady: info => { live = info.live; updateSeek(); },
        });
        if (signal.aborted) { connection.destroy(); return; }
        attached = connection;
        if (connection.unplayable) throw new Error(connection.unplayable);
        ready = true;
      }
      await video.play();
      say("Playing");
    } catch { if (!signal.aborted) fail(); }
    finally { pending = false; if (!signal.aborted) updatePlay(); }
  }
  const play = button("Play", () => { void toggle(); });
  function seek(seconds: number): void {
    if (live || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  }
  const back = button("Back 10 seconds", () => seek(-10));
  const forward = button("Forward 10 seconds", () => seek(10));
  function updateSeek(): void {
    const disabled = live || !Number.isFinite(video.duration) || video.duration <= 0;
    back.disabled = disabled; forward.disabled = disabled;
  }
  updateSeek();
  const mute = button("Mute", () => { video.muted = !video.muted; });
  function expand(on: boolean): void {
    expanded = on; root.classList.toggle("is-expanded", on);
    fullscreen.setAttribute("aria-pressed", String(on));
    uiText(fullscreen, () => t(on ? "Exit full screen" : "Full screen"));
  }
  const fullscreen = button("Full screen", () => expand(!expanded));
  fullscreen.setAttribute("aria-pressed", "false");
  video.addEventListener("play", updatePlay, { signal });
  video.addEventListener("pause", () => { updatePlay(); if (!failed) say("Paused"); }, { signal });
  video.addEventListener("ended", () => { updatePlay(); if (!failed) say("Broadcast ended"); }, { signal });
  video.addEventListener("error", fail, { signal });
  video.addEventListener("loadedmetadata", updateSeek, { signal });
  video.addEventListener("durationchange", updateSeek, { signal });
  video.addEventListener("volumechange", () => uiText(mute, () => t(video.muted ? "Unmute" : "Mute")), { signal });
  const onRemote = (key: string): boolean => {
    if (document.querySelector("dialog[open]") || (document.activeElement as HTMLElement | null)?.matches("input, textarea, select, [contenteditable=true]")) return false;
    if (["Escape", "BrowserBack", "Back"].includes(key) && expanded) { expand(false); fullscreen.focus({ preventScroll: true }); return true; }
    if (key === "MediaPlayPause") { void toggle(); return true; }
    if (key === "MediaPlay") { if (video.paused) void toggle(); return true; }
    if (key === "MediaPause") { video.pause(); return true; }
    if (key === "MediaRewind") { seek(-10); return true; }
    if (key === "MediaFastForward") { seek(10); return true; }
    return false;
  };
  document.addEventListener("keydown", event => {
    if (onRemote(event.key)) event.preventDefault();
    if (expanded && event.key === "Tab") {
      const buttons = [...controls.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
    }
  }, { signal });
  // The Fire TV shell forwards media keys and gives Back to the player first.
  const bridge = (event: Event) => { if (onRemote((event as CustomEvent<string>).detail)) event.preventDefault(); };
  document.addEventListener("backtoschool-remote", bridge, { signal });
  say("Select Play to watch the broadcast.");
  return () => { controller.abort(); attached?.destroy(); video.pause(); video.removeAttribute("src"); video.load(); root.classList.remove("is-expanded"); };
}
