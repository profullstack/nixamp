/**
 * Veo clips for the AI label's music videos, made on nixamp.com.
 *
 * A label server asks for a shot (a prompt, its length, up to three member
 * portraits as reference images) and gets back an MP4. Google's Veo 3.1 Fast
 * makes it; nixamp.com keeps the month's spend under a cap in dollars
 * (NIXAMP_VEO_MONTHLY_USD, $50 by default), counting every second at a
 * deliberately high rate (NIXAMP_VEO_USD_PER_SECOND, $0.15) so the cap holds
 * whatever Google's price is today. A shot is reserved before it is asked for
 * and given back when Google makes nothing (a refusal, a filter, a timeout).
 *
 * The key is NIXAMP_VEO_API_KEY, its own name, so nothing else on nixamp.com
 * starts spending Gemini credit because a Gemini key appeared.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class VeoBudgetError extends Error {}
export class VeoRefused extends Error {}

export interface VeoStudioOptions {
  key: string;
  file: string;
  monthlyUsd?: number;
  usdPerSecond?: number;
  model?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export class VeoStudio {
  private spent: Record<string, number> = {};

  constructor(private readonly options: VeoStudioOptions) {
    try {
      this.spent = (JSON.parse(readFileSync(options.file, "utf8")) as { spent?: Record<string, number> }).spent ?? {};
    } catch {
      this.spent = {};
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `veo-${port}.json`);
  }

  private month(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString().slice(0, 7);
  }

  private get cap(): number { return this.options.monthlyUsd ?? 50; }
  private get rate(): number { return this.options.usdPerSecond ?? 0.15; }

  private save(): void {
    mkdirSync(dirname(this.options.file), { recursive: true });
    const temporary = `${this.options.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, spent: this.spent }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.options.file);
  }

  status(): { month: string; spentUsd: number; capUsd: number; leftUsd: number; usdPerSecond: number; secondsLeft: number } {
    const spent = this.spent[this.month()] ?? 0;
    const left = Math.max(0, this.cap - spent);
    return { month: this.month(), spentUsd: Math.round(spent * 100) / 100, capUsd: this.cap, leftUsd: Math.round(left * 100) / 100, usdPerSecond: this.rate, secondsLeft: Math.floor(left / this.rate) };
  }

  /** One shot: 4, 6 or 8 seconds, 16:9, with up to three reference images (JPEG). */
  async clip(input: { prompt: string; seconds: number; references: Buffer[] }): Promise<Buffer> {
    const seconds = [4, 6, 8].includes(input.seconds) ? input.seconds : 8;
    const cost = seconds * this.rate;
    const month = this.month();
    if ((this.spent[month] ?? 0) + cost > this.cap + 1e-9) throw new VeoBudgetError(`this month's $${this.cap} of Veo is spent`);
    // Reserved first, so two at once cannot both squeeze under the cap.
    this.spent[month] = (this.spent[month] ?? 0) + cost;
    this.save();
    try {
      return await this.make(input.prompt, seconds, input.references.slice(0, 3));
    } catch (error) {
      this.spent[month] = Math.max(0, (this.spent[month] ?? 0) - cost);
      this.save();
      throw error;
    }
  }

  private async make(prompt: string, seconds: number, references: Buffer[]): Promise<Buffer> {
    const send = this.options.fetcher ?? fetch;
    const headers = { "x-goog-api-key": this.options.key, "content-type": "application/json" };
    const model = this.options.model ?? "veo-3.1-fast-generate-preview";
    const started = await send(`${BASE}/models/${model}:predictLongRunning`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        instances: [{
          prompt: prompt.slice(0, 1800),
          ...(references.length ? { referenceImages: references.map((bytes) => ({ image: { bytesBase64Encoded: bytes.toString("base64"), mimeType: "image/jpeg" }, referenceType: "asset" })) } : {}),
        }],
        parameters: { aspectRatio: "16:9", durationSeconds: seconds },
      }),
    });
    const operation = await started.json().catch(() => ({})) as { name?: string; error?: { message?: string } };
    if (!started.ok || !operation.name) throw new VeoRefused(`Veo refused the shot: ${operation.error?.message?.slice(0, 200) ?? `HTTP ${started.status}`}`);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
    for (let tries = 0; tries < 60; tries++) {
      await sleep(10_000);
      const state = await (await send(`${BASE}/${operation.name}`, { headers, signal: AbortSignal.timeout(30_000) })).json().catch(() => ({})) as {
        done?: boolean; error?: { message?: string };
        response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }>; raiMediaFilteredReasons?: string[] } };
      };
      if (!state.done) continue;
      if (state.error) throw new VeoRefused(`Veo failed: ${state.error.message?.slice(0, 200) ?? "no reason"}`);
      const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new VeoRefused(`Veo made nothing: ${state.response?.generateVideoResponse?.raiMediaFilteredReasons?.[0]?.slice(0, 200) ?? "no sample"}`);
      const video = await send(uri, { headers: { "x-goog-api-key": this.options.key }, signal: AbortSignal.timeout(120_000) });
      const bytes = Buffer.from(await video.arrayBuffer());
      if (!video.ok || bytes.length < 10_000) throw new VeoRefused(`the Veo clip did not download (HTTP ${video.status})`);
      return bytes;
    }
    throw new VeoRefused("Veo took too long (10 minutes)");
  }
}
