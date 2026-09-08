/** Facts about this install that both the terminal app and the server want. */
import { readFileSync } from "node:fs";

/** The version we were installed as, or 0.0.0 when the manifest is missing. */
export function version(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
