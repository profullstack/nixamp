/**
 * `nixamp update` and `nixamp uninstall`.
 *
 * Both belong on the CLI rather than in a second script the user has to find.
 * Removal reads the manifest the installer wrote, so it is exact and works
 * offline: a tool that needs the network to uninstall itself is one you cannot
 * remove on a plane.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What the installer recorded about this install. */
export interface Manifest {
  version: string;
  method: string;
  installer: string;
  installedAt: string;
  prefix: string;
  desktop: boolean;
  paths: string[];
}

const SITE = "https://nixamp.com";

/** Windows has its own installer, its own shim and its own removal script. */
const windows = process.platform === "win32";

/**
 * Where the installer put things. `NIXAMP_HOME` is exported by the shim it
 * wrote, which is the only thing that knows for certain; the walk up from this
 * file covers a shim from an older install that did not set it.
 */
export function installRoot(from = fileURLToPath(new URL(".", import.meta.url))): string | null {
  const declared = process.env["NIXAMP_HOME"];
  if (declared && existsSync(join(declared, "manifest.json"))) return declared;

  // dist/ -> the CLI directory -> share/nixamp for a CLI-only install, or the
  // app bundle's resources for a desktop one.
  let dir = resolve(from);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "manifest.json"))) return dir;
    const share = join(dir, "share", "nixamp");
    if (existsSync(join(share, "manifest.json"))) return share;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readManifest(root: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/**
 * The message for a copy that no installer put here: a checkout, an npx run, or
 * a package manager's own install. Telling someone to run `rm -rf` on a
 * directory we did not create would be worse than saying so.
 */
function notInstalled(what: string): number {
  console.error(`nixamp: this copy was not put here by the installer, so there is nothing to ${what}.`);
  console.error("");
  console.error("  Installed with npm or bun:  npm uninstall -g nixamp");
  console.error("  Running from a checkout:    delete the checkout");
  console.error(
    windows
      ? `  Wanted the installed one:   irm ${SITE}/install.ps1 | iex`
      : `  Wanted the installed one:   curl -fsSL ${SITE}/install.sh | sh`,
  );
  return 69;
}

/**
 * Update by re-running the installer with the same choices. It is the one
 * place that knows how to lay an install out, so an update gets every fix the
 * installer has had since, rather than only a newer tarball.
 */
export function update(argv: string[]): number {
  const root = installRoot();
  const manifest = root ? readManifest(root) : null;
  if (!root || !manifest) return notInstalled("update");

  const installer = manifest.installer || `${SITE}/${windows ? "install.ps1" : "install.sh"}`;
  const wanted = argv.find((a) => !a.startsWith("-"));

  console.log(`nixamp ${manifest.version} is installed. Fetching the installer...`);

  if (windows) {
    // PowerShell fetches and runs it in one expression, which is also the
    // documented install line, so an update takes a fresh install's path.
    const flags = [manifest.desktop ? "" : "-CliOnly", "-Prefix", quote(manifest.prefix)];
    if (wanted) flags.push("-Version", quote(wanted));
    const expression = `& ([scriptblock]::Create((irm ${installer}))) ${flags.filter(Boolean).join(" ")}`;
    const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", expression], {
      stdio: "inherit",
    });
    return run.status ?? 1;
  }

  const args = ["-s", "--", manifest.desktop ? "--desktop" : "--cli-only", "--prefix", manifest.prefix];
  if (wanted) args.push("--version", wanted);

  const fetcher = which("curl") ? ["curl", "-fsSL", installer] : which("wget") ? ["wget", "-qO-", installer] : null;
  if (!fetcher) {
    console.error("nixamp: curl or wget is required to update.");
    return 69;
  }

  // Piping the script into sh is what the documented install line does, so an
  // update takes exactly the path a fresh install takes.
  const script = spawnSync(fetcher[0] as string, fetcher.slice(1), { encoding: "utf8" });
  if (script.status !== 0 || !script.stdout) {
    console.error(`nixamp: could not fetch ${installer}`);
    return 1;
  }
  const run = spawnSync("sh", args, { input: script.stdout, stdio: ["pipe", "inherit", "inherit"] });
  return run.status ?? 1;
}

/** Run the uninstall script the installer left beside the manifest. */
export function uninstall(argv: string[]): number {
  const root = installRoot();
  const manifest = root ? readManifest(root) : null;
  if (!root || !manifest) return notInstalled("uninstall");

  // Saying what would go needs only the manifest, so it comes first: a missing
  // script is a problem for removing, not for describing.
  if (!argv.includes("--yes") && !argv.includes("-y")) {
    console.log(`This removes nixamp ${manifest.version} and everything the installer created:`);
    for (const path of manifest.paths) console.log(`  ${path}`);
    console.log("");
    console.log("Your music is not touched. Run `nixamp uninstall --yes` to go ahead.");
    return 0;
  }

  const script = join(root, windows ? "uninstall.ps1" : "uninstall.sh");
  if (!existsSync(script)) {
    console.error(`nixamp: ${script} is missing, so removal cannot be exact.`);
    console.error(`  The manifest lists: ${manifest.paths.join(", ")}`);
    return 1;
  }

  const run = windows
    ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: "inherit" })
    : spawnSync("sh", [script], { stdio: "inherit" });
  return run.status ?? 1;
}

/** A PowerShell single-quoted string: the only escape inside one is a doubled quote. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function which(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}
