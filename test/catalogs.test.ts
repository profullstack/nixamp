import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Catalogs, MAX_LIST_BYTES, entryId, isLiveEntry, parseCatalog, preferPlus, readCatalog, shownCatalog, shownEntry,
} from "../src/catalogs.ts";

const LIST = `#EXTM3U
#EXTINF:-1 tvg-id="cnn.us" tvg-name="CNN" tvg-logo="https://logos.test/cnn.png" group-title="News",CNN HD
http://iptv.test/live/u/p/301.ts
#EXTINF:-1 tvg-name="MLB Network" group-title="Sports",MLB Network
http://iptv.test/live/u/p/932
#EXTINF:5400 group-title="Movies",Sneakers (1992)
http://iptv.test/movie/u/p/77.mkv
#EXTGRP:Radio
#EXTINF:-1,Jazz FM
http://radio.test/jazz.m3u8
#EXTINF:-1 group-title="News",CNN HD
http://iptv.test/live/u/p/301.ts
`;

test("an extended m3u is read with its groups, logos and names", () => {
  const entries = parseCatalog(LIST, "http://iptv.test/get.php");
  // The last line repeats the first source, and a repeat is not a second entry.
  assert.equal(entries.length, 4);
  const [cnn, mlb, film, jazz] = entries;
  assert.deepEqual(
    { title: cnn?.title, group: cnn?.group, logo: cnn?.logo, live: cnn?.live },
    { title: "CNN HD", group: "News", logo: "https://logos.test/cnn.png", live: true },
  );
  assert.equal(mlb?.title, "MLB Network");
  assert.equal(mlb?.live, true);
  // A stated length is a film, and so is /movie/ in the address.
  assert.deepEqual({ group: film?.group, live: film?.live, duration: film?.duration }, { group: "Movies", live: false, duration: 5400 });
  // #EXTGRP names the group when the EXTINF did not.
  assert.deepEqual({ group: jazz?.group, live: jazz?.live }, { group: "Radio", live: true });
  // Ids are the source, hashed: stable across refreshes, safe in a URL.
  assert.equal(cnn?.id, entryId("http://iptv.test/live/u/p/301.ts"));
  assert.match(cnn?.id ?? "", /^[0-9a-f]{12}$/);
});

test("live or on demand is judged from what the list says and how the address is shaped", () => {
  assert.equal(isLiveEntry("http://x/live/u/p/1.ts", 0), true);
  assert.equal(isLiveEntry("http://x/u/p/1", 0), true);
  assert.equal(isLiveEntry("http://x/stream.m3u8", 0), true);
  assert.equal(isLiveEntry("http://x/movie/u/p/1.mp4", 0), false);
  assert.equal(isLiveEntry("http://x/series/u/p/1", 0), false);
  assert.equal(isLiveEntry("http://x/a/film.mkv?token=1", 0), false);
  assert.equal(isLiveEntry("http://x/u/p/1", 90), false);
  assert.equal(isLiveEntry("/home/me/song.flac", 0), false);
});

test("a listener is shown the entry, not where its bytes are", () => {
  const [cnn] = parseCatalog(LIST, "http://iptv.test/get.php");
  assert.equal("source" in shownEntry(cnn!), false);
  assert.equal(shownEntry(cnn!).title, "CNN HD");
});

/** A provider that answers from a script and counts how often it was asked. */
function provider(text = LIST, status = 200) {
  const asked: string[] = [];
  const send = (async (url: string | URL) => {
    asked.push(String(url));
    return new Response(text, { status, headers: { "content-type": "audio/x-mpegurl" } });
  }) as unknown as typeof fetch;
  return { asked, send };
}

test("a catalog is added, read, browsed by group, searched, and removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-catalogs-"));
  const { asked, send } = provider();
  const catalogs = new Catalogs(dir, 4321, send);

  const added = await catalogs.add("http://iptv.test/get.php?u=p", "My IPTV");
  assert.equal(asked.length, 1);
  assert.deepEqual(
    { name: added.name, entries: added.entries, live: added.live, vod: added.vod, groups: added.groups, error: added.error },
    { name: "My IPTV", entries: 4, live: 3, vod: 1, groups: 4, error: "" },
  );
  assert.ok(added.refreshedAt > 0);

  // Groups in the order the list had them.
  assert.deepEqual(catalogs.groups(added.id)?.map((g) => [g.name, g.count, g.live, g.vod]), [
    ["News", 1, 1, 0], ["Sports", 1, 1, 0], ["Movies", 1, 0, 1], ["Radio", 1, 1, 0],
  ]);
  assert.equal(catalogs.entries_(added.id, { group: "News" })?.entries[0]?.title, "CNN HD");
  assert.equal(catalogs.entries_(added.id, { q: "mlb" })?.total, 1);
  assert.equal(catalogs.entries_(added.id, {})?.total, 4);
  // Paged.
  const page = catalogs.entries_(added.id, { offset: 3, limit: 2 });
  assert.deepEqual({ total: page?.total, got: page?.entries.length }, { total: 4, got: 1 });
  assert.equal(catalogs.entry(added.id, entryId("http://iptv.test/live/u/p/932"))?.title, "MLB Network");

  // What a listener sees of the catalog has no source in it; an admin's does.
  assert.equal("source" in shownCatalog(added, false), false);
  assert.equal(shownCatalog(added, true).source, "http://iptv.test/get.php?u=p");

  // Written down: the index and the entries, so a restart browses at once.
  assert.ok(existsSync(join(dir, "catalogs.json")));
  const again = new Catalogs(dir, 4321, send);
  again.load();
  assert.equal(again.list()[0]?.entries, 4);
  assert.equal(asked.length, 1, "loaded from disk, not asked for again");
  await again.warm();
  assert.equal(asked.length, 1);

  // Somebody else's port is a different line-up.
  const other = new Catalogs(dir, 5000, send);
  other.load();
  assert.equal(other.list().length, 0);

  assert.equal(catalogs.remove(added.id), true);
  assert.equal(catalogs.list().length, 0);
  assert.equal(catalogs.groups(added.id), null);
  assert.equal(catalogs.remove(added.id), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "catalogs.json"), "utf8"))["4321"], []);
});

