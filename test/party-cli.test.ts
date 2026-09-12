import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, partyLines, party, type PartyRow } from "../src/party.ts";
import { callTool, handleMessage, PROTOCOL_VERSION, TOOLS } from "../src/mcp.ts";

const row: PartyRow = {
  party: {
    eventId: "event-1",
    roomId: "event-abc123",
    slug: "dune-together",
    origin: "bittorrented",
    partyCode: "ABC123",
    partyUrl: "https://bittorrented.com/watch-party?code=ABC123",
    mediaTitle: "Dune (2021)",
    positionSeconds: 930,
    positionNow: 934,
    playing: true,
  },
  event: { id: "event-1", title: "Dune, together", status: "live", ownerId: "host-1", visibility: "unlisted" },
  links: {
    nixampUrl: "https://nixamp.test/live/dune-together",
    roomUrl: "https://nixamp.test/api/channels/event-abc123",
    partyUrl: "https://bittorrented.com/watch-party?code=ABC123",
  },
  host: true,
};

const session = { site: "https://nixamp.test", token: "nxa_deadbeef_secret" };

/** A fetch that records what was asked and answers what the test says. */
function recorder(answer: unknown, status = 200) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("a position reads as a clock, with the hour only once there is one", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(930), "15:30");
  assert.equal(clock(3661), "1:01:01");
  // Never negative, whatever arithmetic produced it.
  assert.equal(clock(-5), "0:00");
});

test("a party prints both links: the film where it lives, the room here", () => {
  const lines = partyLines(row);
  assert.match(lines[0] ?? "", /ABC123.*Dune, together.*yours/);
  assert.match(lines[1] ?? "", /▶ 15:34/);
  assert.ok(lines.some((line) => line.includes("https://bittorrented.com/watch-party?code=ABC123")));
  assert.ok(lines.some((line) => line.includes("https://nixamp.test/live/dune-together")));
});

test("`nixamp party` refuses before there is a session rather than asking anyway", async () => {
  // No session file in this process's state directory, and no NIXAMP_TOKEN.
  const had = process.env["NIXAMP_TOKEN"];
  delete process.env["NIXAMP_TOKEN"];
  const { calls, fetcher } = recorder({});
  try {
    const code = await party(["list"], fetcher);
    assert.equal(code, 1);
    assert.equal(calls.length, 0);
  } finally {
    if (had !== undefined) process.env["NIXAMP_TOKEN"] = had;
  }
});

test("`nixamp party host` sends the code and the link, and bridging is a POST", async () => {
  process.env["NIXAMP_TOKEN"] = "nxa_test_token";
  process.env["NIXAMP_SITE"] = "https://nixamp.test";
  const { calls, fetcher } = recorder(row, 201);
  try {
    const code = await party(
      ["host", "abc123", "--url", "https://bittorrented.com/watch-party?code=ABC123", "--media", "Dune (2021)"],
      fetcher,
    );
    assert.equal(code, 0);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, "https://nixamp.test/api/v1/watch-parties");
    assert.deepEqual(calls[0]?.body, {
      partyCode: "abc123",
      partyUrl: "https://bittorrented.com/watch-party?code=ABC123",
      mediaTitle: "Dune (2021)",
    });
  } finally {
    delete process.env["NIXAMP_TOKEN"];
    delete process.env["NIXAMP_SITE"];
  }
});

test("`nixamp party sync` will not guess where the film is", async () => {
  process.env["NIXAMP_TOKEN"] = "nxa_test_token";
  process.env["NIXAMP_SITE"] = "https://nixamp.test";
  const { calls, fetcher } = recorder(row);
  try {
    assert.equal(await party(["sync", "ABC123"], fetcher), 64);
    assert.equal(calls.length, 0);
    assert.equal(await party(["sync", "ABC123", "--at", "930", "--pause"], fetcher), 0);
    assert.equal(calls[0]?.url, "https://nixamp.test/api/v1/watch-parties/ABC123/playback");
    assert.deepEqual(calls[0]?.body, { positionSeconds: 930, playing: false });
  } finally {
    delete process.env["NIXAMP_TOKEN"];
    delete process.env["NIXAMP_SITE"];
  }
});

// --- MCP -----------------------------------------------------------------------

test("the MCP server introduces itself and lists its tools", async () => {
  const hello = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const result = hello?.["result"] as Record<string, unknown>;
  assert.equal(result["protocolVersion"], PROTOCOL_VERSION);
  assert.equal((result["serverInfo"] as Record<string, string>)["name"], "nixamp");

  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (listed?.["result"] as { tools: { name: string }[] }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["watch_parties_list", "watch_party_end", "watch_party_get", "watch_party_host", "watch_party_sync"],
  );
  // Every tool says what it takes, or a client cannot call it.
  for (const tool of TOOLS) assert.equal((tool.inputSchema as { type: string }).type, "object");
});

test("a notification is answered with silence, and an unknown method with an error", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const unknown = await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal((unknown?.["error"] as { code: number }).code, -32601);
  const missing = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
  assert.equal((missing?.["error"] as { code: number }).code, -32602);
});

test("an MCP tool call reaches the same endpoint the CLI does, as this machine's account", async () => {
  const { calls, fetcher } = recorder({ parties: [row] });
  const answer = await callTool("watch_parties_list", {}, { session, fetcher });
  assert.equal(answer.isError, undefined);
  assert.equal(calls[0]?.url, "https://nixamp.test/api/v1/watch-parties");
  assert.match(answer.content[0]?.text ?? "", /ABC123 — Dune, together/);
  assert.match(answer.content[0]?.text ?? "", /playing at 15:34/);
});

test("an MCP tool says plainly when nothing is signed in, rather than 401ing quietly", async () => {
  const { calls, fetcher } = recorder({});
  const answer = await callTool("watch_party_get", { code: "ABC123" }, { session: null, fetcher });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0]?.text ?? "", /nixamp login/);
  assert.equal(calls.length, 0);
});

test("an MCP sync will not send a position that is not one", async () => {
  const { calls, fetcher } = recorder(row);
  const answer = await callTool("watch_party_sync", { code: "ABC123", positionSeconds: "soon" }, { session, fetcher });
  assert.equal(answer.isError, true);
  assert.equal(calls.length, 0);
});

test("an MCP tool carries the server's own refusal back rather than inventing one", async () => {
  const { fetcher } = recorder({ error: "only the host can move everybody's playback" }, 403);
  const answer = await callTool("watch_party_sync", { code: "ABC123", positionSeconds: 12 }, { session, fetcher });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0]?.text ?? "", /only the host/);
});
