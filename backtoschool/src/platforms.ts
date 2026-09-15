import { t, uiText } from "../../web/src/i18n.ts";

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: InstallPrompt | null = null;
let prompting = false;
let installed = window.matchMedia("(display-mode: standalone)").matches
  || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as InstallPrompt;
});

window.addEventListener("appinstalled", () => {
  installed = true;
  installPrompt = null;
  const label = document.querySelector<HTMLElement>("[data-pwa-label]");
  if (label) uiText(label, () => t("PWA installed"));
});

export function platformBadges(): string {
  const pwaLabel = installed ? "PWA installed" : "Install PWA";
  return `<div class="platforms" role="group" aria-label="Supported platforms" data-i18n-aria-label="Supported platforms">
    <div class="platform-badges">
      <a class="platform-badge platform-fire-tv" href="https://amzn.to/4cGaS1m">
        <img src="/platform-icons/amazon.svg" width="28" height="28" alt="" />
        <span><small>Amazon Appstore</small><strong>Amazon Fire TV</strong><small>Fire TV Stick</small></span>
      </a>
      <button class="platform-badge platform-pwa" type="button" data-install-pwa>
        <img src="/platform-icons/pwa.svg" width="40" height="40" alt="" />
        <span><small data-pwa-label data-i18n="${pwaLabel}">${pwaLabel}</small><strong data-i18n="Web app">Web app</strong></span>
      </button>
      <button class="platform-badge platform-unavailable" type="button" disabled>
        <img src="/platform-icons/apple.svg" width="28" height="28" alt="" />
        <span><small data-i18n="Not available">Not available</small><strong>App Store</strong></span>
      </button>
      <button class="platform-badge platform-unavailable" type="button" disabled>
        <img src="/platform-icons/google-play.svg" width="28" height="28" alt="" />
        <span><small data-i18n="Not available">Not available</small><strong>Google Play</strong></span>
      </button>
    </div>
  </div>`;
}

function showInstallHelp(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#pwa-dialog")!;
  dialog.querySelector<HTMLElement>("[data-pwa-instructions]")!.hidden = installed;
  dialog.querySelector<HTMLElement>("[data-pwa-installed]")!.hidden = !installed;
  if (!dialog.open) dialog.showModal();
}

document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-install-pwa]");
  if (!button || prompting) return;
  if (installed || !installPrompt) {
    showInstallHelp();
    return;
  }
  const prompt = installPrompt;
  installPrompt = null;
  prompting = true;
  button.setAttribute("aria-busy", "true");
  // Invoke the native prompt during this click; browsers require a user gesture.
  void prompt.prompt().catch(() => {
    // Keep asynchronous failures in place, without moving focus to a dialog.
    const status = document.querySelector<HTMLElement>("#pwa-status");
    if (status) uiText(status, () => t("The install prompt could not open. Select Web app again for installation instructions."));
  }).finally(() => {
    prompting = false;
    button.removeAttribute("aria-busy");
  });
});

document.querySelector<HTMLDialogElement>("#pwa-dialog")!.addEventListener("close", () => {
  document.querySelector<HTMLButtonElement>("[data-install-pwa]")?.focus({ preventScroll: true });
});
