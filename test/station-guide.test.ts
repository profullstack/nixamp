import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

const memory = () => ({ read: () => null, write: () => undefined });

function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("the guide lists only what its owner made public and listed", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-guide-"));
  process.env["NIXAMP_GUIDE_HOSTS"] = "live.streaming";
  const store = new StationStore(join(top, "s.json"), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [top] });
  const shown = store.create({ name: "Public FM <script>alert(1)</script>" }, ["/x.mp3"], "");
  store.setAccess(shown.id, { visibility: "public", listed: true, rights: { basis: "owned" } }, "acct");
  const unlisted = store.create({ name: "Unlisted FM" }, ["/y.mp3"], "");
  store.setAccess(unlisted.id, { visibility: "unlisted" }, "acct");
  store.create({ name: "Private FM" }, ["/z.mp3"], "");
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, publicBase: () => "https://server1.example:4321" } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  try {
    const listed = await get(port, "/api/v1/stations/guide", "server1.example");
    assert.equal(listed.status, 200, "no key needed");
    const names = (JSON.parse(listed.body) as { stations: Array<{ name: string; page: string }> }).stations.map((one) => one.name);
    assert.deepEqual(names, ["Public FM <script>alert(1)</script>"]);
    const pages = (JSON.parse(listed.body) as { stations: Array<{ page: string }> }).stations.map((one) => one.page);
    assert.match(pages[0]!, /^https:\/\/server1\.example:4321\/station\/[a-z0-9]{10}\?t=/, "linked at the server's public address");
    assert.equal((await get(port, "/guide", "server1.example")).status, 200);
    const front = await get(port, "/", "live.streaming");
    assert.match(front.body, /Radio and TV, on the air now/);
    // Rendered in, so it reads through a gateway that cannot run the script; escaped.
    assert.match(front.body, /Public FM &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(front.body, /<script>alert/);
    assert.match(front.body, /href="https:\/\/server1\.example:4321\/station\//);
    assert.doesNotMatch(front.body, /Unlisted FM|Private FM/);
    // Anywhere else, the front page is the server's own and still needs its key.
    assert.equal((await get(port, "/", "server1.example")).status, 401);
  } finally {
    delete process.env["NIXAMP_GUIDE_HOSTS"];
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});