test("a provider that is down leaves the old entries and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-catalogs-"));
  let status = 200;
  const send = (async () => new Response(LIST, { status })) as unknown as typeof fetch;
  const catalogs = new Catalogs(dir, 4321, send);
  const added = await catalogs.add("http://iptv.test/list.m3u", "");
  // Named from the file when nobody named it.
  assert.equal(added.name, "list");
  status = 503;
  const refreshed = await catalogs.refresh(added.id);
  assert.match(refreshed?.error ?? "", /503/);
  assert.equal(refreshed?.entries, 4, "the old list stays until the provider is back");

  // Adding it again is not a second catalog.
  status = 200;
  const same = await catalogs.add("http://iptv.test/list.m3u", "Renamed");
  assert.equal(same.id, added.id);
  assert.equal(same.name, "Renamed");
  assert.equal(catalogs.list().length, 1);
  assert.equal(same.error, "");
});

test("a list that is not a playlist is refused", async () => {
  // The cap is hundreds of megabytes; the test passes a small one rather than
  // allocating it.
  assert.ok(MAX_LIST_BYTES >= 256 * 1024 * 1024, "a real provider's full list is tens of MB");
  const { send } = provider("x".repeat(2049));
  await assert.rejects(readCatalog("http://iptv.test/huge.m3u", send, 2048), /bigger than/);
  const { send: missing } = provider("", 404);
  await assert.rejects(readCatalog("http://iptv.test/gone.m3u", missing), /404/);
});

test("a plain Xtream list is asked for in its richer form first, and grouped by what its addresses say", async () => {
  assert.equal(preferPlus("http://p.test/playlist/u/p/m3u"), "http://p.test/playlist/u/p/m3u_plus");
  assert.equal(preferPlus("http://p.test/playlist/u/p/m3u_plus"), "http://p.test/playlist/u/p/m3u_plus");
  assert.equal(preferPlus("http://p.test/get.php?username=u&password=p&type=m3u&output=ts"),
    "http://p.test/get.php?username=u&password=p&type=m3u_plus&output=ts");
  assert.equal(preferPlus("https://iptv-org.github.io/iptv/countries/us.m3u"), "https://iptv-org.github.io/iptv/countries/us.m3u");

  // A plain list: no attributes at all, four hundred thousand times over.
  const plain = `#EXTM3U
#EXTINF:-1,ATN Bangla
http://p.test/live/u/p/1.ts
#EXTINF:-1,Sneakers (1992)
http://p.test/movie/u/p/2.mkv
#EXTINF:-1,Pluribus S01E01
http://p.test/series/u/p/3.mkv
`;
  const entries = parseCatalog(plain, "http://p.test/playlist/u/p/m3u");
  assert.deepEqual(entries.map((e) => [e.group, e.live]), [["Live TV", true], ["Movies", false], ["Series", false]]);

  // The panel serves the richer form: it is used, and the given address kept.
  const asked: string[] = [];
  const send = (async (url: string | URL) => {
    asked.push(String(url));
    if (String(url).endsWith("m3u_plus")) {
      return new Response('#EXTM3U\n#EXTINF:-1 group-title="News",CNN\nhttp://p.test/live/u/p/1.ts\n', { status: 200 });
    }
    return new Response(plain, { status: 200 });
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "nixamp-catalogs-"));
  const catalogs = new Catalogs(dir, 4321, send);
  const added = await catalogs.add("http://p.test/playlist/u/p/m3u", "Plus");
  assert.deepEqual(asked, ["http://p.test/playlist/u/p/m3u_plus"]);
  assert.equal(added.entries, 1);
  assert.equal(catalogs.groups(added.id)?.[0]?.name, "News");
  assert.equal(shownCatalog(added, true).source, "http://p.test/playlist/u/p/m3u");

  // The panel does not serve it: the given address is what is read.
  const refusing = (async (url: string | URL) => {
    asked.push(String(url));
    return new Response(String(url).endsWith("m3u_plus") ? "" : plain, { status: String(url).endsWith("m3u_plus") ? 404 : 200 });
  }) as unknown as typeof fetch;
  const fallback = new Catalogs(mkdtempSync(join(tmpdir(), "nixamp-catalogs-")), 4321, refusing);
  const plainOne = await fallback.add("http://p.test/playlist/u/p/m3u", "Plain");
  assert.equal(plainOne.entries, 3);
  assert.equal(plainOne.error, "");
});
