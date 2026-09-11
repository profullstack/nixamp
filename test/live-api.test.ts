import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Accounts } from "../src/accounts.ts";
import { Channels } from "../src/channels.ts";
import type { Queryable } from "../src/follows.ts";
import { LiveEvents } from "../src/live-events.ts";
import { Owner } from "../src/owner.ts";
import { Rooms } from "../src/rooms.ts";
import { EmptyEngine, createServer } from "../src/server.ts";

const row = {
  id: "event-1",
  slug: "building-your-first-ai-agent",
  owner_id: "host-1",
  title: "Building Your First AI Agent",
  description: "A practical live introduction.",
  topic: "Technology",
  starts_at: "2026-09-11T19:00:00.000Z",
  ends_at: null,
  timezone: "UTC",
  expected_duration_minutes: 60,
  status: "live",
  visibility: "public",
  room_id: "event-room-1",
  chat_enabled: true,
  hand_raise_enabled: true,
  recording_enabled: false,
  recording_id: null,
  layout_id: null,
  version: 2,
  invitee_ids: [],
  speaker_ids: [],
  moderator_ids: [],
  created_at: "2026-09-11T18:00:00.000Z",
  updated_at: "2026-09-11T18:30:00.000Z",
};

function eventStore(event = row): LiveEvents {
  const database: Queryable = {
    async query(text, values = []) {
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.includes("FROM live_events e")) {
        if (text.includes("e.room_id = $1")) return { rows: values[0] === event.room_id ? [event] : [] };
        if (text.includes("e.id = $1 OR e.slug = $1")) {
          return { rows: values[0] === event.id || values[0] === event.slug ? [event] : [] };
        }
        return { rows: [event] };
      }
      if (text.includes("FROM live_event_invitations")) return { rows: [] };
      return { rows: [] };
    },
  };
  return new LiveEvents(database);
}

function mutableEventStore(initial: typeof row): { events: LiveEvents; current: () => typeof row } {
  let event = { ...initial };
  const database: Queryable = {
    async query(text, values = []) {
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.includes("UPDATE live_events SET")) {
        if (values[0] !== event.id || values[1] !== event.owner_id || values[2] !== event.version) {
          return { rows: [] };
        }
        event = {
          ...event,
          title: String(values[3]),
          description: String(values[4]),
          topic: String(values[5]),
          starts_at: values[6] as string | null,
          ends_at: values[7] as string | null,
          timezone: String(values[8]),
          expected_duration_minutes: values[9] as number | null,
          status: String(values[10]),
          visibility: String(values[11]),
          chat_enabled: Boolean(values[12]),
          hand_raise_enabled: Boolean(values[13]),
          recording_enabled: Boolean(values[14]),
          recording_id: values[15] as string | null,
          layout_id: values[16] as string | null,
          version: event.version + 1,
          updated_at: "2026-09-11T18:31:00.000Z",
        };
        return { rows: [event] };
      }
      if (text.includes("FROM live_events e")) {
        if (text.includes("e.room_id = $1")) return { rows: values[0] === event.room_id ? [event] : [] };
        if (text.includes("e.id = $1 OR e.slug = $1")) {
          return { rows: values[0] === event.id || values[0] === event.slug ? [event] : [] };
        }
        return { rows: [event] };
      }
      if (text.includes("FROM live_event_invitations")) return { rows: [] };
      return { rows: [] };
    },
  };
  return { events: new LiveEvents(database), current: () => event };
}

const accounts = {
  async whoIs(token: string) {
    return token === "host" ? { id: "host-1", email: "host@example.com" }
      : token === "other" ? { id: "account-2", email: "other@example.com" }
        : null;
  },
} as Accounts;

