import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const bin = join(repo, "bin", "nixamp.mjs");
const built = existsSync(join(repo, "dist", "main.js"));
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
  version: string;
  bin: Record<string, string>;
  files: string[];
};

const run = (args: string[]): { out: string; code: number | null } => {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 20_000 });
  return { out: `${result.stdout}${result.stderr}`, code: result.status };
};

/**
 * The installed binary is the one thing no unit test touches, and it is where
 * `import.meta.main` quietly does nothing: the flag is false in an imported
 * module, so importing dist/main.js for its side effect ran no player at all.
 */
test("the installed binary actually runs the CLI",
  { skip: built ? false : "run `bun run build` first" },
  () => {
    const version = run(["--version"]);
    assert.equal(version.code, 0);
    assert.equal(version.out.trim(), manifest.version);

    const help = run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /nixamp \[source\]/);
    assert.match(help.out, /nixamp serve/);
    assert.match(help.out, /nixamp daemon start\|restart\|stop\|status/);
    assert.match(help.out, /nixamp admin/);
    assert.match(help.out, /--port/);
    assert.match(help.out, /--open-port/);
  });

test("what npm publishes contains what the binary and the server need", () => {
  assert.equal(manifest.bin.nixamp, "./bin/nixamp.mjs");
  for (const needed of ["dist", "bin", "web/dist"]) {
    assert.ok(manifest.files.includes(needed), `"${needed}" is not in files`);
  }
});
