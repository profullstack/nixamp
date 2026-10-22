import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPicks } from "../src/library-cli.ts";

const film = (id: string, rel: string, state = "ready") => ({ id, rel, state, title: rel.split("/").pop() });

test("library publish picks: ids as they are, a folder as everything under it, else search words", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-pick-"));
  mkdirSync(join(top, "films", "cuts"), { recursive: true });
  const asked: string[] = [];
  const items = [film("aaaaaaaaaaaaaaaa", "films/cuts/One.mp4"), film("bbbbbbbbbbbbbbbb", "films/cuts/Two.mp4"), film("cccccccccccccccc", "films/cuts/Three.mkv", "failed")];
  const call = async (_method: string, path: string) => {
    asked.push(path);
    if (path === "/api/v1/library/sources") return { status: 200, body: { sources: [{ id: "src1", root: top }] } };
    if (path.startsWith("/api/v1/library/items?")) return { status: 200, body: { items } };
    const one = items.find((item) => path === `/api/v1/library/items/${item.id}`);
    return one ? { status: 200, body: { item: one } } : { status: 404, body: { error: "no such item" } };
  };
  try {
    // A folder: its source and the folder inside it; only ready files.
    const folder = await publishPicks([join(top, "films", "cuts")], call);
    assert.deepEqual((folder as Array<{ id: string }>).map((one) => one.id), ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    const query = new URLSearchParams(asked.at(-1)!.split("?")[1]);
    assert.equal(query.get("source"), "src1");
    assert.equal(query.get("folder"), join("films", "cuts"));
    // Ids, every one of them ready, or a reason.
    assert.equal((await publishPicks(["aaaaaaaaaaaaaaaa"], call) as unknown[]).length, 1);
    assert.equal(typeof await publishPicks(["aaaaaaaaaaaaaaaa", "cccccccccccccccc"], call), "string");
    // Words search.
    await publishPicks(["fan", "cut"], call);
    assert.equal(new URLSearchParams(asked.at(-1)!.split("?")[1]).get("q"), "fan cut");
    // A folder outside every source is named, not searched.
    assert.match(String(await publishPicks([tmpdir()], call)), /not inside the library/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
