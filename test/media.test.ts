import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queryable } from "../src/follows.ts";
import {
  CHECK_MAX_MS, CHECK_MIN_MS, Media, checkInterval, contentHash, contentTypeOf, factsFrom, factsFromRequest, fileFacts, holderFrom, mediaId, mergeHolders,
  openFileListing, openFileOf, type MediaRecord,
} from "../src/media.ts";
import { due, look, readIndex, remember, watchOnce, writeIndex } from "../src/media-index.ts";
import { mediaPage } from "../src/media-page.ts";

test("a file is its SHA-256, its type comes from its name, and a record's id is hex with or without the prefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-media-"));
  const file = join(dir, "clip.mp4");
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 3);
  writeFileSync(file, bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await contentHash(file), expected);
  const facts = fileFacts(file);
  assert.equal(facts.name, "clip.mp4");
  assert.equal(facts.size, bytes.length);
  assert.equal(facts.contentType, "video/mp4");
  assert.match(facts.updated, /^\d{4}-\d\d-\d\dT/);
  assert.equal(contentTypeOf("a.MKV"), "video/x-matroska");
  assert.equal(contentTypeOf("a.flac"), "audio/flac");
  assert.equal(contentTypeOf("a.whatever"), "application/octet-stream");
  assert.equal(mediaId(`sha256:${expected.toUpperCase()}`), expected);
  assert.equal(mediaId(expected), expected);
  assert.equal(mediaId("file:v1:" + expected), null);
  assert.equal(mediaId(42), null);
  await assert.rejects(() => contentHash(join(dir, "missing")));
});

test("a file is looked at again after a quarter of the time since it changed, within bounds", () => {
  const now = 1_700_000_000_000;
  assert.equal(checkInterval(now - 60 * 60 * 1000, now), CHECK_MIN_MS);
  assert.equal(checkInterval(now - 4 * 24 * 60 * 60 * 1000, now), 24 * 60 * 60 * 1000);
  assert.equal(checkInterval(now - 365 * 24 * 60 * 60 * 1000, now), CHECK_MAX_MS);
  assert.equal(checkInterval(now + 5000, now), CHECK_MIN_MS);
});

test("facts from ffprobe and nichedb, facts from a request, holders merged by address", () => {
  const facts = factsFrom(
    { video: "h264", audio: "aac", container: "mov,mp4,m4a", duration: 5400.1234, width: 1920, height: 1080, tags: { title: "A film", artist: "" } },
    { kind: "title", title: "A Film", year: 2019, image: "https://img/p.jpg", summary: "About things.", page: "https://nichedb.dev/t/1", score: 0.9, data: {}, tags: [] },
  );
  assert.deepEqual(facts, {
    codecs: { video: "h264", audio: "aac", container: "mov,mp4,m4a" },
    duration: 5400.123,
    width: 1920,
    height: 1080,
    tags: { title: "A film", artist: "" },
    enrichment: { kind: "title", title: "A Film", year: 2019, image: "https://img/p.jpg", summary: "About things.", page: "https://nichedb.dev/t/1" },
  });
  assert.deepEqual(factsFrom({ video: "", audio: "", container: "" }, null), {});

  const asked = factsFromRequest({
    fingerprint: "file:v1:" + "ab".repeat(32), duration: 12.5, width: -1, height: 720, codecs: { video: "hevc", audio: 7 }, tags: { title: "T", album: "" },
    enrichment: { title: "E", year: 2001, image: null }, supersededBy: "sha256:" + "cd".repeat(32), supersedes: "junk", checkedAt: "2026-09-13T10:00:00Z", checkAfter: "nope", extra: 1,
  });
  assert.deepEqual(asked, {
    fingerprint: "file:v1:" + "ab".repeat(32), duration: 12.5, height: 720, codecs: { video: "hevc" }, tags: { title: "T" },
    enrichment: { title: "E", year: 2001 }, supersededBy: "sha256:" + "cd".repeat(32), checkedAt: "2026-09-13T10:00:00.000Z",
  });
  assert.deepEqual(factsFromRequest("no"), {});

  assert.equal(holderFrom({ url: "ftp://x" }), null);
  const h = holderFrom({ url: "https://server1.example:4321/view/K", channel: "url-1", name: "server1", seenAt: "2026-09-13T09:00:00Z", kind: "weird" });
  assert.deepEqual(h, { kind: "gateway", url: "https://server1.example:4321/view/K", seenAt: "2026-09-13T09:00:00.000Z", channel: "url-1", name: "server1" });
  const merged = mergeHolders(
    [{ kind: "gateway", url: "https://a/", seenAt: "2026-09-13T08:00:00.000Z", name: "a" }, { kind: "gateway", url: "https://b", seenAt: "2026-09-13T07:00:00.000Z" }],
    [{ kind: "gateway", url: "https://a", seenAt: "2026-09-13T09:00:00.000Z", channel: "c" }],
  );
  assert.deepEqual(merged.map((one) => `${one.url}@${one.seenAt}${one.name ? `:${one.name}` : ""}${one.channel ? `/${one.channel}` : ""}`), [
    "https://a@2026-09-13T09:00:00.000Z:a/c",
    "https://b@2026-09-13T07:00:00.000Z",
  ]);
});

