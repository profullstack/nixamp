import { test } from "node:test";
import assert from "node:assert/strict";
import { guideGroup } from "../src/station-routes.ts";
import type { Station } from "../src/stations.ts";

const station = (over: Partial<Station>): Station => ({ auto: "", video: false, rights: null, ...over }) as Station;
const rights = (basis: string, note: string): Station["rights"] => ({ basis, note, declaredAt: 0, declaredBy: "control-key" }) as Station["rights"];

test("a band its owner made with Suno is AI radio; other owned music is radio", () => {
  assert.equal(guideGroup(station({ rights: rights("owned", "Original music by Profullstack, Inc., made with Suno") })), "ai");
  assert.equal(guideGroup(station({ auto: "ai:d0211de180" })), "ai");
  assert.equal(guideGroup(station({ rights: rights("owned", "Recorded by the band in our studio") })), "radio");
  // Only the owner's own declaration counts, not a note under another basis.
  assert.equal(guideGroup(station({ rights: rights("licensed", "a Suno licence") })), "radio");
  assert.equal(guideGroup(station({ rights: null })), "radio");
  assert.equal(guideGroup(station({ video: true })), "tv");
});
