/**
 * Stage the CLI for the bundle.
 *
 * The desktop app carries a complete nixamp so that installing it installs a
 * working player with no system Node anywhere near it. Copying it here rather
 * than pointing electron-builder at the repo does two things: it dereferences
 * the package manager's symlinks (bun links dependencies, and a symlink
 * packages as a dangling one), and it fails loudly when a piece is missing
 * instead of shipping a bundle with a hole in it.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..");
const staging = join(here, "..", "staging", "cli");

const require = createRequire(join(repo, "package.json"));

/** Where a dependency really lives, symlinks and hoisting resolved. */
function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

const parts: { from: string; to: string; why: string }[] = [
  { from: join(repo, "dist"), to: join(staging, "dist"), why: "run `bun run build`" },
  { from: join(repo, "bin"), to: join(staging, "bin"), why: "the repo is incomplete" },
  { from: join(repo, "web", "dist"), to: join(staging, "web", "dist"), why: "run `bun run web:build`" },
  { from: join(repo, "package.json"), to: join(staging, "package.json"), why: "the repo is incomplete" },
  { from: join(repo, "LICENSE"), to: join(staging, "LICENSE"), why: "the repo is incomplete" },
  {
    from: packageDir("@profullstack/hqtui"),
    to: join(staging, "node_modules", "@profullstack", "hqtui"),
    why: "run `bun install`",
  },
];

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const { from, to, why } of parts) {
  if (!existsSync(from)) {
    console.error(`nixamp: ${from} is missing — ${why}.`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  // dereference, so a linked dependency is copied rather than pointed at.
  cpSync(from, to, { recursive: true, dereference: true });
}

console.log(`staged the CLI into ${staging}`);
