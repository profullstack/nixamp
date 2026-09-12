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
          description: values[4], topic: values[5], kind: values[6], doors_open_at: values[7],
          ticket_price_cents: values[8], ticket_currency: values[9], ticket_minutes: values[10],
          pay_to: values[11] || null,
          starts_at: values[12], ends_at: values[13],
          timezone: values[14], expected_duration_minutes: values[15], status: values[16],
          visibility: values[17], room_id: values[18], chat_enabled: values[19],
          hand_raise_enabled: values[20], recording_enabled: values[21], layout_id: values[22],
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
          layout_id: values[16], kind: values[17], doors_open_at: values[18],
          ticket_price_cents: values[19], ticket_currency: values[20], ticket_minutes: values[21],
          pay_to: values[22] || null,
          version: Number(event["version"]) + 1,
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
        return { rows: matches ? [{ ...event, invitee_ids: [], speaker_ids: [], artist_ids: [], moderator_ids: [] }] : [] };
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

test("a concert is scheduled with doors, a price, and somewhere to pay it", async () => {
  const { database } = eventDatabase();
  const events = new LiveEvents(database);
  const show = await events.create("promoter-1", {
    title: "The Lunar Drips",
    kind: "concert",
    doorsOpenAt: "2026-10-02T01:30:00Z",
    startsAt: "2026-10-02T02:00:00Z",
    ticketPriceCents: 1200,
    payTo: "0x46E9000000000000000000000000000000006C79",
  });

  assert.equal(show.kind, "concert");
  assert.equal(show.status, "scheduled");
  assert.equal(show.doorsOpenAt, "2026-10-02T01:30:00.000Z");
  assert.equal(show.ticketPriceCents, 1200);
  assert.equal(show.ticketCurrency, "USD");
  assert.equal(show.ticketMinutes, 1440);
  assert.equal(show.payTo, "0x46E9000000000000000000000000000000006C79");
});

test("a priced show without an address, or with a bad one, is refused before anyone pays", async () => {
  const { asked, database } = eventDatabase();
  const events = new LiveEvents(database);
  await assert.rejects(
    () => events.create("promoter-1", { title: "Nowhere To Pay", kind: "concert", ticketPriceCents: 1500 }),
    /needs a payTo address/,
  );
  await assert.rejects(
    () => events.create("promoter-1", { title: "Typo", kind: "concert", ticketPriceCents: 1500, payTo: "my-wallet" }),
    /must be an 0x EVM address/,
  );
  await assert.rejects(
    () => events.create("promoter-1", {
      title: "Doors After The Band",
      kind: "concert",
      doorsOpenAt: "2026-10-02T03:00:00Z",
      startsAt: "2026-10-02T02:00:00Z",
    }),
    /doorsOpenAt must be at or before startsAt/,
  );
  assert.equal(asked.length, 0, "nothing reached storage");
});

test("doors open, the band plays, the encore is its own state, and ended is final", () => {
  assert.equal(canTransition("scheduled", "starting"), true, "doors");
  assert.equal(canTransition("starting", "live"), true);
  assert.equal(canTransition("live", "encore"), true);
  assert.equal(canTransition("encore", "live"), true, "a second encore is the same show");
  assert.equal(canTransition("encore", "ended"), true);
  assert.equal(canTransition("ended", "encore"), false);
  assert.equal(canTransition("encore", "scheduled"), false);
});

test("an artist performs without presiding", async () => {
  const { database } = eventDatabase();
  const events = new LiveEvents(database);
  const show = await events.create("promoter-1", { title: "Support Act", kind: "concert" });
  const withArtist = { ...show, artistIds: ["artist-1"] };

  assert.equal(events.canPerform(withArtist, "artist-1"), true);
  assert.equal(events.canManage(withArtist, "artist-1"), false, "an artist is not handed the guest list");
  assert.equal(events.canPerform(withArtist, "promoter-1"), true);
  assert.equal(events.canPerform(withArtist, "a-stranger"), false);
  assert.equal(events.canPerform(withArtist, undefined), false);
});

test("an artist invitation is a role the store accepts", async () => {
  const { database } = eventDatabase();
  const events = new LiveEvents(database);
  const show = await events.create("promoter-1", { title: "Doors At Eight", kind: "concert" });
  const invitation = await events.invite(show.id, "promoter-1", {
    email: "band@example.com",
    role: "artist",
  });
  assert.equal(invitation.role, "artist");
});

test("the schema adds every new column before it indexes one, and a failed run is retried", async () => {
  const seen: string[] = [];
  let failures = 1;
  const database: Queryable = {
    async query(text) {
      seen.push(text);
      if (text.includes("CREATE TABLE") && failures-- > 0) throw new Error("column \"kind\" does not exist");
      return { rows: [] };
    },
  };
  const events = new LiveEvents(database);
  await assert.rejects(events.list(), /kind/);
  await events.list();
  assert.equal(seen.filter((text) => text.includes("CREATE TABLE")).length, 2, "the schema runs again after a failure");
  const schema = seen[0]!;
  for (const column of ["kind", "doors_open_at", "ticket_price_cents", "ticket_currency", "ticket_minutes", "pay_to"]) {
    const added = schema.indexOf(`ADD COLUMN IF NOT EXISTS ${column}`);
    assert.ok(added > 0, `${column} is brought forward`);
    const indexed = schema.indexOf(`CREATE INDEX IF NOT EXISTS live_events_kind`);
    assert.ok(indexed > added, `${column} exists before the kind index is built`);
  }
});
