/**
 * Build the CLI-only release tarball.
 *
 * The same tree the desktop bundle carries, without Electron around it. nixamp
 * is pure JavaScript and its one dependency has no native code, so a single
 * archive runs anywhere a Node 24 does and there is nothing to build per
 * platform.
 *
 *   bun scripts/pack-cli.ts            -> release/nixamp-cli-<version>.tar.gz
 *   bun scripts/pack-cli.ts --out DIR
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "..");
const require = createRequire(join(repo, "package.json"));

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(outIndex === -1 ? join(repo, "release") : (args[outIndex + 1] as string));

const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const name = `nixamp-cli-${version}`;

/** Where a dependency really lives, symlinks and hoisting resolved. */
function packageDir(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

const parts: { from: string; to: string; why: string }[] = [
  { from: join(repo, "dist"), to: "dist", why: "run `bun run build`" },
  { from: join(repo, "bin"), to: "bin", why: "the repo is incomplete" },
  { from: join(repo, "web", "dist"), to: join("web", "dist"), why: "run `bun run web:build`" },
  { from: join(repo, "package.json"), to: "package.json", why: "the repo is incomplete" },
  { from: join(repo, "README.md"), to: "README.md", why: "the repo is incomplete" },
  { from: join(repo, "LICENSE"), to: "LICENSE", why: "the repo is incomplete" },
  {
    from: packageDir("@profullstack/hqtui"),
    to: join("node_modules", "@profullstack", "hqtui"),
    why: "run `bun install`",
  },
];

const staging = mkdtempSync(join(tmpdir(), "nixamp-cli-"));
const root = join(staging, name);
mkdirSync(root, { recursive: true });

for (const { from, to, why } of parts) {
  if (!existsSync(from)) {
    console.error(`nixamp: ${from} is missing — ${why}.`);
    process.exit(1);
  }
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  // dereference, so a linked dependency is copied rather than pointed at.
  cpSync(from, target, { recursive: true, dereference: true });
}

mkdirSync(outDir, { recursive: true });
const archive = join(outDir, `${name}.tar.gz`);
rmSync(archive, { force: true });

const tar = spawnSync("tar", ["-czf", archive, "-C", staging, name], { stdio: "inherit" });
rmSync(staging, { recursive: true, force: true });
if (tar.status !== 0) process.exit(tar.status ?? 1);

console.log(`wrote ${archive}`);
