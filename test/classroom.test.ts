import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { classroomBroadcast, publicWebUrl } from "../src/classroom.ts";
import { LiveEvents } from "../src/live-events.ts";
import { Accounts } from "../src/accounts.ts";
import { createServer, EmptyEngine } from "../src/server.ts";

test("classroom links accept Pairux viewers and Nixamp video shares without arbitrary frames", () => {
  assert.deepEqual(classroomBroadcast("https://pairux.com/join/ABC123"), { provider: "pairux", url: "https://pairux.com/l/ABC123", embed: "https://pairux.com/embed/ABC123", join: "https://pairux.com/join/ABC123" });
  const share = "https://nixamp.com/?url=" + encodeURIComponent("https://server1.chovy.nixamp.com:4321/view/abc123") + "&play=channel:lesson";
  assert.equal(new URL(classroomBroadcast(share)!.embed).searchParams.get("embed"), "1");
  const serverShare = classroomBroadcast("https://nixamp.com/?url=" + encodeURIComponent("https://server1.chovy.nixamp.com:4321/view/abc123"))!;
  assert.equal(new URL(serverShare.embed).searchParams.get("play"), "live");
  assert.equal(new URL(serverShare.embed).searchParams.get("url"), "https://server1.chovy.nixamp.com:4321/view/abc123");
  assert.ok(classroomBroadcast("https://server1.chovy.nixamp.com:4321/view/abc123"));
  assert.ok(classroomBroadcast("https://nixamp.com/?play=track:0"));
  assert.ok(classroomBroadcast("https://nixamp.com/?play=" + encodeURIComponent("https://media.example.com/lesson.mp4")));
  for (const url of ["javascript:alert(1)", "https://pairux.com.evil.example/join/123", "https://evil.example/video", "https://pairux.com/dashboard", "https://nixamp.com/", "https://nixamp.com/?play=golive:https://media.example/a", "https://nixamp.com/?url=https://host/admin/secret&play=live", "https://user:secret@nixamp.com/?play=live"]) assert.equal(classroomBroadcast(url), null, url);
  assert.equal(publicWebUrl("javascript:alert(1)"), null);
  assert.equal(publicWebUrl("https://school.example/anthony"), "https://school.example/anthony");
});

test("classrooms persist edits, enforce ownership/version, and repeat on the same permalink across DST", { skip: !process.env["NIXAMP_TEST_DATABASE_URL"] }, async () => {
  const schema = "classroom_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: process.env["NIXAMP_TEST_DATABASE_URL"] });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: process.env["NIXAMP_TEST_DATABASE_URL"], options: `-c search_path=${schema}` });
  const events = new LiveEvents(db);
  const accounts = new Accounts({ connectionString: "", secret: "", system: {
    register: async () => ({}), login: async () => ({}),
    validateToken: async token => ["host", "stranger"].includes(token) ? {userId: token, email: token + "@example.com"} : null,
  } });
  const server = createServer(new EmptyEngine(), { events, accounts, media: false, web: null, version: "test", load: async () => [] });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const request = async (path: string, method = "GET", body?: unknown, user = "host") => {
    const response = await fetch(base + "/api/v1/events" + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${user}` }, ...(body ? {body: JSON.stringify(body)} : {}) });
    return {status: response.status, body: await response.json() as any};
  };
  try {
    // The schema is empty: exercise the additive migration as well as persistence.
    const original = await events.create("host", {title: "Existing class", startsAt: "2026-10-25T14:00:00Z", timezone: "America/New_York"});
    assert.equal(original.broadcastUrl, undefined);
    assert.equal((await request("/" + original.slug, "PATCH", {version: 1, title: "Stolen"}, "stranger")).status, 403);
    assert.equal((await request("/" + original.slug, "PATCH", {title: "No version"})).status, 428);
    const edited = await request("/" + original.slug, "PATCH", {version: 1, title: "Weekly screen share", broadcastUrl: "https://pairux.com/join/ABC123", hostName: "Anthony", homepageUrl: "https://school.example/", avatarUrl: "https://school.example/photo.jpg", recurrence: "weekly"});
    assert.equal(edited.status, 200);
    assert.equal(edited.body.event.slug, original.slug);
    assert.equal(edited.body.event.hostName, "Anthony");
    assert.equal(edited.body.event.broadcastUrl, "https://pairux.com/l/ABC123");
    const restarted = new LiveEvents(db);
    assert.equal((await restarted.get(original.id))!.homepageUrl, "https://school.example/");
    assert.equal((await request("/" + original.slug, "PATCH", {version: 1, title: "Stale"})).status, 409);
    assert.equal((await request("/" + original.slug, "PATCH", {version: 2, avatarUrl: "javascript:alert(1)"})).status, 422);
    const live = await request("/" + original.slug + "/start", "POST", {version: 2});
    assert.equal(live.body.event.status, "live");
    const ended = await request("/" + original.slug + "/end", "POST", {version: 3});
    assert.equal(ended.status, 200);
    assert.equal(ended.body.event.status, "scheduled");
    assert.equal(ended.body.event.startsAt, "2026-11-01T15:00:00.000Z", "10am remains 10am after daylight saving ends");
    assert.equal(ended.body.event.id, original.id);
    assert.equal(ended.body.event.slug, original.slug);
    assert.equal(ended.body.event.roomId, original.roomId);
    assert.equal(ended.body.event.version, 4);
    assert.equal((await request("/" + original.slug + "/end", "POST", {version: 3})).status, 409);
    const clear = await request("/" + original.slug, "PATCH", {version: 4, recurrence: "none", homepageUrl: "", avatarUrl: "", broadcastUrl: ""});
    assert.equal(clear.status, 200);
    assert.equal(clear.body.event.recurrence, undefined);
    assert.equal(clear.body.event.avatarUrl, undefined);
    assert.equal(clear.body.event.broadcastUrl, undefined);
    assert.equal(clear.body.event.hostName, "Anthony");
    const daily = await events.create("host", {title: "Daily", startsAt: "2020-01-01T15:00:00Z", timezone: "America/New_York", recurrence: "daily"});
    const started = await events.transition(daily.id, "host", "live", 1);
    const next = await events.transition(daily.id, "host", "ended", started.version);
    assert.ok(Date.parse(next.startsAt!) > Date.now());
    assert.ok(Date.parse(next.startsAt!) < Date.now() + 26 * 60 * 60_000);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(new Date(next.startsAt!)), "10");
    await assert.rejects(events.create("host", {title: "No date", recurrence: "weekly"}), /start time/);
    await assert.rejects(events.create("host", {title: "Bad timezone", timezone: "garbage"}), /valid time zone/);
    assert.equal((await request("/" + original.slug, "GET", undefined, "")).body.event.title, "Weekly screen share");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
