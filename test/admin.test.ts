import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Connections, networkOf, normaliseAddress, shortAgent } from "../src/connections.ts";
import { alive, daemonUrl, type DaemonState } from "../src/daemon.ts";
import { renderToText } from "@profullstack/hqtui/testing";
import { bytes, draw, resolveTarget, since, type View } from "../src/admin.ts";

const request = (address: string, agent?: string): IncomingMessage =>
  ({ socket: { remoteAddress: address }, headers: agent ? { "user-agent": agent } : {} }) as unknown as IncomingMessage;

test("an IPv4-mapped IPv6 address is just the IPv4 one", () => {
  assert.equal(normaliseAddress("::ffff:10.0.0.1"), "10.0.0.1");
  assert.equal(normaliseAddress("::1"), "::1");
  assert.equal(normaliseAddress("192.168.1.5"), "192.168.1.5");
  assert.equal(normaliseAddress(undefined), "unknown");
});

test("loopback is this machine, not the network", () => {
  assert.equal(networkOf("127.0.0.1"), "local");
  assert.equal(networkOf("::1"), "local");
  assert.equal(networkOf("unknown"), "local");
  assert.equal(networkOf("192.168.1.5"), "private");
  assert.equal(networkOf("100.65.1.1"), "cgnat");
  assert.equal(networkOf("67.205.189.229"), "public");
  // An IPv6 address we cannot classify is assumed to be the worst case.
  assert.equal(networkOf("2606:4700::1111"), "public");
});

test("a user agent is cut to the part that identifies it", () => {
  assert.equal(shortAgent(undefined), "—");
  assert.equal(shortAgent("curl/8.5.0"), "curl 8");
  assert.equal(shortAgent("VLC/3.0.20 LibVLC/3.0.20"), "VLC 3");
  assert.equal(shortAgent("Lavf/60.16.100"), "ffmpeg 60");
  // Chrome claims to be Safari, and Edge claims to be Chrome, so order matters.
  assert.equal(
    shortAgent("Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
    "Chrome 120",
  );
  assert.equal(
    shortAgent("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15"),
    "Safari 17",
  );
  assert.equal(
    shortAgent("Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"),
    "Edge 120",
  );
});

test("connections are counted while live and remembered once finished", () => {
  const set = new Connections();
  const a = set.open(request("10.0.0.5", "curl/8.5.0"), "stream", "One");
  const b = set.open(request("127.0.0.1"), "media", "Two");

  assert.equal(set.active, 2);
  set.add(a.id, 1000);
  set.add(a.id, 500);
  assert.equal(set.list().find((c) => c.id === a.id)?.bytes, 1500);

  set.close(b.id);
  assert.equal(set.active, 1);
  // Live first, then the most recently finished.
  assert.equal(set.list()[0]?.id, a.id);
  assert.equal(set.list()[1]?.id, b.id);
  assert.equal(set.list()[1]?.endedAt !== null, true);

  // Closing twice must not move the end time or the count.
  const endedAt = set.list()[1]?.endedAt;
  set.close(b.id);
  assert.equal(set.list()[1]?.endedAt, endedAt);
  assert.equal(set.active, 1);

  // Bytes for an id that is gone are dropped rather than throwing.
  set.add(9999, 10);
});

test("only so many finished connections are kept", () => {
  const set = new Connections(3);
  for (let i = 0; i < 10; i++) set.close(set.open(request("10.0.0.5"), "media", `t${i}`).id);
  const list = set.list();
  assert.equal(list.length, 3);
  // The three most recent, newest first.
  assert.deepEqual(list.map((c) => c.track), ["t9", "t8", "t7"]);
});

test("a live connection is never pruned, however many finish around it", () => {
  const set = new Connections(2);
  const live = set.open(request("10.0.0.5"), "stream", "keep me");
  for (let i = 0; i < 10; i++) set.close(set.open(request("10.0.0.6"), "media", `t${i}`).id);
  assert.equal(set.active, 1);
  assert.equal(set.list()[0]?.id, live.id);
});

test("the daemon URL is one you can connect to, not 0.0.0.0", () => {
  const base: DaemonState = {
    pid: 1, host: "0.0.0.0", port: 4321, key: "k", source: "/music", startedAt: 0, log: "/tmp/l",
  };
  assert.equal(daemonUrl(base), "http://127.0.0.1:4321");
  assert.equal(daemonUrl({ ...base, host: "192.168.1.5" }), "http://192.168.1.5:4321");
  assert.equal(daemonUrl({ ...base, host: "::" }), "http://127.0.0.1:4321");
  assert.equal(daemonUrl({ ...base, host: "::1" }), "http://[::1]:4321");
});

test("liveness is asked of the OS, not of a pid file", () => {
  assert.equal(alive(process.pid), true);
  // Nothing owns this one: pids that high are not handed out on Linux by
  // default, and if one somehow were, it is not ours.
  assert.equal(alive(0x7ffffff0), false);
});

test("durations and sizes read the way a person reads them", () => {
  assert.equal(since(0), "0s");
  assert.equal(since(45_000), "45s");
  assert.equal(since(90_000), "1m 30s");
  assert.equal(since(3_600_000), "1h 0m");
  assert.equal(since(90_000_000), "1d 1h");
  // Negative would mean a clock went backwards, which is not worth a "-3s".
  assert.equal(since(-5000), "0s");

  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(999), "999 B");
  assert.equal(bytes(1024), "1.0 KiB");
  assert.equal(bytes(1024 * 1024 * 5), "5.0 MiB");
});

const view = (over: Partial<View> = {}): View => ({
  url: "http://localhost:4321",
  report: null,
  snapshot: null,
  error: "",
  typing: false,
  restreaming: "",
  links: [
    { label: "here", url: "http://localhost:4321" },
    { label: "on tailscale", url: "http://100.96.166.75:4321" },
    { label: "on the internet", url: "http://104.152.209.195:4321" },
  ],
  key: "KEY",
  source: "/home/ubuntu/Downloads/done",
  ...over,
});

test("the admin view shows the links you can hand out, not just loopback", () => {
  const screen = renderToText(({ ui, theme }) => draw(ui, theme, view()), { width: 100, height: 40 });

  // The complaint this fixes: it showed the one address that only works on the
  // machine you are already sitting at.
  assert.match(screen, /on the internet\s+http:\/\/104\.152\.209\.195:4321\/s\/KEY/);
  assert.match(screen, /on tailscale\s+http:\/\/100\.96\.166\.75:4321\/s\/KEY/);
  assert.match(screen, /here\s+http:\/\/localhost:4321\/s\/KEY/);
  // And says what is being served, without being asked.
  assert.match(screen, /Downloads\/done/);
});

test("no key means no /s/ on the end, because there is nothing to put there", () => {
  const screen = renderToText(
    ({ ui, theme }) => draw(ui, theme, view({ key: null, links: [{ label: "here", url: "http://localhost:4321" }] })),
    { width: 100, height: 40 },
  );
  assert.match(screen, /here\s+http:\/\/localhost:4321/);
  assert.doesNotMatch(screen, /\/s\//);
});

test("pointed somewhere by hand, that address is the only one there is", () => {
  const target = resolveTarget(["--url", "http://192.168.1.5:4321/", "--key", "K"]);
  assert.equal(target.url, "http://192.168.1.5:4321");
  assert.deepEqual(target.links, [{ label: "there", url: "http://192.168.1.5:4321" }]);
  assert.equal(target.source, "", "a server somewhere else has not told us what it is playing");
});
