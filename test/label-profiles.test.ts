import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bandMarkdown, castLine, inventMembers, memberMarkdown, readMember, readMembers, writeMembers, type Member } from "../src/label-profiles.ts";

const mara: Member = {
  slug: "mara-quill", name: "Mara Quill", role: "lead vocals",
  look: "late twenties, sharp cheekbones, pale freckled skin, shaggy bleached-blonde hair, smudged eyeliner, torn grey band tee, studded leather wristbands",
  voice: "raspy, powerful alto with a growl", personality: "restless, funny, fearless on stage", influences: "90s grunge, garage punk", bio: "Grew up singing over the noise of a car-repair shop.",
};

test("a member's OpenProfile page reads back the same, and a hand edit wins", () => {
  const page = memberMarkdown(mara, { name: "Velvet Ruckus", holder: "Profullstack, Inc." });
  assert.match(page, /^# Mara Quill\n\n- \*\*Kind\*\*: fictional musician, made with AI\n- \*\*Band\*\*: \[Velvet Ruckus\]\(\.\.\/artist\.md\)\n- \*\*Role\*\*: lead vocals/);
  assert.deepEqual(readMember(page, "mara-quill"), mara);
  const edited = page.replace("shaggy bleached-blonde hair", "a shaved head");
  assert.match(readMember(edited, "mara-quill")!.look, /a shaved head/);
  assert.equal(readMember("no heading here", "x"), null);
});

test("members are cast once, written as pages with portraits, and read back for every prompt", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-profiles-"));
  try {
    const ask = async () => ({ model: "m", value: { members: [
      { name: "Mara Quill", role: "lead vocals", look: mara.look, voice: mara.voice, personality: mara.personality, influences: mara.influences, bio: mara.bio },
      { name: "Dex Ortega", role: "lead guitar", look: "thirties, broad shoulders, dark curly hair, thick beard, denim vest over a black hoodie", voice: "fuzzed-out riffs", personality: "quiet", influences: "70s hard rock", bio: "Builds his own pedals." },
      { name: "", role: "drums", look: "nobody", voice: "", personality: "", influences: "", bio: "" },
    ] } });
    const members = await inventMembers({ name: "Velvet Ruckus", genre: "Rock", sound: "gritty", voice: "raspy alto", bio: "" }, ask);
    assert.deepEqual(members.map((one) => one.slug), ["mara-quill", "dex-ortega"], "a member without a name or a look is dropped");
    const drawn: string[] = [];
    await writeMembers(top, members, { name: "Velvet Ruckus", genre: "Rock", holder: "Profullstack, Inc." }, async (prompt) => { drawn.push(prompt); return Buffer.alloc(2048, 1); });
    assert.equal(drawn.length, 2);
    assert.match(drawn[0]!, /shaggy bleached-blonde hair.*lead vocals in the Rock band Velvet Ruckus/);
    assert.ok(readFileSync(join(top, "members", "dex-ortega.jpg")).length > 1000);
    // A hand edit to a page is what the next prompt sees; portraits are not drawn twice.
    writeFileSync(join(top, "members", "dex-ortega.md"), readFileSync(join(top, "members", "dex-ortega.md"), "utf8").replace("thick beard", "clean-shaven"));
    const again = await writeMembers(top, members, { name: "Velvet Ruckus", genre: "Rock", holder: "Profullstack, Inc." }, async (prompt) => { drawn.push(prompt); return Buffer.alloc(2048, 1); });
    assert.equal(drawn.length, 2);
    assert.match(again[1]!.look, /clean-shaven/);
    assert.match(castLine(readMembers(top, ["mara-quill", "dex-ortega"])), /^Mara Quill \(lead vocals\): late twenties.*; Dex Ortega \(lead guitar\): .*clean-shaven/);
    const band = bandMarkdown({ name: "Velvet Ruckus", genre: "Rock", sound: "gritty", voice: "raspy", bio: "A basement band.", themes: "escape", holder: "Profullstack, Inc.", members: again, albums: [{ year: 2026, title: "Burn the Map" }] });
    assert.match(band, /- \*\*Members\*\*: \[Mara Quill\]\(members\/mara-quill\.md\) \(lead vocals\), \[Dex Ortega\]/);
    assert.match(band, /## Discography\n\n- 2026 · Burn the Map/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
