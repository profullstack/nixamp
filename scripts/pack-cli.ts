/**
 * Build the CLI-only release tarball.
 *
 * The same tree the desktop bundle carries, without Electron around it. nixamp
 * is pure JavaScript and none of its dependencies have native code, so a single
 * archive runs anywhere a Node 24 does and there is nothing to build per
 * platform.
 *
 * Every runtime dependency is walked and copied, transitively. It used to be
 * one name written out by hand, which was true when there was one. By 0.4.0
 * there were five, and the four nobody had added to this list were missing from
 * the tarball: the CLI installed, and then died on its first import with
 * "Cannot find package '@profullstack/auth-system'". A list of dependencies
 * maintained separately from the dependencies is a list that goes stale
 * silently, so this reads package.json instead of naming anything.
 *
 *   bun scripts/pack-cli.ts            -> release/nixamp-cli-<version>.tar.gz
 *   bun scripts/pack-cli.ts --out DIR
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(outIndex === -1 ? join(repo, "release") : (args[outIndex + 1] as string));

const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const name = `nixamp-cli-${version}`;

const nodeModules = join(repo, "node_modules");

/**
 * Where `pkg` resolves to when required from `from`.
 *
 * Two ways, because a package with an "exports" map that does not list
 * ./package.json cannot be resolved by that path at all, and several
 * transitive dependencies are like that. The fallback is what Node itself
 * does: walk up looking for node_modules/<pkg>.
 */
function resolveFrom(pkg: string, from: string): string | null {
  try {
    return dirname(createRequire(from).resolve(`${pkg}/package.json`));
  } catch {
    let at = dirname(from);
    for (;;) {
      const candidate = join(at, "node_modules", pkg);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/**
 * Every runtime dependency, transitively, laid out flat under node_modules.
 *
 * By the name it is required as, never by where it was found. bun keeps the
 * real directories in node_modules/.bun/<name>@<version>/node_modules/<name>
 * and symlinks the names beside them, so copying resolved paths verbatim
 * produces a tarball whose every package sits somewhere Node will not look:
 * node_modules/.bun/... exists, node_modules/pg does not, and the CLI dies on
 * its first import exactly as if nothing had been packed.
 *
 * Flat is what a published install looks like anyway. Two versions of one name
 * cannot both live here, so that case fails the build rather than shipping
 * whichever was reached first.
 */
function runtimeDependencies(): { from: string; to: string }[] {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  const queue = Object.keys(root.dependencies ?? {}).map((pkg) => ({ pkg, from: join(repo, "package.json") }));
  while (queue.length > 0) {
    const { pkg, from } = queue.shift() as { pkg: string; from: string };
    const dir = resolveFrom(pkg, from);
    // An optional dependency this platform did not install is not an error.
    if (dir === null || seen.has(dir)) continue;
    seen.add(dir);

    // A workspace sibling resolves outside node_modules. It is already in the
    // tarball by another route, and copying it here would nest a second copy.
    if (relative(nodeModules, dir).startsWith("..")) continue;

    const existing = found.get(pkg);
    if (existing !== undefined && existing !== dir) {
      console.error(`nixamp: ${pkg} resolves to two different directories, which a flat layout cannot hold:`);
      console.error(`  ${existing}`);
      console.error(`  ${dir}`);
      process.exit(1);
    }
    found.set(pkg, dir);

    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    // Optional ones too. "Optional" describes installing them, not importing
    // them: @profullstack/auth-system lists five database adapters as optional
    // and then statically re-exports all five from its index, so importing it
    // at all loads whichever of them are on disk. One that was never installed
    // resolves to null above and is skipped, which is the behaviour the field
    // is actually asking for.
    for (const next of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) {
      queue.push({ pkg: next, from: join(dir, "package.json") });
    }
  }

  return [...found].map(([pkg, dir]) => ({ from: dir, to: join("node_modules", ...pkg.split("/")) }));
}

const parts: { from: string; to: string; why: string }[] = [
  { from: join(repo, "dist"), to: "dist", why: "run `bun run build`" },
  { from: join(repo, "bin"), to: "bin", why: "the repo is incomplete" },
  { from: join(repo, "web", "dist"), to: join("web", "dist"), why: "run `bun run web:build`" },
  { from: join(repo, "package.json"), to: "package.json", why: "the repo is incomplete" },
  { from: join(repo, "README.md"), to: "README.md", why: "the repo is incomplete" },
  { from: join(repo, "LICENSE"), to: "LICENSE", why: "the repo is incomplete" },
  ...runtimeDependencies().map(({ from, to }) => ({ from, to, why: "run `bun install`" })),
];

// A tarball with no dependencies in it installs and then dies on its first
// import, so this is worth failing the build over rather than shipping.
const packed = parts.filter((p) => p.to.startsWith("node_modules")).length;
if (packed === 0) {
  console.error("nixamp: no runtime dependencies were resolved — run `bun install`.");
  process.exit(1);
}
console.log(`nixamp: packing ${packed} runtime dependencies.`);

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
