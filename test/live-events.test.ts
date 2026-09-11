import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, eventSlug, LiveEventError, LiveEvents } from "../src/live-events.ts";
import type { Queryable } from "../src/follows.ts";

function eventDatabase() {
  const asked: Array<{ text: string; values: unknown[] }> = [];
  let event: Record<string, unknown> | null = null;
  let invitation: Record<string, unknown> | null = null;
  const database: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.includes("INSERT INTO live_events")) {
        event = {
          id: values[0], slug: values[1], owner_id: values[2], title: values[3],
          description: values[4], topic: values[5], starts_at: values[6], ends_at: values[7],
          timezone: values[8], expected_duration_minutes: values[9], status: values[10],
          visibility: values[11], room_id: values[12], chat_enabled: values[13],
          hand_raise_enabled: values[14], recording_enabled: values[15], layout_id: values[16],
          recording_id: null, version: 1,
          created_at: "2026-09-11T12:00:00.000Z", updated_at: "2026-09-11T12:00:00.000Z",
        };
        return { rows: [event] };
      }
      if (text.includes("UPDATE live_events SET")) {
        if (!event || Number(values[2]) !== Number(event["version"])) return { rows: [] };
        event = {
          ...event,
          title: values[3], description: values[4], topic: values[5], starts_at: values[6],
          ends_at: values[7], timezone: values[8], expected_duration_minutes: values[9],
          status: values[10], visibility: values[11], chat_enabled: values[12],
          hand_raise_enabled: values[13], recording_enabled: values[14], recording_id: values[15],
          layout_id: values[16], version: Number(event["version"]) + 1,
          updated_at: "2026-09-11T12:01:00.000Z",
        };
        return { rows: [event] };
      }
      if (text.includes("INSERT INTO live_event_invitations")) {
        invitation = {
          id: values[0], event_id: values[1], inviter_id: values[2], invitee_id: values[3],
          email: values[4], role: values[5], token_hash: values[6], expires_at: values[7],
          state: "pending", created_at: "2026-09-11T12:00:00.000Z", updated_at: "2026-09-11T12:00:00.000Z",
        };
        return { rows: [invitation] };
      }
      if (text.includes("UPDATE live_event_invitations SET") && text.includes("token_hash")) {
        if (!invitation || invitation["token_hash"] !== values[0]) return { rows: [] };
        invitation = { ...invitation, invitee_id: values[1], state: values[2] };
        return { rows: [invitation] };
      }
      if (text.includes("FROM live_event_invitations") && text.includes("token_hash")) {
        return { rows: invitation && invitation["token_hash"] === values[1] ? [{ "?column?": 1 }] : [] };
      }
      if (text.includes("FROM live_events e") && (text.includes("e.id = $1") || text.includes("e.room_id = $1"))) {
        if (!event) return { rows: [] };
        const matches = text.includes("e.room_id") ? event["room_id"] === values[0] : event["id"] === values[0] || event["slug"] === values[0];
        return { rows: matches ? [{ ...event, invitee_ids: [], speaker_ids: [], moderator_ids: [] }] : [] };
      }
      return { rows: [] };
    },
  };
  return { asked, database, current: () => event, invitation: () => invitation };
}

test("event slugs are readable, bounded, and stable", () => {
  assert.equal(eventSlug("  Building Your First AI Agent  "), "building-your-first-ai-agent");
  assert.equal(eventSlug("Déjà Vu & TypeScript"), "deja-vu-typescript");
  assert.ok(eventSlug("a".repeat(200)).length <= 72);
});

test("the lifecycle admits deliberate transitions and refuses resurrection", () => {
  assert.equal(canTransition("draft", "scheduled"), true);
  assert.equal(canTransition("scheduled", "live"), true);
  assert.equal(canTransition("live", "ended"), true);
  assert.equal(canTransition("ended", "live"), false);
  assert.equal(canTransition("archived", "draft"), false);
});

test("creating a scheduled event also creates its durable NixAmp room identity", async () => {
  const { asked, database } = eventDatabase();
  const events = new LiveEvents(database);
  const event = await events.create("owner-1", {
    title: "Intro to Rust",
    startsAt: "2026-09-12T18:00:00-04:00",
    timezone: "America/New_York",
    visibility: "unlisted",
  });

  assert.equal(event.status, "scheduled");
  assert.equal(event.visibility, "unlisted");
  assert.match(event.roomId, /^event-/);
  assert.equal(event.slug, "intro-to-rust");
  assert.equal(event.chatEnabled, true);
  assert.equal(event.handRaiseEnabled, true);
  assert.equal(event.recordingEnabled, false);
  assert.equal(asked.filter((query) => query.text.includes("CREATE TABLE")).length, 1);
});

test("event writes require the version the editor actually saw", async () => {
  const { database } = eventDatabase();
  const events = new LiveEvents(database);
  const created = await events.create("owner-1", { title: "Ask a Maintainer" });
  const live = await events.transition(created.id, "owner-1", "live", created.version);
  assert.equal(live.status, "live");
  assert.equal(live.version, 2);

  await assert.rejects(
    () => events.transition(created.id, "owner-1", "ended", created.version),
    (error: unknown) => error instanceof LiveEventError && error.status === 409,
  );
  await assert.rejects(
    () => events.transition(created.id, "owner-1", "draft", live.version),
    /cannot move from live to draft/,
  );
});

test("role invitations store a digest and reveal the token only when created", async () => {
  const { database, invitation } = eventDatabase();
  const events = new LiveEvents(database);
  const event = await events.create("owner-1", { title: "Linux for Normal People", visibility: "private" });
  const created = await events.invite(event.id, "owner-1", {
    email: "student@example.com",
    role: "speaker",
  });

  assert.equal(created.role, "speaker");
  assert.equal(created.state, "pending");
  assert.ok(created.token.length >= 32);
  assert.notEqual(invitation()?.["token_hash"], created.token);
  assert.equal(await events.invitationAllows(event.id, created.token), true);

  const accepted = await events.respond(created.token, "student-1", "accepted");
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.inviteeId, "student-1");
});

test("invalid schedules fail before touching storage", async () => {
  const { asked, database } = eventDatabase();
  const events = new LiveEvents(database);
  await assert.rejects(
    () => events.create("owner-1", {
      title: "Time travel",
      startsAt: "2026-09-12T20:00:00Z",
      endsAt: "2026-09-12T19:00:00Z",
    }),
    /endsAt must be after startsAt/,
  );
  assert.equal(asked.length, 0);
});
