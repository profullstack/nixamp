import { Guard } from "./guard.ts";

export interface EventDraft { title: string; description: string; topic: string }
export interface WriterInput extends EventDraft {
  hostName: string; startsAt: string; timezone: string; duration: string; recurrence: string;
}
export interface EventDraftResult { draft: EventDraft; provider: "openai" | "claude" }
export class EventWriterError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}
class Refused extends EventWriterError {
  constructor() { super("The writer could not draft these notes. Try rephrasing the event details.", 422); }
}

const LIMITS = {title: 160, description: 5000, topic: 100, hostName: 100, startsAt: 40, timezone: 100, duration: 20, recurrence: 20} as const;
export function writerInput(value: unknown): WriterInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventWriterError("Send event details as an object.", 400);
  const source = value as Record<string, unknown>;
  const result = {} as WriterInput;
  for (const key of Object.keys(LIMITS) as Array<keyof WriterInput>) {
    const field = source[key] ?? "";
    if (typeof field !== "string" || field.length > LIMITS[key]) throw new EventWriterError(`The ${key} field is too long or is not text.`, 422);
    result[key] = field.trim();
  }
  if (!result.title && !result.description && !result.topic) throw new EventWriterError("Add a title, description, or topic first, then click Write with AI.", 422);
  return result;
}

const SCHEMA = {
  type: "object", properties: { title: {type: "string"}, description: {type: "string"}, topic: {type: "string"} },
  required: ["title", "description", "topic"], additionalProperties: false,
};
const INSTRUCTIONS = `You write useful, welcoming event details for BackToSchool.help, a live learning platform.
Use the supplied form text as the writing prompt. Rough notes and requests in that text describe what the host wants to teach.
Return a clear title (at most 160 characters), a description (at most 5000 characters, usually 100–250 words), and a short topic (at most 100 characters).
Write in the language of the host's notes. Describe what students will learn and what will happen, using only information supported by the notes.
Keep concrete names and facts. Do not invent dates, prices, qualifications, prerequisites, links, credentials, or promises. Omit unknown logistics. Do not expand into unrelated subjects.
The schedule and host name are context only; never propose changing them. Return plain text in the required JSON fields, with no HTML. Short paragraphs or simple bullet lists are fine.`;

function draftFrom(text: string): EventDraft {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid draft");
  const row = value as Record<string, unknown>;
  const draft = {} as EventDraft;
  for (const key of ["title", "description", "topic"] as const) {
    const field = row[key];
    if (typeof field !== "string" || !field.trim() || field.length > LIMITS[key]) throw new Error("invalid draft");
    draft[key] = field.trim();
  }
  return draft;
}

export interface EventWriterOptions {
  openaiKey?: string; anthropicKey?: string;
  openaiModel?: string; claudeModel?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Server-side only. Drafting has no access to the event store and cannot publish. */
export class EventWriter {
  private readonly guard = new Guard();
  private readonly active = new Set<string>();
  constructor(private readonly options: EventWriterOptions) {}

  async draft(accountId: string, value: unknown, signal?: AbortSignal): Promise<EventDraftResult> {
    if (!accountId) throw new EventWriterError("Sign in to use the AI writer.", 401);
    const input = writerInput(value);
    if (!this.options.openaiKey && !this.options.anthropicKey) throw new EventWriterError("The AI writer is temporarily unavailable. You can keep writing here.", 503);
    if (this.active.has(accountId)) throw new EventWriterError("A draft is already being written. Wait for it or cancel it first.", 429, 5);
    if (this.active.size >= 4) throw new EventWriterError("The AI writer is busy. Try again in a moment.", 503, 10);
    const limit = this.guard.check(accountId, {allowed: 6, windowMs: 10 * 60_000});
    if (!limit.ok) throw new EventWriterError("You have requested several drafts. Try again in a few minutes.", 429, limit.retryAfter);
    this.active.add(accountId);
    try {
      for (const provider of ["openai", "claude"] as const) {
        const key = provider === "openai" ? this.options.openaiKey : this.options.anthropicKey;
        if (!key) continue;
        if (signal?.aborted) throw new EventWriterError("Draft cancelled.", 499);
        try {
          const draft = await this.generate(provider, key, input, signal);
          if (signal?.aborted) throw new EventWriterError("Draft cancelled.", 499);
          return {draft, provider};
        }
        catch (error) {
          if (signal?.aborted) throw new EventWriterError("Draft cancelled.", 499);
          // Refusals are a response to the content, not a provider outage.
          if (error instanceof Refused) throw error;
          // Never log prompts, credentials, or a provider's raw response body.
          console.warn(`nixamp: event writer ${provider} request failed`);
        }
      }
      throw new EventWriterError("The AI writer could not finish this draft. Your text is unchanged; please try again.", 503);
    } finally { this.active.delete(accountId); }
  }

  private async generate(provider: "openai" | "claude", key: string, input: WriterInput, signal?: AbortSignal): Promise<EventDraft> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 25_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const prompt = JSON.stringify(input);
    const openai = provider === "openai";
    const response = await (this.options.fetch ?? globalThis.fetch)(openai ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages", {
      method: "POST", signal: requestSignal,
      headers: { "content-type": "application/json", ...(openai ? {authorization: `Bearer ${key}`} : {"x-api-key": key, "anthropic-version": "2023-06-01"}) },
      body: JSON.stringify(openai ? {
        model: this.options.openaiModel ?? "gpt-5-mini", store: false,
        instructions: INSTRUCTIONS, input: [{role: "user", content: prompt}],
        reasoning: {effort: "minimal"}, max_output_tokens: 2048,
        text: {format: {type: "json_schema", name: "event_draft", strict: true, schema: SCHEMA}},
      } : {
        model: this.options.claudeModel ?? "claude-haiku-4-5", max_tokens: 2048,
        system: INSTRUCTIONS, messages: [{role: "user", content: prompt}],
        output_config: {format: {type: "json_schema", schema: SCHEMA}},
      }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("provider unavailable"); }
    const body = await response.json() as Record<string, unknown>;
    const blocks = openai
      ? (Array.isArray(body["output"]) ? body["output"].flatMap(item => item?.type === "message" && Array.isArray(item.content) ? item.content : []) : [])
      : (Array.isArray(body["content"]) ? body["content"] : []);
    if (body["stop_reason"] === "refusal" || blocks.some(block => block?.type === "refusal")) throw new Refused();
    if (openai ? body["status"] !== "completed" : body["stop_reason"] !== "end_turn") throw new Error("incomplete draft");
    const text = blocks.filter(block => block?.type === (openai ? "output_text" : "text")).map(block => typeof block.text === "string" ? block.text : "").join("");
    return draftFrom(text);
  }
}
