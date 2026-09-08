/**
 * Make sure the Electron binary is actually on disk.
 *
 * bun does not run a workspace dependency's postinstall even when it is
 * trusted, so `bun install` leaves electron without the ~200 MB runtime it
 * downloads for itself. Rather than making that a step in a README, this runs
 * electron's own installer when, and only when, the binary is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const electron = join(here, "..", "node_modules", "electron");
const installer = join(electron, "install.js");
const marker = join(electron, "dist");

if (existsSync(marker)) process.exit(0);

if (!existsSync(installer)) {
  console.error("nixamp: electron is not installed — run `bun install` first.");
  process.exit(1);
}

console.log("nixamp: fetching the Electron runtime (once)…");
const result = spawnSync(process.execPath, [installer], { stdio: "inherit", cwd: electron });
process.exit(result.status ?? 1);
