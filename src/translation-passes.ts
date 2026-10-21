/**
 * Prepaid AI credit, from @profullstack/live-translate, sold as nixamp.
 *
 * Every AI feature on nixamp.com is pay as you go out of this one wallet: a
 * pass adds dollars, each use takes what it costs times the multiplier, and a
 * use that fails is refunded. There is no free allowance. The one exception is
 * the site's admin (NIXAMP_OWNER), whose own use is never charged.
 */
import { TranslationPasses as Base, TRANSLATION_MULTIPLIER, type TranslationAccess, type TranslationUsage } from "@profullstack/live-translate";
import { randomUUID } from "node:crypto";
import { SpeechError } from "./speech.ts";
export { TRANSLATION_MULTIPLIER, TRANSLATION_PLANS, translationCost, verifyTranslationPayment, coinpayKeyFrom, verifyCoinpaySignature, readCoinpayWebhook,
  type TranslationPlan, type TranslationUsage, type TranslationMeter, type TranslationAccess } from "@profullstack/live-translate";

type Queryable = ConstructorParameters<typeof Base>[0]["db"];

/** The AI work billed here beyond translated audio, and what one unit costs nixamp.com in dollars. */
export type AiKind = "video" | "lipsync" | "phone_voice" | "transcription_local" | "translation_local";
const number = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
export const AI_RATES: Readonly<Record<AiKind, { usd: number; per: string }>> = {
  // Veo 3.1 Fast and fal.ai lip sync, per second of video: what veo-studio.ts already budgets with.
  video: { usd: number("NIXAMP_VEO_USD_PER_SECOND", 0.15), per: "second" },
  lipsync: { usd: number("NIXAMP_LIPSYNC_USD_PER_SECOND", 0.1), per: "second" },
  // A chat line read aloud on the party line: the ElevenLabs Flash rate, per character.
  phone_voice: { usd: 0.05 / 1000, per: "character" },
  // Whisper and OPUS-MT run on nixamp.com's own machine; priced like the hosted kind they replace.
  transcription_local: { usd: 0.22 / 3600, per: "second" },
  translation_local: { usd: number("NIXAMP_TRANSLATE_USD_PER_1K", 0.01) / 1000, per: "character" },
};

/** A charge taken before AI work runs: kept when the work is done, given back when it fails. */
export interface AiCharge {
  commit(): Promise<void>;
  refund(): Promise<void>;
}
const FREE: AiCharge = { commit: async () => {}, refund: async () => {} };

export const ADMIN_USE = "admin:";

export class TranslationPasses extends Base {
  private readonly admins: ReadonlySet<string>;
  private readonly db: Queryable;
  private readonly clock: () => number;

  constructor(options: ConstructorParameters<typeof Base>[0] & { admins?: string[] }) {
    const { admins = [], ...rest } = options;
    super({ app: "nixamp", label: "Nixamp AI credit", ...rest });
    this.admins = new Set(admins.filter(Boolean));
    this.db = rest.db;
    this.clock = rest.now ?? Date.now;
  }

  isAdmin(by: string | undefined): boolean {
    return Boolean(by) && this.admins.has(by!);
  }

  private async tables(): Promise<void> {
    await (this as unknown as { ensure(): Promise<void> }).ensure();
  }

  override async access(by?: string): Promise<TranslationAccess> {
    const access = await super.access(by);
    // No free sessions: the page offers credit, never "start a free session".
    const free = { ...access.free, limit: 0, remaining: 0, activeUntil: null };
    return this.isAdmin(by) ? { ...access, required: false, free } : { ...access, free };
  }

  override async begin(by: string, resource: string): Promise<void> {
    await this.require(by, resource);
  }

  override async require(by: string, _resource = ""): Promise<void> {
    if (this.isAdmin(by)) return;
    await this.tables();
    const found = await this.db.query("SELECT 1 FROM translation_wallets WHERE by_account = $1 AND expires_at > $2 AND balance_micros > 0", [by, new Date(this.clock())]);
    if (!found.rows.length) throw new SpeechError("Buy AI credit: AI on nixamp is pay as you go.", 402);
  }

