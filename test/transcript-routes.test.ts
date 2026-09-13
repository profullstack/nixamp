import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { EmptyEngine, createServer } from "../src/server.ts";
import type { Queryable } from "../src/follows.ts";
import { Transcripts, transcriptIdOf, type TranscriptLine } from "../src/transcripts.ts";
import { Translator } from "../src/translate.ts";
import { StoredTranslations } from "../src/translate-jobs.ts";

/** The transcripts table, in memory, behaving as the SQL in transcripts.ts does. */
function memoryDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db: Queryable = {
    async query(text, values = []) {
      if (text.includes("INSERT INTO transcripts")) {
        const key = `${values[0]}|${values[1]}`;
        const had = rows.get(key);
        const lines = JSON.parse(values[10] as string) as TranscriptLine[];
        const complete = values[6] as boolean;
        const row = {
          id: values[0], language: values[1], media: values[2], kind: values[3],
          translated_from: (values[4] as string | null) ?? (had?.["translated_from"] as string | null) ?? null,
          model: values[5] === "" ? (had?.["model"] ?? "") : values[5],
          complete: complete || had?.["complete"] === true,
          title: values[7] === "" ? (had?.["title"] ?? "") : values[7],
          by_account: had?.["by_account"] ?? values[8],
          seconds: complete ? values[9] : Math.max(Number(had?.["seconds"] ?? 0), values[9] as number),
          lines: complete ? lines : had?.["complete"] === true ? had["lines"] : [...((had?.["lines"] as TranscriptLine[] | undefined) ?? []), ...lines],
          updated_at: new Date("2026-09-13T12:00:00.000Z"),
        };
        rows.set(key, row);
        return { rows: [row] };
      }
      if (text.includes("translated_from IS NULL")) {
        const found = [...rows.values()].filter((row) => row["id"] === values[0] && row["translated_from"] === null);
        found.sort((a, b) => Number(b["complete"]) - Number(a["complete"]));
        return { rows: found.slice(0, 1) };
      }
      if (text.includes("AND language = $2")) {
        const row = rows.get(`${values[0]}|${values[1]}`);
        return { rows: row ? [row] : [] };
      }
      if (text.includes("ORDER BY translated_from NULLS FIRST")) {
        return {
          rows: [...rows.values()].filter((row) => row["id"] === values[0]).map((row) => ({
            language: row["language"], translated_from: row["translated_from"], complete: row["complete"], lines: (row["lines"] as unknown[]).length,
          })),
        };
      }
      if (text.includes("WHERE by_account = $1")) {
        return { rows: [...rows.values()].filter((row) => row["by_account"] === values[0]).map((row) => ({ ...row, lines: (row["lines"] as unknown[]).length })) };
      }
      if (text.startsWith("DELETE FROM transcripts")) {
        const gone: Record<string, unknown>[] = [];
        for (const [key, row] of rows) {
          if (row["id"] === values[0] && row["by_account"] === values[1]) {
            rows.delete(key);
            gone.push({ language: row["language"] });
          }
        }
        return { rows: gone };
      }
      return { rows: [] };
    },
  };
  return { db, rows };
}

