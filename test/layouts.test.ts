import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutError, layoutNameFor, panelFrom, presetLayout, resolveLayout, type Layout } from "../src/layouts.ts";

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

test("a concert has a stage, a setlist, and the two panels that pay for the night", () => {
  const viewer = presetLayout("concert-viewer")!;
  const holder = presetLayout("concert-ticketholder")!;
  const artist = presetLayout("concert-artist")!;

  assert.equal(viewer.scopeId, "concert");
  assert.ok(viewer.panels.some((panel) => panel.type === "tickets"), "a viewer is shown the till");
  assert.equal(viewer.panels.some((panel) => panel.type === "tip-jar"), false);

  assert.ok(holder.panels.some((panel) => panel.type === "stage-video"));
  assert.ok(holder.panels.some((panel) => panel.type === "setlist"));
  assert.ok(holder.panels.some((panel) => panel.type === "tip-jar"));
  assert.ok(holder.panels.some((panel) => panel.type === "merch"));

  assert.ok(artist.panels.some((panel) => panel.type === "soundcheck"));
  assert.ok(artist.panels.some((panel) => panel.type === "event-controls"));
});

test("the soundcheck is only for the people who perform", () => {
  const artist = presetLayout("concert-artist")!;
  const audience = resolveLayout([artist], new Set(["room.listen", "layout.read"]));
  assert.equal(audience.some((panel) => panel.type === "soundcheck"), false);
  assert.equal(audience.some((panel) => panel.type === "stage-video"), true);

  const performing = resolveLayout([artist], new Set(["event.perform", "event.start", "layout.read"]));
  assert.equal(performing.some((panel) => panel.type === "soundcheck"), true);
});

test("a kind and a role name one preset, and an unknown kind still names one", () => {
  assert.equal(layoutNameFor("concert", "viewer"), "concert-viewer");
  assert.equal(layoutNameFor("concert", "member"), "concert-ticketholder");
  assert.equal(layoutNameFor("concert", "host"), "concert-artist");
  assert.equal(layoutNameFor("class", "host"), "backtoschool-host");
  assert.equal(layoutNameFor("talk", "viewer"), "backtoschool-viewer");
  assert.ok(presetLayout(layoutNameFor("talk", "member")));
});