async function withApi(
  options: {
    web?: string | null;
    channels?: Channels;
    events?: LiveEvents;
    rooms?: Rooms;
    owner?: Owner;
    key?: string;
  },
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(new EmptyEngine(), {
    web: options.web ?? null,
    media: true,
    version: "test",
    load: async () => [],
    accounts,
    events: options.events ?? eventStore(),
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.rooms ? { rooms: options.rooms } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.key ? { key: options.key } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    options.channels?.stopAll();
  }
}

test("public event discovery and detail need no account", async () => {
  await withApi({}, async (base) => {
    const listed = await fetch(`${base}/api/v1/events`).then((response) => response.json()) as { events: Array<{ id: string }> };
    assert.equal(listed.events[0]?.id, "event-1");

    const response = await fetch(`${base}/api/v1/events/${row.slug}`);
    assert.equal(response.status, 200);
    const detail = await response.json() as { event: { title: string }; layout: { name: string }; permissions: string[] };
    assert.equal(detail.event.title, row.title);
    assert.equal(detail.layout.name, "backtoschool-viewer");
    assert.deepEqual(detail.permissions, ["room.listen", "layout.read"]);
  });
});

test("the same event resolves to the host layout for its NixAmp owner", async () => {
  await withApi({}, async (base) => {
    const response = await fetch(`${base}/api/v1/events/${row.id}`, {
      headers: { authorization: "Bearer host" },
    });
    const detail = await response.json() as { layout: { name: string }; permissions: string[] };
    assert.equal(detail.layout.name, "backtoschool-host");
    assert.ok(detail.permissions.includes("event.start"));
    assert.ok(detail.permissions.includes("panel.update"));
  });
});

test("event rooms refuse anonymous publishers without affecting listeners", async () => {
  const channels = new Channels({ ffmpeg: ["false"] });
  await withApi({ channels }, async (base) => {
    const publish = await fetch(`${base}/api/channels/${row.room_id}/chunk?format=webm`, {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "not media",
    });
    assert.equal(publish.status, 401);

    const listen = await fetch(`${base}/api/channels/${row.room_id}`);
    assert.equal(listen.status, 404);
  });
});

test("an authenticated host can publish through the event lifecycle without owning the server", async () => {
  const channels = new Channels({ ffmpeg: ["sh", "-c", "cat >/dev/null", "--"] });
  const store = mutableEventStore({ ...row, status: "scheduled", version: 1 });
  const owner = new Owner({
    ownerId: "server-owner",
    site: "https://nixamp.invalid",
    fetcher: async () => Response.json({ account: { id: "host-1" } }),
  });
  await withApi({ channels, events: store.events, owner, key: "server-control-key" }, async (base) => {
    const publish = (token: string) => fetch(`${base}/api/channels/${row.room_id}/chunk?format=webm`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "audio/webm" },
      body: "media chunk",
    });

    assert.equal((await publish("host")).status, 409, "scheduled events must be started first");

    const started = await fetch(`${base}/api/v1/events/${row.id}/start`, {
      method: "POST",
      headers: { authorization: "Bearer host", "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(started.status, 200);
    assert.equal(store.current().status, "live");

    assert.equal((await publish("other")).status, 403);
    assert.equal((await publish("host")).status, 200);

    const stopped = await fetch(`${base}/api/channels/${row.room_id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer host" },
    });
    assert.equal(stopped.status, 200);
    assert.equal(store.current().status, "ended");
  });
});

test("private event participation requires access and list limits are validated", async () => {
  const privateEvent = { ...row, visibility: "private" };
  const rooms = new Rooms({
    async query() {
      throw new Error("private participation reached room storage");
    },
  });
  await withApi({ events: eventStore(privateEvent), rooms }, async (base) => {
    const raised = await fetch(`${base}/api/v1/events/${row.id}/hand-raises`, {
      method: "POST",
      headers: { authorization: "Bearer other", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(raised.status, 404);

    const limited = await fetch(`${base}/api/v1/events?limit=not-a-number`);
    assert.equal(limited.status, 422);
  });
});

test("event pages receive useful metadata before the client starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nixamp-backtoschool-"));
  writeFileSync(join(directory, "index.html"), `<!doctype html><html><head>
    <title>BackToSchool.help — Learn something live</title>
    <meta name="description" content="Learn something live." />
    <meta property="og:title" content="BackToSchool.help — Learn something live" />
    <meta property="og:description" content="Live conversations." />
    </head><body><div id="app"></div></body></html>`);
  try {
    await withApi({ web: directory }, async (base) => {
      const response = await fetch(`${base}/live/${row.slug}`);
      const page = await response.text();
      assert.equal(response.status, 200);
      assert.match(page, /Building Your First AI Agent — BackToSchool\.help/);
      assert.match(page, /application\/ld\+json/);
      assert.match(page, /EventInProgress/);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
