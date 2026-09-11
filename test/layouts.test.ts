import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutError, panelFrom, presetLayout, resolveLayout, type Layout } from "../src/layouts.ts";

test("BackToSchool presets expose progressively richer NixAmp panels", () => {
  const viewer = presetLayout("backtoschool-viewer")!;
  const member = presetLayout("backtoschool-member")!;
  const host = presetLayout("backtoschool-host")!;
  const admin = presetLayout("nixamp-admin")!;

  assert.deepEqual(viewer.panels.slice(0, 3).map((panel) => panel.type), ["event-header", "player", "host"]);
  assert.ok(member.panels.some((panel) => panel.type === "raise-hand"));
  assert.ok(host.panels.some((panel) => panel.type === "event-controls"));
  assert.ok(admin.panels.some((panel) => panel.type === "network-health"));
  assert.equal(viewer.panels.some((panel) => panel.type === "network-health"), false);
});

test("permissions win over every layout preference", () => {
  const host = presetLayout("backtoschool-host")!;
  const listener = resolveLayout([host], new Set(["room.listen"]));
  assert.equal(listener.some((panel) => panel.type === "event-controls"), false);
  assert.equal(listener.some((panel) => panel.type === "event-header"), true);

  const allowed = resolveLayout([host], new Set(["room.listen", "room.speak", "event.invite", "event.moderate", "event.start", "event.update", "recording.start"]));
  assert.equal(allowed.some((panel) => panel.type === "event-controls"), true);
});

test("later layout layers override stable panel ids", () => {
  const viewer = presetLayout("backtoschool-viewer")!;
  const user: Layout = {
    ...viewer,
    id: "user-layout",
    name: "user-layout",
    scope: "user",
    panels: [panelFrom({
      ...viewer.panels.find((panel) => panel.id === "player"),
      region: "bottom",
      order: 99,
    })],
  };
  const resolved = resolveLayout([viewer, user], new Set(["layout.read"]));
  const player = resolved.find((panel) => panel.id === "player");
  assert.equal(player?.region, "bottom");
  assert.equal(player?.order, 99);
});

test("unsupported panels are ignored without taking down the player", () => {
  const viewer = presetLayout("backtoschool-viewer")!;
  viewer.panels.push(panelFrom({ id: "future", type: "not-installed-here", region: "primary", order: 0 }));
  const resolved = resolveLayout([viewer], new Set(["layout.read"]));
  assert.equal(resolved.some((panel) => panel.id === "future"), false);
  assert.equal(resolved.some((panel) => panel.type === "player"), true);
});

test("malformed panel configuration is rejected at the boundary", () => {
  assert.throws(
    () => panelFrom({ id: "chat", type: "chat", region: "somewhere", order: 0 }),
    (error: unknown) => error instanceof LayoutError && error.status === 422,
  );
  assert.throws(() => panelFrom({ id: "chat", type: "chat", region: "primary", order: -1 }), /non-negative/);
});
