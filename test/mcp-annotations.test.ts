import { test } from "node:test";
import assert from "node:assert/strict";
import { annotate, unannotated } from "../src/mcp-annotations.ts";
import { TOOLS } from "../src/mcp.ts";
import { PUBLIC_TOOLS } from "../src/directory-mcp.ts";
import { SCHOOL_PUBLIC_TOOLS, SCHOOL_TOOLS } from "../src/school-mcp.ts";

test("every tool nixamp or the school serves has a title and its hints", () => {
  assert.deepEqual(unannotated([...TOOLS, ...PUBLIC_TOOLS, ...SCHOOL_TOOLS, ...SCHOOL_PUBLIC_TOOLS]), []);
});

test("deleting and ending are destructive, reading is read-only", () => {
  const byName = new Map(annotate(TOOLS).map((tool) => [tool.name, tool.annotations]));
  assert.equal(byName.get("class_delete")?.["destructiveHint"], true);
  assert.equal(byName.get("class_delete")?.["readOnlyHint"], false);
  assert.equal(byName.get("watch_party_end")?.["destructiveHint"], true);
  assert.equal(byName.get("classes_list")?.["readOnlyHint"], true);
  assert.equal(byName.get("music_buy")?.["openWorldHint"], true);
});
