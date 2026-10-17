import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_PROTOCOLS, REMOTE_PROTOCOLS, protocolArgs } from "../src/decoder-policy.ts";
import { isPrivateAddress, refusedDestination } from "../src/destinations.ts";
import { resolvePlaylist } from "../src/links.ts";
import { publishChoice, shouldRecord } from "../src/publish-choice.ts";
import { keyCookie } from "../src/share.ts";

test("a library file may open files and pipes, never the network", () => {
  assert.deepEqual(protocolArgs("/music/a.flac"), ["-protocol_whitelist", LOCAL_PROTOCOLS]);
  assert.deepEqual(protocolArgs("file:/music/a.m3u8"), ["-protocol_whitelist", LOCAL_PROTOCOLS]);
  assert.deepEqual(protocolArgs("C:\\Music\\a.mp3"), ["-protocol_whitelist", LOCAL_PROTOCOLS]);
  assert.deepEqual(protocolArgs("pipe:0"), ["-protocol_whitelist", LOCAL_PROTOCOLS]);
  assert.ok(!LOCAL_PROTOCOLS.split(",").includes("http"));
});

test("a link may open the network, never the file system", () => {
  assert.deepEqual(protocolArgs("https://cdn.example/live.m3u8"), ["-protocol_whitelist", REMOTE_PROTOCOLS]);
  assert.deepEqual(protocolArgs("rtmps://ingest.example/app"), ["-protocol_whitelist", REMOTE_PROTOCOLS]);
  assert.ok(!REMOTE_PROTOCOLS.split(",").includes("file"));
  // Schemes this does not police are left as they were.
  assert.deepEqual(protocolArgs("srt://0.0.0.0:9000"), []);
});

test("private, loopback, link-local and metadata addresses are not public", () => {
  for (const one of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.96.166.75", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(one), true, one);
  }
  for (const one of ["104.152.209.195", "8.8.8.8", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(one), false, one);
  }
});

test("a member's link has to resolve somewhere public", async () => {
  const dns = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];
  assert.equal(await refusedDestination("https://cdn.example/a.mp3", dns({ "cdn.example": ["93.184.216.34"] })), "");
  assert.match(await refusedDestination("http://127.0.0.1:4321/api/state"), /this machine|private/);
  assert.match(await refusedDestination("http://localhost/"), /this machine/);
  assert.match(await refusedDestination("http://169.254.169.254/latest/meta-data"), /private/);
  // Every address, not the first: one private answer is enough to refuse.
  assert.match(await refusedDestination("https://mixed.example/", dns({ "mixed.example": ["93.184.216.34", "10.0.0.5"] })), /private/);
  assert.match(await refusedDestination("file:///etc/passwd"), /only http/);
  assert.match(await refusedDestination("https://nowhere.example/", dns({})), /resolve/);
});

test("a guarded playlist fetch refuses a redirect into the LAN", async () => {
  const fetcher = (async (url: string | URL) => {
    if (String(url) === "https://public.example/list.m3u") {
      return new Response("", { status: 302, headers: { location: "http://192.168.1.1/list.m3u" } });
    }
    return new Response("#EXTM3U\nhttp://192.168.1.1/a.mp3\n", { status: 200 });
  }) as typeof fetch;
  const guard = async (url: string) => (url.includes("192.168.") ? "that link points inside a private network" : "");
  const answer = await resolvePlaylist("https://public.example/list.m3u", { fetcher, guard });
  assert.ok("error" in answer);
  assert.match((answer as { error: string }).error, /private network/);
});

test("an unguarded playlist fetch still follows redirects for the owner", async () => {
  let asked: RequestInit | undefined;
  const fetcher = (async (_url: string | URL, init?: RequestInit) => {
    asked = init;
    return new Response("#EXTM3U\nhttps://cdn.example/a.mp3\n", { status: 200 });
  }) as typeof fetch;
  const answer = await resolvePlaylist("https://public.example/list.m3u", { fetcher });
  assert.ok(!("error" in answer));
  assert.equal(asked?.redirect, "follow");
});

test("the key cookie is Secure over https and not over plain http", () => {
  assert.match(keyCookie("k", true), /; Secure$/);
  assert.doesNotMatch(keyCookie("k"), /Secure/);
});

test("the directory listing is a choice, kept, and existing servers keep theirs", () => {
  // Flags win.
  assert.equal(publishChoice("yes", false, false, false), "yes");
  assert.equal(publishChoice("no", true, true, true), "no");
  // A recorded choice is read back.
  assert.equal(publishChoice("ask", false, false, true), "no");
  assert.equal(publishChoice("ask", true, false, false), "yes");
  // Nothing recorded: a person is asked; a daemon on a server that has run
  // here before stays listed; a brand new daemon is not listed.
  assert.equal(publishChoice("ask", undefined, true, false), "ask");
  assert.equal(publishChoice("ask", undefined, false, true), "yes");
  assert.equal(publishChoice("ask", undefined, false, false), "no");
  assert.equal(shouldRecord("ask", undefined), true);
  assert.equal(shouldRecord("ask", true), false);
  assert.equal(shouldRecord("yes", undefined), false);
});
