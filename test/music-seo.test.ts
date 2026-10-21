import { test } from "node:test";
import assert from "node:assert/strict";
import { musicPage, renderMusicPage } from "../src/music-seo.ts";
import type { HubCatalogue } from "../src/music-hub.ts";
import { stationImage } from "../src/radio-pages.ts";

const SITE = "https://nixamp.com";
const catalogue: HubCatalogue = {
  holders: ["Profullstack, Inc."],
  stations: [],
  genres: [{
    genre: "Yacht Rock",
    stations: [],
    artists: [{
      server: "f5fd7d9747", key: "0243b45872", name: "Marina Del Gray", genre: "Yacht Rock", follow: "artist:marina-del-gray",
      bio: "A singer-songwriter who writes on the deck of her sailboat.",
      members: [{ slug: "marina", name: "Marina Del Gray", role: "vocals", bio: "" }],
      albums: [{ key: "aaaa1111", title: "Sailing into Sunset", year: 2026, concept: "A weekend on the water <and> back.", cover: true, complete: false,
        songs: [{ n: 1, title: "Island Weekend", seconds: 121 }, { n: 2, title: "Sunlit Waves", seconds: 118 }] }],
    }],
  }],
};
const SHELL = `<!doctype html><html><head><meta charset="utf-8" /><title>Music · nixamp</title><meta name="description" content="generic" /></head><body><main id="view" class="view" tabindex="-1" aria-live="polite"></main></body></html>`;
const render = (path: string) => renderMusicPage(SHELL, musicPage(path, catalogue, SITE), `${SITE}${path}`);

test("every /music page has its own title, and only one", () => {
  const titles = ["/music", "/music/genre/yacht-rock", "/music/artist/f5fd7d9747/0243b45872", "/music/album/f5fd7d9747/0243b45872/aaaa1111", "/music/me"]
    .map((path) => { const html = render(path); assert.equal(html.match(/<title>/g)?.length, 1, path); return /<title>([^<]*)/.exec(html)![1]; });
  assert.equal(new Set(titles).size, titles.length, titles.join(" | "));
  assert.equal(titles[3], "Sailing into Sunset by Marina Del Gray · nixamp music");
});

test("an album shares its cover, its artist and its songs", () => {
  const html = render("/music/album/f5fd7d9747/0243b45872/aaaa1111");
  assert.match(html, /<meta property="og:type" content="music\.album" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/nixamp\.com\/api\/v1\/music\/file\/f5fd7d9747\/0243b45872\/aaaa1111\/cover\.jpg" \/>/);
  assert.match(html, /<meta property="og:title" content="Sailing into Sunset by Marina Del Gray" \/>/);
  assert.match(html, /<meta property="music:musician" content="https:\/\/nixamp\.com\/music\/artist\/f5fd7d9747\/0243b45872" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/nixamp\.com\/music\/album\/f5fd7d9747\/0243b45872\/aaaa1111" \/>/);
  // Crawlers read the songs without the script; the app replaces this when it runs.
  assert.match(html, /<main id="view"[^>]*><p>.*<h1>Sailing into Sunset<\/h1>.*<li>Island Weekend <span>2:01<\/span><\/li>/);
  // Text is escaped in the head and the body; JSON-LD cannot close its script.
  assert.match(html, /A weekend on the water &lt;and&gt; back\./);
  const ld = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)![1]!) as Record<string, unknown>;
  assert.equal(ld["@type"], "MusicAlbum");
  assert.equal((ld["byArtist"] as { name: string }).name, "Marina Del Gray");
  assert.equal((ld["track"] as unknown[]).length, 2);
  assert.doesNotMatch(html, /content="generic"/);
});

test("an artist shares its picture and bio; a missing one is a 404 that is not indexed; My music is never indexed", () => {
  const artist = render("/music/artist/f5fd7d9747/0243b45872");
  assert.match(artist, /<meta property="og:image" content="[^"]*aaaa1111\/cover\.jpg" \/>/);
  assert.match(artist, /<meta property="og:description" content="A singer-songwriter who writes on the deck of her sailboat\." \/>/);
  assert.match(artist, /"@type":"MusicGroup"/);
  const gone = musicPage("/music/artist/f5fd7d9747/ffffffffff", catalogue, SITE);
  assert.equal(gone.status, 404);
  assert.equal(gone.head.noindex, true);
  assert.match(render("/music/me"), /<meta name="robots" content="noindex" \/>/);
});

test("a station's link preview is the cover of an album it plays, or none", () => {
  const album = (slug: string, stations: string[], cover: boolean) => [slug, { slug, title: slug, year: 0, artist: "a", artistName: "A", concept: "", complete: true, tracks: [], stations, ...(cover ? { coverFile: "/x.mp3" } : {}) }] as const;
  const catalogue = { artists: new Map(), albums: new Map([album("no-art", ["ai-yacht-rock"], false), album("with-art", ["ai-yacht-rock"], true)]) };
  assert.equal(stationImage(catalogue as never, "ai-yacht-rock", "https://live.streaming.pit.world"), "https://live.streaming.pit.world/radio/album/with-art/cover.jpg");
  assert.equal(stationImage(catalogue as never, "ai-punk", "https://live.streaming.pit.world"), "");
});