function db() {
  const rows = new Map<string, Record<string, unknown>>();
  const asked: { text: string; values: unknown[] }[] = [];
  const queryable: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      if (text.includes("INSERT INTO media")) {
        const had = rows.get(values[0] as string);
        const row = {
          id: values[0], fingerprint: values[1] || had?.["fingerprint"] || "", name: values[2] || had?.["name"] || "", size: values[3] || had?.["size"] || 0,
          content_type: values[4] || had?.["content_type"] || "", updated: values[5] ?? had?.["updated"] ?? null, facts: JSON.parse(values[6] as string), holders: JSON.parse(values[7] as string),
          by_account: had?.["by_account"] ?? values[8], created_at: had?.["created_at"] ?? new Date("2026-09-13T09:00:00.000Z"), updated_at: new Date("2026-09-13T10:00:00.000Z"),
        };
        rows.set(values[0] as string, row);
        return { rows: [row] };
      }
      if (text.includes("WHERE id = $1")) {
        const row = rows.get(values[0] as string);
        return { rows: row ? [row] : [] };
      }
      if (text.includes("WHERE fingerprint = $1")) {
        return { rows: [...rows.values()].filter((row) => row["fingerprint"] === values[0]) };
      }
      if (text.includes("ORDER BY updated_at DESC LIMIT $1")) return { rows: [...rows.values()] };
      return { rows: [] };
    },
  };
  return { rows, asked, queryable };
}

test("the store keeps the union: facts merge, holders merge, the first keeper stays, and a fingerprint finds the record", async () => {
  const world = db();
  const media = new Media(world.queryable);
  const id = "ab".repeat(32);
  const first = await media.save({ id, name: "film.mkv", size: 100, contentType: "video/x-matroska", updated: "2026-09-01T00:00:00.000Z", facts: { duration: 90, fingerprint: "file:v1:" + "ef".repeat(32) }, by: "acct-1" });
  assert.ok(first);
  assert.equal(first.facts.duration, 90);
  assert.equal(world.asked.filter((q) => q.text.includes("CREATE TABLE")).length, 1);
  const second = await media.save({
    id, facts: { width: 1920, duration: 91 }, holder: { kind: "gateway", url: "https://s1", seenAt: "2026-09-13T09:00:00.000Z", channel: "c1" }, by: "acct-2",
  });
  assert.ok(second);
  assert.deepEqual(second.facts, { duration: 91, fingerprint: "file:v1:" + "ef".repeat(32), width: 1920 });
  assert.equal(second.name, "film.mkv");
  assert.equal(second.by, "acct-1");
  assert.equal(second.holders.length, 1);
  assert.equal((await media.byFingerprint("file:v1:" + "ef".repeat(32)))?.id, id);
  assert.equal(await media.get("00".repeat(32)), null);
  assert.equal((await media.recent()).length, 1);
  const broken: Queryable = { query: async () => { throw new Error("the database is having a moment"); } };
  const said: string[] = [];
  const shaky = new Media(broken, (message) => said.push(message));
  assert.equal(await shaky.quietly("a record", () => shaky.get(id)), null);
  assert.match(said[0] ?? "", /did not persist/);
});

