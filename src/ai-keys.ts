/**
 * The keys AI radio uses, and where they come from.
 *
 * The environment first, as everywhere else; then `ai.json` beside the
 * server's own keys (0600), which `nixamp station ai key NAME` fills from
 * stdin so a daemon restarted by `nixamp update` still has them. A key is
 * never shown back: the owner view says which ones are set, not what they are.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./daemon.ts";

export const AI_KEY_NAMES = [
  "ELEVENLABS_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  // Any OpenAI-compatible endpoint in OpenAI's place (Cloudflare Workers AI, Ollama, ...) and its model.
  "NIXAMP_OPENAI_URL", "NIXAMP_OPENAI_MODEL",
  // Which ElevenLabs music model composes: music_v1, music_v2 or music_v2_5 (the default).
  "NIXAMP_MUSIC_MODEL",
  // nichedb.dev's key for publishing our own songs' words (lyrics-publish.ts).
  "NIXAMP_LYRICS_KEY",
] as const;
export type AiKeyName = (typeof AI_KEY_NAMES)[number];

export function aiKeysFile(): string {
  return join(stateDir(), "ai.json");
}

function saved(file = aiKeysFile()): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  } catch {
    return {};
  }
}

/** The key, from the environment or ai.json; "" when neither has it. */
export function aiKey(name: AiKeyName, env: Record<string, string | undefined> = process.env, file = aiKeysFile()): string {
  return (env[name] ?? "").trim() || (saved(file)[name] ?? "").trim();
}

/** Which keys are set, never their values. */
export function aiKeysSet(env: Record<string, string | undefined> = process.env, file = aiKeysFile()): Record<AiKeyName, boolean> {
  return Object.fromEntries(AI_KEY_NAMES.map((name) => [name, aiKey(name, env, file) !== ""])) as Record<AiKeyName, boolean>;
}

/** Keep (or with "" forget) a key in ai.json. */
export function saveAiKey(name: AiKeyName, value: string, file = aiKeysFile()): void {
  const next = saved(file);
  if (value.trim()) next[name] = value.trim();
  else delete next[name];
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
