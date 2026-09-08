/**
 * Vanilla TypeScript and Vite: the player is a few hundred lines of DOM, and a
 * framework would be the largest thing in the bundle.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { serviceWorkerSource } from "./scripts/sw.ts";
import { writeIcons } from "./scripts/icons.ts";

const here = new URL(".", import.meta.url).pathname;
const publicDir = resolve(here, "public");
const INSTALLER = "install.sh";

/** Every file under `dir`, as web paths. */
function walk(dir: string, base = dir): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full, base)
      : [`/${relative(base, full)}`];
  });
}

/**
 * The icons are drawn from source on every build, so the mark in the manifest
 * and the mark in the repo cannot drift apart.
 */
function icons(): Plugin {
  return {
    name: "nixamp-icons",
    buildStart() {
      writeIcons(publicDir);
    },
  };
}

/**
 * The one file on the site that is not part of the app: the installer, served
 * at /install.sh so `curl -fsSL https://nixamp.com/install.sh | sh` reaches the
 * same script the repo ships. Emitted from source rather than copied into
 * public/, because two copies of an installer drift and only one of them is
 * the one people run.
 */
function installer(): Plugin {
  return {
    name: "nixamp-installer",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: INSTALLER,
        source: readFileSync(resolve(here, "..", "scripts", "install.sh"), "utf8"),
      });
    },
  };
}

/**
 * The service worker is emitted last, because its precache list is the set of
 * files the build just produced — hashes and all.
 */
function serviceWorker(version: string): Plugin {
  return {
    name: "nixamp-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle)
        .filter((file) => file !== INSTALLER)
        .map((file) => `/${file}`);
      // Public files are copied straight through and never appear in the bundle.
      const statics = walk(publicDir).filter((file) => !file.endsWith(".map"));
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: serviceWorkerSource([...emitted, ...statics], version),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // A hash of the build inputs would be neater, but a timestamp is what
  // actually changes when a deploy happens, which is when caches must roll.
  plugins: [icons(), installer(), serviceWorker(process.env.NIXAMP_BUILD_ID ?? String(Date.now()))],
  publicDir,
  build: {
    target: "es2022",
    sourcemap: mode !== "production",
    // Hashed filenames, so the service worker's precache list is exact.
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    fs: {
      // src/protocol.ts is shared with the CLI and lives above this directory.
      allow: [resolve(here, "..")],
    },
  },
  preview: { port: 4173 },
}));
