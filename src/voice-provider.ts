import { SpeechError } from "./speech.ts";

/** Only fixed messages/codes leave this boundary: provider bodies can contain
 * account information. Authorization and billing errors must not be retried
 * as transient 502s by the live player. */
export async function voiceProviderFailure(response: Response): Promise<{ error: SpeechError; code: string; cooldownMs: number }> {
  let code = "unknown";
  try {
    const body = await response.json() as { detail?: { status?: unknown } };
    const status = body?.detail?.status;
    if (typeof status === "string" && ["quota_exceeded", "invalid_api_key", "missing_permissions", "subscription_required", "subscription_expired", "payment_required", "payment_issue", "too_many_concurrent_requests", "rate_limit_exceeded"].includes(status)) code = status;
  } catch { /* Non-JSON provider failures still have an HTTP status. */ }
  if (code === "quota_exceeded") return { code, cooldownMs: 300_000, error: new SpeechError("ElevenLabs credits are exhausted. The site owner needs to check the provider balance.", 402) };
  if (code === "payment_issue") return { code, cooldownMs: 300_000, error: new SpeechError("ElevenLabs blocked transcription because its subscription payment failed. The site owner needs to complete the outstanding ElevenLabs invoice.", 402) };
  if (["subscription_required", "subscription_expired", "payment_required"].includes(code) || response.status === 402) return { code, cooldownMs: 300_000, error: new SpeechError("ElevenLabs billing needs attention. The site owner needs to check the provider subscription.", 402) };
  if (["invalid_api_key", "missing_permissions"].includes(code) || [401, 403].includes(response.status)) return { code, cooldownMs: 300_000, error: new SpeechError("ElevenLabs rejected transcription or voice access. The site owner needs to check the provider key, permissions, and billing.", 424) };
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    return { code, cooldownMs: Math.min(300_000, Math.max(30_000, Number.isFinite(retry) ? retry * 1000 : 0)), error: new SpeechError("ElevenLabs is rate limited. Wait before enabling translated audio again.", 429) };
  }
  return { code, cooldownMs: 10_000, error: new SpeechError("ElevenLabs is temporarily unavailable. Try translated audio again shortly.", 502) };
}
