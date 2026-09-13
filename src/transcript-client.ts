/**
 * The transcript store and the translator, as a client sees them.
 *
 * Both live on nixamp.com (see transcripts.ts and translate.ts); a server
 * captioning a channel, the CLI writing a film down, and the MCP tools all
 * talk to them through these few calls, signed in as whoever they are.
 * Every answer is a plain object or a sentence, never a throw, because a
 * store that is briefly away must cost the memory and not the captions.
 */
import type { TranscriptLine } from "./transcripts.ts";

export interface Signed {
  site: string;
  token: string;
}

export interface StoredTranscript {
  id: string;
  media: string;
  kind: string;
  language: string;
  translatedFrom: string | null;
  model: string;
  complete: boolean;
  title: string;
  seconds: number;
  updatedAt: string;
  lines: TranscriptLine[];
  languages: { language: string; translatedFrom: string | null; lines: number; complete: boolean }[];
  /** A translation that is still being made: how far it has got. */
  translating?: { done: number; total: number };
}

export type Got<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

function base(site: string): string {
  return site.replace(/\/+$/, "");
}

async function asJson<T>(response: Response): Promise<Got<T>> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) return { ok: false, status: response.status, error: body.error ?? `nixamp.com answered ${response.status}` };
  return { ok: true, body };
}

function unreachable<T>(site: string, error: unknown): Got<T> {
  return { ok: false, status: 0, error: `could not reach ${site}: ${(error as Error).message}` };
}

/** The transcript of some media in a language ("" for the original), if the store has one. */
export async function fetchTranscript(
  signed: Signed,
  id: string,
  language = "",
  fetcher: typeof fetch = fetch,
): Promise<Got<StoredTranscript>> {
  const url = new URL(`${base(signed.site)}/api/v1/transcripts/${encodeURIComponent(id)}`);
  if (language) url.searchParams.set("language", language);
  try {
    const response = await fetcher(url.toString(), { headers: { authorization: `Bearer ${signed.token}` } });
    return await asJson<StoredTranscript>(response);
  } catch (error) {
    return unreachable(signed.site, error);
  }
}

export interface LinesToKeep {
  media: string;
  language: string;
  translatedFrom?: string | null;
  model?: string;
  title?: string;
  complete?: boolean;
  lines: TranscriptLine[];
}

/** Keep lines: appended to what the store has, or the whole thing when `complete`. */
export async function keepLines(
  signed: Signed,
  id: string,
  ask: LinesToKeep,
  fetcher: typeof fetch = fetch,
): Promise<Got<{ saved: number; seconds: number; complete: boolean }>> {
  try {
    const response = await fetcher(`${base(signed.site)}/api/v1/transcripts/${encodeURIComponent(id)}/lines`, {
      method: "POST",
      headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
      body: JSON.stringify(ask),
    });
    return await asJson(response);
  } catch (error) {
    return unreachable(signed.site, error);
  }
}

export interface Translated {
  texts: string[];
  from: string;
  to: string;
  model: string;
}

/** Texts in another language. `from` may be "" when nixamp.com should tell. */
export async function translateTexts(
  signed: Signed,
  texts: string[],
  from: string,
  to: string,
  fetcher: typeof fetch = fetch,
): Promise<Got<Translated>> {
  try {
    const response = await fetcher(`${base(signed.site)}/api/v1/translate`, {
      method: "POST",
      headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
      body: JSON.stringify({ texts, from, to }),
    });
    return await asJson<Translated>(response);
  } catch (error) {
    return unreachable(signed.site, error);
  }
}

/** Forget some media's transcripts. Only whoever stored them may. */
export async function forgetTranscript(signed: Signed, id: string, fetcher: typeof fetch = fetch): Promise<Got<{ ok: true }>> {
  try {
    const response = await fetcher(`${base(signed.site)}/api/v1/transcripts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${signed.token}` },
    });
    return await asJson(response);
  } catch (error) {
    return unreachable(signed.site, error);
  }
}

/** What this account has had written down. */
export async function listTranscripts(
  signed: Signed,
  fetcher: typeof fetch = fetch,
): Promise<Got<{ transcripts: (Omit<StoredTranscript, "lines" | "languages"> & { lines: number })[] }>> {
  try {
    const response = await fetcher(`${base(signed.site)}/api/v1/transcripts`, { headers: { authorization: `Bearer ${signed.token}` } });
    return await asJson(response);
  } catch (error) {
    return unreachable(signed.site, error);
  }
}
