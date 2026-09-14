/** The entry point: styles, the app, and the service worker that makes it installable. */
import "./styles.css";
import { start } from "./app.ts";
import { installAccessibility } from "./accessibility.ts";

import { installI18n } from "./i18n.ts";

start();
void installI18n();
installAccessibility();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  globalThis.addEventListener("load", () => {
    // A failed registration is not a reason to lose the player.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