test("an OpenFile file object and listing, and the page, say what the record knows", () => {
  const record: MediaRecord = {
    id: "ab".repeat(32), name: "film.mkv", size: 1024 ** 3 * 1.5, contentType: "video/x-matroska", updated: "2026-09-01T00:00:00.000Z",
    facts: { fingerprint: "file:v1:" + "ef".repeat(32), duration: 5400, width: 1920, height: 1080, codecs: { video: "h264", audio: "aac" }, enrichment: { title: "A Film", year: 2019, image: "https://img/p.jpg", summary: "About <things>.", page: "https://nichedb.dev/t/1" }, checkedAt: "2026-09-13T09:00:00.000Z", checkAfter: "2026-09-14T09:00:00.000Z" },
    holders: [{ kind: "gateway", url: "https://server1.example:4321/view/K", seenAt: "2026-09-13T09:00:00.000Z", channel: "file-1", name: "server1" }],
    by: "acct-1", createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T09:00:00.000Z",
  };
  const file = openFileOf(record, "https://nixamp.com/", [{ language: "en", translatedFrom: null, lines: 700, complete: true }, { language: "sv", translatedFrom: "en", lines: 700, complete: true }]);
  assert.equal(file["id"], `sha256:${"ab".repeat(32)}`);
  assert.equal(file["name"], "film.mkv");
  assert.equal(file["url"], `https://nixamp.com/hash/${"ab".repeat(32)}`);
  assert.equal(file["descriptor"], `https://nixamp.com/hash/${"ab".repeat(32)}.openfile.json`);
  assert.equal(file["encryption"], "none");
  assert.deepEqual(file["fetch"], []);
  assert.equal((file["holders"] as unknown[]).length, 1);
  const nixamp = file["nixamp"] as { transcripts: { url: string }[]; duration: number };
  assert.equal(nixamp.duration, 5400);
  assert.equal(nixamp.transcripts[1]?.url, `https://nixamp.com/hash/${"ab".repeat(32)}.srt?language=sv`);
  const listing = openFileListing([record], "https://nixamp.com");
  assert.equal((listing["publisher"] as { name: string }).name, "nixamp");
  assert.equal(listing["updated"], "2026-09-13T09:00:00.000Z");
  assert.equal((listing["files"] as unknown[]).length, 1);

  const page = mediaPage(record, "https://nixamp.com", [
    { language: "en", translatedFrom: null, lines: 2, complete: true, shown: [{ start: 0, end: 5, text: "first <line>" }, { start: 65, end: 70, text: "second" }] },
    { language: "sv", translatedFrom: "en", lines: 2, complete: true },
  ]);
  assert.match(page, /<title>A Film · nixamp<\/title>/);
  assert.match(page, /<span class="t">0:00<\/span><span>first &lt;line&gt;<\/span>/);
  assert.match(page, /<span class="t">1:05<\/span>/);
  assert.match(page, /\.srt\?language=sv">sv \(from en\)/);
  assert.match(page, /rel="openfile" href="https:\/\/nixamp.com\/hash\/abab/);
  assert.match(page, /About &lt;things&gt;\./);
  assert.match(page, /1\.50 GB/);
  assert.match(page, /1:30:00/);
  assert.match(page, /1920×1080/);
  assert.match(page, /server1<\/a> as <code>file-1<\/code>/);
  assert.match(page, /Last checked/);
  const bare = mediaPage({ ...record, facts: {}, holders: [], name: "" }, "https://nixamp.com");
  assert.match(bare, /Not written down yet/);
  assert.match(bare, new RegExp(`<h1>${"ab".repeat(6)}</h1>`));
});

test("the index remembers a file, knows when it is due, sees the same, a change and a loss, and the watcher refreshes only what changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-index-"));
  const index = join(dir, "media.json");
  const file = join(dir, "song.mp3");
  writeFileSync(file, "abc");
  const modified = Date.now() - 8 * 60 * 60 * 1000;
  utimesSync(file, new Date(modified), new Date(modified));
  const now = Date.now();
  const kept = remember(file, { id: "11".repeat(32), fingerprint: "file:v1:" + "22".repeat(32), size: 3, mtimeMs: modified }, now, index);
  assert.equal(kept.checkAfter - now, 2 * 60 * 60 * 1000);
  assert.deepEqual(Object.keys(readIndex(index).files), [file]);
  assert.deepEqual(due(readIndex(index), now), []);
  assert.deepEqual(due(readIndex(index), now + 3 * 60 * 60 * 1000), [file]);
  // The same file: pushed out again, no hashing.
  const same = look(file, kept, now + 3 * 60 * 60 * 1000);
  assert.equal(same.state, "same");
  // A changed file.
  writeFileSync(file, "abcd");
  const changed = look(file, kept, now);
  assert.equal(changed.state, "changed");
  assert.equal(look(join(dir, "gone.mp3"), kept, now).state, "gone");
  // The watcher: one due file that changed is refreshed with the new record; a gone one is dropped.
  const later = now + 3 * 60 * 60 * 1000;
  const current = readIndex(index);
  current.files[join(dir, "gone.mp3")] = { ...kept, checkAfter: 0 };
  writeIndex(current, index);
  const refreshed: string[] = [];
  const counts = await watchOnce({
    path: index,
    now: () => later,
    refresh: async (path, before, stat) => {
      refreshed.push(`${path}:${before.id.slice(0, 4)}:${stat.size}`);
      return { id: "33".repeat(32), fingerprint: "file:v1:" + "44".repeat(32) };
    },
  });
  assert.deepEqual(counts, { same: 0, changed: 1, gone: 1 });
  assert.deepEqual(refreshed, [`${file}:1111:4`]);
  const after = readIndex(index);
  assert.equal(after.files[file]?.id, "33".repeat(32));
  assert.equal(after.files[file]?.size, 4);
  assert.equal(after.files[join(dir, "gone.mp3")], undefined);
  // A refresh that could not say leaves the old record and asks again soon.
  const again = readIndex(index);
  (again.files[file] as { checkAfter: number }).checkAfter = 0;
  (again.files[file] as { size: number }).size = 99;
  writeIndex(again, index);
  const stuck = await watchOnce({ path: index, now: () => later, refresh: async () => null });
  assert.deepEqual(stuck, { same: 0, changed: 0, gone: 0 });
  assert.equal(readIndex(index).files[file]?.id, "33".repeat(32));
  assert.equal(readIndex(index).files[file]?.checkAfter, later + 15 * 60 * 1000);
});