async function withSite(body: (base: string, rows: Map<string, Record<string, unknown>>) => Promise<void>): Promise<void> {
  const { db, rows } = memoryDb();
  const store = new Transcripts(db);
  const translator = new Translator({
    load: async (model) => ({ translate: async (texts) => texts.map((text) => `${model.slice(-5)}:${text}`) }),
  });
  const accounts = {
    whoIs: async (token: string) => (token === "mine" ? { id: "acct-1", email: "me@example.com" } : token === "theirs" ? { id: "acct-2", email: "t@example.com" } : null),
  } as unknown as Parameters<typeof createServer>[1]["accounts"];
  const server = createServer(new EmptyEngine(), {
    web: null,
    media: false,
    version: "test",
    accounts,
    transcripts: store,
    translations: new StoredTranslations(store, translator),
    translator,
    site: "https://nixamp.test",
    authServer: {} as never,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`, rows);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const mine = { authorization: "Bearer mine" };
const MEDIA = "url:https://example.com/film.mp4";
const ID = transcriptIdOf(MEDIA);

test("the store's routes: signed in only; lines kept, read back as JSON or subtitles, by id or by media; translated on the spot when short", async () => {
  await withSite(async (base) => {
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}/lines`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}`, { headers: mine })).status, 404);

    const kept = await fetch(`${base}/api/v1/transcripts/${ID}/lines`, {
      method: "POST",
      headers: { ...mine, "content-type": "application/json" },
      body: JSON.stringify({
        media: MEDIA, language: "en", model: "whisper-base", title: "A film",
        lines: [{ start: 5, end: 10, text: "second" }, { start: 0, end: 5, text: "first" }],
      }),
    });
    assert.equal(kept.status, 200);
    assert.deepEqual(await kept.json(), { id: ID, language: "en", saved: 2, seconds: 10, complete: false });

    // The wrong media for this id, and a body with nothing in it, are 400s.
    const wrong = await fetch(`${base}/api/v1/transcripts/${ID}/lines`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" }, body: JSON.stringify({ media: "url:https://elsewhere", language: "en", lines: [] }),
    });
    assert.equal(wrong.status, 400);
    const empty = await fetch(`${base}/api/v1/transcripts/${ID}/lines`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" }, body: JSON.stringify({ media: MEDIA, language: "en", lines: [] }),
    });
    assert.equal(empty.status, 400);

    const read = await fetch(`${base}/api/v1/transcripts/${ID}`, { headers: mine });
    assert.equal(read.status, 200);
    const got = (await read.json()) as { id: string; media: string; language: string; lines: TranscriptLine[]; languages: unknown[]; complete: boolean; kind: string };
    assert.equal(got.id, ID);
    assert.equal(got.media, MEDIA);
    assert.equal(got.kind, "url");
    assert.equal(got.language, "en");
    assert.deepEqual(got.lines.map((line) => line.text), ["first", "second"]);
    assert.deepEqual(got.languages, [{ language: "en", translatedFrom: null, lines: 2, complete: false }]);

    // The media identity itself names the same row.
    const byMedia = await fetch(`${base}/api/v1/transcripts/${encodeURIComponent(MEDIA)}`, { headers: mine });
    assert.equal(byMedia.status, 200);
    assert.equal(((await byMedia.json()) as { id: string }).id, ID);

    const srt = await fetch(`${base}/api/v1/transcripts/${ID}?format=srt`, { headers: mine });
    assert.equal(srt.status, 200);
    assert.match(srt.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(srt.headers.get("content-disposition") ?? "", /A_film\.en\.srt/);
    assert.equal(await srt.text(), "1\n00:00:00,000 --> 00:00:05,000\nfirst\n\n2\n00:00:05,000 --> 00:00:10,000\nsecond\n");
    const vtt = await fetch(`${base}/api/v1/transcripts/${ID}?format=vtt`, { headers: mine });
    assert.match(vtt.headers.get("content-type") ?? "", /text\/vtt/);
    assert.match(await vtt.text(), /^WEBVTT\n\n00:00:00\.000 --> 00:00:05\.000\nfirst/);
    const txt = await fetch(`${base}/api/v1/transcripts/${ID}?format=txt`, { headers: mine });
    assert.equal(await txt.text(), "first\nsecond");
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}?format=doc`, { headers: mine })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}?language=german`, { headers: mine })).status, 400);

    // Two lines is short: German is made before the answer, and kept.
    const german = await fetch(`${base}/api/v1/transcripts/${ID}?language=de&format=txt`, { headers: mine });
    assert.equal(german.status, 200);
    assert.equal(await german.text(), "en-de:first\nen-de:second");
    const again = (await (await fetch(`${base}/api/v1/transcripts/${ID}?language=de`, { headers: mine })).json()) as {
      language: string; translatedFrom: string; model: string; languages: { language: string }[];
    };
    assert.equal(again.language, "de");
    assert.equal(again.translatedFrom, "en");
    assert.equal(again.model, "Xenova/opus-mt-en-de");
    assert.deepEqual(again.languages.map((one) => one.language), ["en", "de"]);
    // Asking for the language it was heard in is the original.
    assert.equal(((await (await fetch(`${base}/api/v1/transcripts/${ID}?language=en`, { headers: mine })).json()) as { language: string }).language, "en");
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}?language=xx`, { headers: mine })).status, 409);

    const list = (await (await fetch(`${base}/api/v1/transcripts`, { headers: mine })).json()) as { transcripts: { language: string; lines: number; title: string }[] };
    assert.deepEqual(list.transcripts.map((one) => `${one.language}:${one.lines}:${one.title}`).sort(), ["de:2:A film", "en:2:A film"]);

    // Somebody else may read it, and may not take it away; its keeper may.
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}`, { headers: { authorization: "Bearer theirs" } })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}`, { method: "DELETE", headers: { authorization: "Bearer theirs" } })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}`, { method: "DELETE", headers: mine })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/transcripts/${ID}`, { headers: mine })).status, 404);
  });
});

