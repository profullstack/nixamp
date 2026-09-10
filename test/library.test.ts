import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askLibrary, forbiddenLibrary, readLibrary, suggestedLibraries, writeLibrary } from "../src/library.ts";

test("the folders that must never be served, however they are spelled", () => {
  const home = "/home/me";
  assert.equal(forbiddenLibrary("/", home), "the whole filesystem");
  assert.equal(forbiddenLibrary("/home/me", home), "your whole home directory");
  assert.equal(forbiddenLibrary("/home/me/", home), "your whole home directory");
  assert.equal(forbiddenLibrary("/home/me/Music/..", home), "your whole home directory");
  assert.equal(forbiddenLibrary("/home", home), "a folder above your home directory");
  assert.match(forbiddenLibrary("/home/me/.ssh", home), /hidden folder \(\.ssh\)/);
  assert.match(forbiddenLibrary("/home/me/.local/state", home), /hidden folder \(state\)|hidden folder/);
  // What may be served: a folder of media, anywhere sensible.
  assert.equal(forbiddenLibrary("/home/me/Music", home), "");
  assert.equal(forbiddenLibrary("/home/me/Downloads/done", home), "");
  assert.equal(forbiddenLibrary("/srv/media", home), "");
  assert.equal(forbiddenLibrary("/home/other", home), "");
});

test("anything under a hidden folder in home is refused, however deep", () => {
  const home = "/home/me";
  assert.notEqual(forbiddenLibrary("/home/me/.config", home), "");
  // ~/.local/share/media is still under ~/.local, which holds the keys.
  assert.match(forbiddenLibrary("/home/me/.local/share/media", home), /hidden folder \(\.local\)/);
  // Outside home a dotted folder is somebody's deliberate choice.
  assert.equal(forbiddenLibrary("/srv/.media", home), "");
});

test("the library is saved beside the keys and read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-library-"));
  const before = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = dir;
  try {
    assert.equal(readLibrary(), "");
    writeLibrary("/srv/media/../media");
    assert.equal(readLibrary(), "/srv/media");
    const written = JSON.parse(readFileSync(join(dir, "nixamp", "config.json"), "utf8")) as { library: string };
    assert.equal(written.library, "/srv/media");
  } finally {
    if (before === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = before;
  }
});

test("asking refuses the home directory and keeps the folder that was named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-library-"));
  const home = join(dir, "home");
  mkdirSync(join(home, "Music"), { recursive: true });
  mkdirSync(join(home, "Downloads"), { recursive: true });
  const before = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = join(dir, "state");
  try {
    assert.deepEqual(suggestedLibraries(home), [join(home, "Music"), join(home, "Downloads")]);
    const answers = [home, join(home, "nope"), "~/Downloads"];
    const said: string[] = [];
    const chosen = await askLibrary(async () => answers.shift() ?? "", home, (line) => said.push(line));
    assert.equal(chosen, join(home, "Downloads"));
    assert.ok(said.some((line) => line.includes("will not serve your whole home directory")));
    assert.ok(said.some((line) => line.includes("is not a folder here")));
    assert.equal(readLibrary(), join(home, "Downloads"));

    // Enter on its own takes the first suggestion.
    const byDefault = await askLibrary(async () => "", home, () => undefined);
    assert.equal(byDefault, join(home, "Music"));
  } finally {
    if (before === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = before;
  }
});
