/**
 * One question to a language model, one JSON answer.
 *
 * AI radio asks for small things: a title and a prompt for the next track, a
 * genre and a verdict for a shared file. Whichever model has a key answers --
 * Gemini, then OpenAI, then Anthropic -- and when none has, the caller is told
 * so and does without (a rule of its own, or a person). The answer is parsed
 * and handed back as an object; a model that rambles round its JSON is read
 * for the first object in what it said.
 */
import { aiKey } from "./ai-keys.ts";

export interface AskOptions {
  /** What the model is for, said once. */
  system: string;
  /** The question, with what it should answer from. */
  prompt: string;
  /** Milliseconds before giving up (default 30 s). */
  timeoutMs?: number;
  /** The longest answer, in tokens (default 1024): a song's words need more than a title does. */
  maxTokens?: number;
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
    super("no language model key is set (GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY)");
  }
}

/** The first JSON object in a model's answer. */
export function firstObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
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

/** Whether any model can be asked. */
export function hasModel(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(aiKey("GEMINI_API_KEY", env) || aiKey("OPENAI_API_KEY", env) || aiKey("ANTHROPIC_API_KEY", env));
}

export async function askJson(options: AskOptions): Promise<Answer> {
  const env = options.env ?? process.env;
  const send = options.fetcher ?? fetch;
  const gemini = aiKey("GEMINI_API_KEY", env);
  const openai = aiKey("OPENAI_API_KEY", env);
  const anthropic = aiKey("ANTHROPIC_API_KEY", env);
  // Each model with a key, in turn: one that refuses this server (Gemini
  // answers 400 "User location is not supported" from some networks) or is
  // down is not a reason to go without when another can answer.
  const tries: Array<() => Promise<Answer>> = [];
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
    const model = aiKey("NIXAMP_OPENAI_MODEL", env) || "gpt-4.1-mini";
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
