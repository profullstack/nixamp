import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, writeZip, zipSize } from "../src/zip-stream.ts";

test("crc32 matches the published check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("a streamed zip opens with unzip, names in folders, sizes known up front", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-zip-"));
  try {
    const song = join(top, "song.mp3");
    writeFileSync(song, Buffer.alloc(300_000, 9));
    const entries = [
      { name: "Velvet Ruckus/2026-Record 1/001. Song – one.mp3", path: song },
      { name: "Velvet Ruckus/2026-Record 1/001. Song – one.lyrics.txt", bytes: Buffer.from("[Verse]\nhello\n") },
    ];
    const file = join(top, "out.zip");
    const out = createWriteStream(file);
    await writeZip(out, entries);
    await new Promise<void>((done) => out.end(done));
    assert.equal(statSync(file).size, zipSize(entries));
    let listing = "";
    try {
      listing = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return; // no unzip on this machine
      throw error;
    }
    assert.match(listing, /No errors detected/);
    // unzip prints names in the machine's locale, so match around the dash.
    assert.match(listing, /Velvet Ruckus\/2026-Record 1\/001\. Song .+ one\.mp3/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
