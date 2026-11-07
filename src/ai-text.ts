/**
 * One question to a language model, one JSON answer.
 *
 * AI radio asks for small things: a title and a prompt for the next track, a
 * genre and a verdict for a shared file. Whichever model has a key answers --
 * c0mpute, then Gemini, then OpenAI, then Anthropic -- and when none has, the
 * caller is told so and does without (a rule of its own, or a person). The
 * answer is parsed and handed back as an object; a model that rambles round
 * its JSON is read for the first object in what it said.
 */
import { ProviderError, createAiProviders, type AiRouter } from "@profullstack/ai-providers";
import { aiKey } from "./ai-keys.ts";

export interface AskOptions {
  /** What the model is for, said once. */
  system: string;
  /** The question, with what it should answer from. */
  prompt: string;
  /** Milliseconds before giving up on a hosted model (default 30 s); c0mpute gets at least C0MPUTE_MIN_WAIT_MS. */
  timeoutMs?: number;
  /** The longest answer, in tokens (default 1024): a song's words need more than a title does. */
  maxTokens?: number;
  /** The OpenAI-compatible model to ask instead of NIXAMP_OPENAI_MODEL (a slower, better writer for song words). */
  model?: string;
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface Answer {
  /** Which model answered, for the record ("gemini-flash-latest", ...). */
  model: string;
  value: Record<string, unknown>;
}

export class NoModel extends Error {
  constructor() {
    super("no language model key is set (C0MPUTE_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY)");
  }
}

/**
 * Raw line breaks and tabs inside JSON strings, escaped: models writing song
 * words often break the lines for real inside the quotes, which JSON refuses.
 */
export function escapeInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      else if (char === "\n") { out += "\\n"; continue; }
      else if (char === "\r") continue;
      else if (char === "\t") { out += "\\t"; continue; }
    } else if (char === "\"") inString = true;
    out += char;
  }
  return out;
}

/** The first JSON object in a model's answer. */
export function firstObject(text: string): Record<string, unknown> {
  const fenced = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const cleaned = (() => {
    try { JSON.parse(fenced); return fenced; } catch { return escapeInStrings(fenced); }
  })();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Look inside it instead.
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new Error("the model did not answer with a JSON object");
}

/** The c0mpute key, or "" when there is none or C0MPUTE_DISABLED turns it off. */
export function c0mputeKey(env: Record<string, string | undefined> = process.env): string {
  return /^(1|true|yes|on)$/i.test(env["C0MPUTE_DISABLED"] ?? "") ? "" : aiKey("C0MPUTE_API_KEY", env);
}

/** Whether any model can be asked. */
export function hasModel(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(c0mputeKey(env) || aiKey("GEMINI_API_KEY", env) || aiKey("OPENAI_API_KEY", env) || aiKey("ANTHROPIC_API_KEY", env));
}

/**
 * c0mpute's 9B model takes 30 s for a short JSON answer, longer on a busy
 * node, so it never gets a hosted model's 30 s budget.
 */
export const C0MPUTE_MIN_WAIT_MS = 120_000;