test("translation over the API: which languages, and texts in another one; signed in only", async () => {
  await withSite(async (base) => {
    const languages = (await (await fetch(`${base}/api/v1/translate`)).json()) as { available: boolean; languages: { code: string; native: string; targets: string[] }[] };
    assert.equal(languages.available, true);
    const swedish = languages.languages.find((one) => one.code === "sv");
    assert.equal(swedish?.native, "Svenska");
    assert.ok(swedish?.targets.includes("de"));
    assert.equal((await fetch(`${base}/api/v1/translate`, { method: "POST", body: "{}" })).status, 401);
    const bad = await fetch(`${base}/api/v1/translate`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" }, body: JSON.stringify({ texts: ["hi"], to: "de" }),
    });
    assert.equal(bad.status, 400);
    const done = await fetch(`${base}/api/v1/translate`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" }, body: JSON.stringify({ texts: ["Hej.", ""], from: "sv", to: "de" }),
    });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { texts: ["en-de:sv-en:Hej.", ""], from: "sv", to: "de", model: "Xenova/opus-mt-sv-en then Xenova/opus-mt-en-de" });
    const one = await fetch(`${base}/api/v1/translate`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" }, body: JSON.stringify({ text: "Hello", from: "en", to: "sv" }),
    });
    assert.deepEqual(((await one.json()) as { texts: string[] }).texts, ["en-sv:Hello"]);
  });
});

test("MCP over HTTP at /mcp: a bearer token, one message or a batch, silence for a notification, and where the authorization server is", async () => {
  await withSite(async (base) => {
    const refused = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/nixamp.test\/.well-known\/oauth-protected-resource"/);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: "DELETE" })).status, 204);

    const init = await fetch(`${base}/mcp`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    assert.equal(init.status, 200);
    const hello = (await init.json()) as { id: number; result: { serverInfo: { name: string }; protocolVersion: string } };
    assert.equal(hello.id, 1);
    assert.equal(hello.result.serverInfo.name, "nixamp");

    const quiet = await fetch(`${base}/mcp`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(quiet.status, 202);

    const batch = await fetch(`${base}/mcp`, {
      method: "POST", headers: { ...mine, "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "ping" }, "junk"]),
    });
    const answers = (await batch.json()) as { id: number | null; result?: { tools?: { name: string }[] }; error?: { code: number } }[];
    assert.equal(answers.length, 3);
    assert.ok((answers[0]?.result?.tools?.length ?? 0) >= 12);
    assert.deepEqual(answers[1], { jsonrpc: "2.0", id: 3, result: {} });
    assert.equal(answers[2]?.error?.code, -32600);
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: mine, body: "{" })).status, 400);

    const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { resource: string; authorization_servers: string[] };
    assert.equal(metadata.resource, "https://nixamp.test");
    assert.deepEqual(metadata.authorization_servers, ["https://nixamp.test"]);
  });
});