  override async eligible(accounts: string[], _resource = ""): Promise<string[]> {
    await this.tables();
    const result = await this.db.query("SELECT by_account FROM translation_wallets WHERE by_account = ANY($1::text[]) AND expires_at > $2 AND balance_micros > 0", [accounts, new Date(this.clock())]);
    return [...new Set([...accounts.filter((one) => this.isAdmin(one)), ...result.rows.map((row) => String(row["by_account"]))])];
  }

  override async reserve(by: string, kind: TranslationUsage, units: number, _resource = ""): Promise<string> {
    const [taken] = await this.reserveMany([by], kind, units);
    if (!taken) throw new SpeechError("Buy AI credit: yours is used up.", 402);
    return taken.id;
  }

  override async reserveMany(accounts: string[], kind: TranslationUsage, units: number, _resource = ""): Promise<{ by: string; id: string }[]> {
    const admins = accounts.filter((one) => this.isAdmin(one)).map((by) => ({ by, id: `${ADMIN_USE}${randomUUID()}` }));
    const paying = accounts.filter((one) => !this.isAdmin(one));
    // No resource: the package's free-session lookup keys on it, and there are no free sessions here.
    return [...admins, ...(paying.length ? await super.reserveMany(paying, kind, units, "") : [])];
  }

  override async commit(id: string): Promise<void> {
    if (!id.startsWith(ADMIN_USE)) await super.commit(id);
  }

  override async refund(id: string): Promise<void> {
    if (!id.startsWith(ADMIN_USE)) await super.refund(id);
  }

  override async commitMany(ids: string[]): Promise<void> {
    const paid = ids.filter((id) => !id.startsWith(ADMIN_USE));
    if (paid.length) await super.commitMany(paid);
  }

  override async refundMany(ids: string[]): Promise<void> {
    const paid = ids.filter((id) => !id.startsWith(ADMIN_USE));
    if (paid.length) await super.refundMany(paid);
  }

  /** What `units` of `kind` cost, and what is charged for them, in micro-dollars. */
  static price(kind: AiKind, units: number): { cost: number; charge: number } {
    const cost = Math.max(1, Math.ceil(AI_RATES[kind].usd * units * 1_000_000));
    return { cost, charge: cost * TRANSLATION_MULTIPLIER };
  }

  /**
   * Take the price of some AI work from `by`'s credit before it runs, in one
   * statement, so two tabs cannot both spend the last cent. A 402 when there
   * is not enough. The admin is never charged.
   */
  async pay(by: string, kind: AiKind, units: number): Promise<AiCharge> {
    if (this.isAdmin(by)) return FREE;
    if (!by) throw new SpeechError("Sign in to use AI on nixamp.", 401);
    if (!Number.isFinite(units) || units <= 0) return FREE;
    await this.tables();
    const { cost, charge } = TranslationPasses.price(kind, Math.ceil(units));
    const now = new Date(this.clock());
    const result = await this.db.query(`WITH debit AS (
      UPDATE translation_wallets SET balance_micros = balance_micros - $2
      WHERE by_account = $1 AND expires_at > $3 AND balance_micros >= $2 RETURNING by_account)
      INSERT INTO translation_usage (id, by_account, kind, units, cost_micros, charge_micros, created_at)
      SELECT gen_random_uuid()::text, by_account, $4, $5, $6, $2, $3 FROM debit RETURNING id`,
    [by, charge, now, kind, Math.ceil(units), cost]);
    const id = result.rows[0]?.["id"];
    if (!id) throw new SpeechError(`Buy AI credit: AI on nixamp is pay as you go, and this costs $${(charge / 1_000_000).toFixed(4)}.`, 402);
    return { commit: () => super.commit(String(id)), refund: () => super.refund(String(id)) };
  }

  /** Pay, do the work, and keep the charge only if the work succeeded. */
  async spend<T>(by: string, kind: AiKind, units: number, work: () => Promise<T>): Promise<T> {
    const charge = await this.pay(by, kind, units);
    try {
      const done = await work();
      await charge.commit();
      return done;
    } catch (error) {
      await charge.refund().catch(() => undefined);
      throw error;
    }
  }
}