/** c0mpute alone: the fallbacks are this file's own chain, not the package's. */
export function c0mputeRouter(key: string, options: { env?: Record<string, string | undefined>; fetcher?: typeof fetch; concurrency?: number } = {}): AiRouter {
  return createAiProviders({
    env: { ...(options.env ?? process.env), C0MPUTE_API_KEY: key },
    paidFallback: false,
    c0mpute: {
      ...(options.fetcher ? { fetch: options.fetcher } : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    },
  });
}

export interface C0mputeAsk {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * One answer from c0mpute, read by `read`. An answer `read` refuses gets one
 * more try on the same model, told what was wrong with it, before the caller
 * moves on: a small model misses far more often than a hosted one.
 */
export async function askC0mpute<T>(router: AiRouter, ask: C0mputeAsk, read: (text: string) => T): Promise<{ model: string; value: T }> {
  const { value } = await router.run(async (provider) => {
    const first = await provider.generate(ask);
    try {
      return { model: first.model, value: read(first.text) };
    } catch (error) {
      const again = await provider.generate({
        ...ask,
        user: `${ask.user}\n\nYour previous answer could not be used: ${(error as Error).message}\nAnswer again with only the corrected JSON object.`,
      });
      try {
        return { model: again.model, value: read(again.text) };
      } catch (second) {
        throw new ProviderError("c0mpute", (second as Error).message, { kind: "output" });
      }
    }
  });
  return value;
}

/** The router askJson shares across calls, so a dead or busy c0mpute is parked for all of them. */
let shared: { key: string; router: AiRouter } | undefined;
function sharedRouter(key: string, env: Record<string, string | undefined>): AiRouter {
  if (shared?.key !== key) shared = { key, router: c0mputeRouter(key, { env }) };
  return shared.router;
}

export async function askJson(options: AskOptions): Promise<Answer> {
  const env = options.env ?? process.env;
  const send = options.fetcher ?? fetch;
  const c0mpute = c0mputeKey(env);
  const gemini = aiKey("GEMINI_API_KEY", env);
  const openai = aiKey("OPENAI_API_KEY", env);
  const anthropic = aiKey("ANTHROPIC_API_KEY", env);
  // Each model with a key, in turn: one that refuses this server (Gemini
  // answers 400 "User location is not supported" from some networks) or is
  // down is not a reason to go without when another can answer.
  const tries: Array<() => Promise<Answer>> = [];
  if (c0mpute) tries.push(() => askC0mpute(
    options.fetcher ? c0mputeRouter(c0mpute, { env, fetcher: options.fetcher }) : sharedRouter(c0mpute, env),
    {
      system: `${options.system}\nAnswer with one JSON object and nothing else.`,
      user: options.prompt,
      maxTokens: options.maxTokens ?? 1024,
      timeoutMs: Math.max(options.timeoutMs ?? 0, C0MPUTE_MIN_WAIT_MS),
    },
    firstObject,
  ));
  if (gemini) tries.push(async () => {
    const model = env["NIXAMP_GEMINI_MODEL"] || "gemini-flash-latest";
    const response = await send(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { "content-type": "application/json", "x-goog-api-key": gemini },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.system }] },
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.9, maxOutputTokens: options.maxTokens ?? 1024 },
      }),
    });
    if (!response.ok) {
      const said = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`gemini answered HTTP ${response.status}${said.error?.message ? `: ${said.error.message}` : ""}`);
    }
    const body = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.map((one) => one.text ?? "").join("") ?? "";
    return { model, value: firstObject(text) };
  });
  if (openai) tries.push(async () => {
    // OpenAI, or anything that speaks its chat completions (Cloudflare
    // Workers AI's /ai/v1, Ollama's /v1): NIXAMP_OPENAI_URL is that base.
    const baseUrl = (aiKey("NIXAMP_OPENAI_URL", env) || "https://api.openai.com/v1").replace(/\/+$/, "");
    const official = new URL(baseUrl).host === "api.openai.com";
    const model = options.model || aiKey("NIXAMP_OPENAI_MODEL", env) || "gpt-4.1-mini";
    const response = await send(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${openai}` },
      body: JSON.stringify({
        model,
        // Workers AI stops at 256 tokens unless it is told more.
        max_tokens: options.maxTokens ?? 1024,
        // Not every compatible server knows json_object; the answer is read for its JSON either way.
        ...(official ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: options.system }, { role: "user", content: options.prompt }],
      }),
    });
    if (!response.ok) throw new Error(`${official ? "openai" : new URL(baseUrl).host} answered HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { model, value: firstObject(body.choices?.[0]?.message?.content ?? "") };
  });
  if (anthropic) tries.push(async () => {
    const model = env["NIXAMP_ANTHROPIC_MODEL"] || "claude-haiku-5-5";
    const response = await send("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { "content-type": "application/json", "x-api-key": anthropic, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 1024,
        system: `${options.system}\nAnswer with one JSON object and nothing else.`,
        messages: [{ role: "user", content: options.prompt }],
      }),
    });
    if (!response.ok) throw new Error(`anthropic answered HTTP ${response.status}`);
    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    return { model, value: firstObject(body.content?.filter((one) => one.type === "text").map((one) => one.text ?? "").join("") ?? "") };
  });
  if (tries.length === 0) throw new NoModel();
  const failures: string[] = [];
  for (const attempt of tries) {
    try {
      return await attempt();
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  throw new Error(failures.join("; "));
}
