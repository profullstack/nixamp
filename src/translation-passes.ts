/** Account-bound, prepaid translation credit. Money is integer micro-USD;
 * each listening account reserves 5x base provider cost for paid access. */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./follows.ts";
import { SpeechError } from "./speech.ts";

export const TRANSLATION_MULTIPLIER = 5;
export const TRANSLATION_PLANS = [
  { id: "day", name: "Day", days: 1, priceCents: 500 },
  { id: "week", name: "Week", days: 7, priceCents: 2500 },
  { id: "month", name: "Month", days: 30, priceCents: 10000 },
] as const;
export type TranslationPlan = typeof TRANSLATION_PLANS[number];
export type TranslationUsage = "transcription" | "voice";
export interface TranslationMeter {
  require(by: string): Promise<void>;
  eligible?(accounts: string[]): Promise<string[]>;
  reserve(by: string, kind: TranslationUsage, units: number): Promise<string>;
  reserveMany?(accounts: string[], kind: TranslationUsage, units: number): Promise<{ by: string; id: string }[]>;
  commitMany?(ids: string[]): Promise<void>;
  refundMany?(ids: string[]): Promise<void>;
  commit(id: string): Promise<void>;
  refund(id: string): Promise<void>;
}
export interface TranslationAccess {
  required: boolean; available: boolean; balanceMicros: number; expires: string | null;
  plans: readonly TranslationPlan[]; coins: string[]; orders: { id: string; url: string; plan: string }[];
  rates: { transcriptionHour: number; voiceThousand: number; multiplier: number };
}
const COINS = ["USDC_POL", "USDC_SOL", "SOL", "POL", "BTC", "ETH", "USDC_ETH", "BCH", "DOGE"];
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DAY = 86_400_000;
const PAID = new Set(["confirmed", "forwarding", "forwarded", "forwarding_failed", "completed"]);

/** At the published rates: Scribe $0.22/submitted hour, Flash $0.05/1k chars.
 * Transcription units are 16 kHz samples; overlap is charged exactly as sent. */
export function translationCost(kind: TranslationUsage, units: number): { cost: number; charge: number } {
  if (!["voice", "transcription"].includes(kind) || !Number.isSafeInteger(units) || units < 1 || (kind === "voice" ? units > 600 : units > 241600)) throw new SpeechError("invalid translation usage", 400);
  const cost = Math.ceil(kind === "voice" ? units * 50 : units * 220_000 / 57_600_000);
  return { cost, charge: cost * TRANSLATION_MULTIPLIER };
}
function cents(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return -1;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2}0*)?$/.test(text)) return -1;
  const result = Math.round(Number(text) * 100);
  return Number.isSafeInteger(result) ? result : -1;
}
export function verifyTranslationPayment(payment: Record<string, unknown>, id: string, priceCents: number): boolean {
  return payment["id"] === id && PAID.has(String(payment["status"])) &&
    String(payment["currency"]).toUpperCase() === "USD" && cents(payment["amount"]) === priceCents;
}

export class TranslationPasses implements TranslationMeter {
  private schema: Promise<void> | null = null;
  private merchant: Promise<{ business: string; coins: string[] }> | null = null;
  private merchantUntil = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: { db: Queryable; key: string; site: string; fetcher?: typeof fetch; now?: () => number }) {
    this.fetcher = options.fetcher ?? fetch; this.now = options.now ?? Date.now;
  }
  private async ensure(): Promise<void> {
    this.schema ??= (async () => {
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS translation_wallets (
        by_account TEXT PRIMARY KEY, balance_micros BIGINT NOT NULL CHECK (balance_micros >= 0), expires_at TIMESTAMPTZ NOT NULL)`);
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS translation_orders (
        id TEXT PRIMARY KEY, by_account TEXT NOT NULL, request_key TEXT NOT NULL, plan TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents > 0), days INTEGER NOT NULL,
        business_id TEXT NOT NULL, coin TEXT NOT NULL, payment_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL,
        credited_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, UNIQUE(by_account, request_key))`);
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS translation_usage (
        id TEXT PRIMARY KEY, by_account TEXT NOT NULL, kind TEXT NOT NULL, units BIGINT NOT NULL,
        cost_micros BIGINT NOT NULL, charge_micros BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved',
        created_at TIMESTAMPTZ NOT NULL)`);
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS translation_checkout_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL)`);
      await this.options.db.query("CREATE INDEX IF NOT EXISTS translation_orders_account ON translation_orders (by_account, created_at)");
    })().catch(error => { this.schema = null; throw error; });
    await this.schema;
  }
  private async provider(path: string, init: RequestInit = {}): Promise<any> {
    if (!this.options.key) throw new SpeechError("Translation checkout is unavailable.", 503);
    const response = await this.fetcher(`https://coinpayportal.com${path}`, {
      ...init, signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${this.options.key}`, "content-type": "application/json", ...init.headers },
    });
    const body = await response.json();
    if (!response.ok || body.success !== true) throw new SpeechError("The payment service is unavailable. Your purchase has not been activated; retry to check its status.", 502);
    return body;
  }
  private async settings(): Promise<{ business: string; coins: string[] }> {
    if (!this.merchant || this.now() >= this.merchantUntil) {
      this.merchantUntil = this.now() + 600_000;
      this.merchant = this.provider("/api/supported-coins").then(body => {
        if (!ID.test(body.business_id)) throw new SpeechError("Translation checkout is unavailable.", 503);
        const coins = COINS.filter(symbol => body.coins?.some((coin: any) => coin.symbol === symbol && coin.is_active && coin.has_wallet));
        return { business: body.business_id as string, coins };
      }).catch(error => { this.merchant = null; throw error; });
    }
    return this.merchant;
  }
  async access(by?: string): Promise<TranslationAccess> {
    await this.ensure();
    const config = await this.settings().catch(() => ({ business: "", coins: [] as string[] }));
    const row = by ? (await this.options.db.query("SELECT balance_micros, expires_at FROM translation_wallets WHERE by_account = $1 AND expires_at > $2", [by, new Date(this.now())])).rows[0] : null;
    const orders = by ? (await this.options.db.query("SELECT id, payment_id, plan FROM translation_orders WHERE by_account = $1 AND status = 'pending' AND payment_id IS NOT NULL ORDER BY created_at DESC LIMIT 5", [by])).rows.map(order => ({ id: String(order["id"]), plan: String(order["plan"]), url: `https://coinpayportal.com/pay/${order["payment_id"]}` })) : [];
    return { required: true, available: config.coins.length > 0, balanceMicros: Number(row?.["balance_micros"] ?? 0),
      expires: row ? new Date(String(row["expires_at"])).toISOString() : null, plans: TRANSLATION_PLANS, coins: config.coins, orders,
      rates: { transcriptionHour: 0.22, voiceThousand: 0.05, multiplier: TRANSLATION_MULTIPLIER } };
  }
  async require(by: string): Promise<void> {
    await this.ensure();
    const found = await this.options.db.query("SELECT by_account FROM translation_wallets WHERE by_account = $1 AND expires_at > $2 AND balance_micros > 0", [by, new Date(this.now())]);
    if (!found.rows.length) throw new SpeechError("Buy a translation pass to enable translated audio.", 402);
  }
  async eligible(accounts: string[]): Promise<string[]> {
    await this.ensure();
    const result = await this.options.db.query("SELECT by_account FROM translation_wallets WHERE by_account = ANY($1::text[]) AND expires_at > $2 AND balance_micros > 0", [accounts, new Date(this.now())]);
    return result.rows.map(row => String(row["by_account"]));
  }
  async reserve(by: string, kind: TranslationUsage, units: number): Promise<string> {
    await this.ensure();
    const { cost, charge } = translationCost(kind, units), id = randomUUID();
    const result = await this.options.db.query(`WITH debit AS (
      UPDATE translation_wallets SET balance_micros = balance_micros - $2
      WHERE by_account = $1 AND expires_at > $3 AND balance_micros >= $2 RETURNING by_account)
      INSERT INTO translation_usage (id, by_account, kind, units, cost_micros, charge_micros, created_at)
      SELECT $4, by_account, $5, $6, $7, $2, $3 FROM debit RETURNING id`,
    [by, charge, new Date(this.now()), id, kind, units, cost]);
    if (!result.rows.length) throw new SpeechError("Your translation balance is used up or expired. Buy another pass to continue.", 402);
    return id;
  }
  /** Batch a shared stream's access charges in one database round trip. */
  async reserveMany(accounts: string[], kind: TranslationUsage, units: number): Promise<{ by: string; id: string }[]> {
    await this.ensure();
    const { cost, charge } = translationCost(kind, units);
    const result = await this.options.db.query(`WITH debit AS (
      UPDATE translation_wallets SET balance_micros = balance_micros - $2
      WHERE by_account = ANY($1::text[]) AND expires_at > $3 AND balance_micros >= $2 RETURNING by_account)
      INSERT INTO translation_usage (id, by_account, kind, units, cost_micros, charge_micros, created_at)
      SELECT gen_random_uuid()::text, by_account, $4, $5, $6, $2, $3 FROM debit RETURNING id, by_account`,
    [[...new Set(accounts)], charge, new Date(this.now()), kind, units, cost]);
    return result.rows.map(row => ({ by: String(row["by_account"]), id: String(row["id"]) }));
  }
  async commit(id: string): Promise<void> {
    await this.options.db.query("UPDATE translation_usage SET status = 'charged' WHERE id = $1 AND status = 'reserved'", [id]);
  }
  async refund(id: string): Promise<void> {
    await this.options.db.query(`WITH undone AS (
      UPDATE translation_usage SET status = 'refunded' WHERE id = $1 AND status = 'reserved'
      RETURNING by_account, charge_micros)
      UPDATE translation_wallets AS wallet SET balance_micros = wallet.balance_micros + undone.charge_micros
      FROM undone WHERE wallet.by_account = undone.by_account`, [id]);
  }
  async commitMany(ids: string[]): Promise<void> {
    await this.options.db.query("UPDATE translation_usage SET status = 'charged' WHERE id = ANY($1::text[]) AND status = 'reserved'", [ids]);
  }
  async refundMany(ids: string[]): Promise<void> {
    await this.options.db.query(`WITH undone AS (
      UPDATE translation_usage SET status = 'refunded' WHERE id = ANY($1::text[]) AND status = 'reserved'
      RETURNING by_account, charge_micros), totals AS (SELECT by_account, SUM(charge_micros) AS charge FROM undone GROUP BY by_account)
      UPDATE translation_wallets AS wallet SET balance_micros = wallet.balance_micros + totals.charge
      FROM totals WHERE wallet.by_account = totals.by_account`, [ids]);
  }
  async checkout(by: string, planId: string, coin: string, requestKey: string): Promise<{ id: string; url: string }> {
    await this.ensure();
    const plan = TRANSLATION_PLANS.find(plan => plan.id === planId);
    if (!plan || !ID.test(requestKey)) throw new SpeechError("Choose a translation pass.", 400);
    const config = await this.settings();
    if (!config.coins.includes(coin)) throw new SpeechError("Choose an available payment currency.", 400);
    // Durable caps across restarts/replicas protect the merchant's invoice quota.
    // Retrying an existing order does not consume another invoice allowance.
    const existing = await this.options.db.query("SELECT id FROM translation_orders WHERE by_account = $1 AND request_key = $2", [by, requestKey]);
    if (!existing.rows.length) {
      for (const [scope, limit] of [[`account:${by}`, 5], ["server", 50]] as const) {
        const limited = await this.options.db.query(`INSERT INTO translation_checkout_limits (bucket, attempts) VALUES ($1, 1)
          ON CONFLICT (bucket) DO UPDATE SET attempts = translation_checkout_limits.attempts + 1
          WHERE translation_checkout_limits.attempts < $2 RETURNING attempts`, [`${scope}:${Math.floor(this.now() / DAY)}`, limit]);
        if (!limited.rows.length) throw new SpeechError("Too many new checkouts today. Resume an existing purchase or try tomorrow.", 429);
      }
    }
    const id = randomUUID();
    await this.options.db.query(`INSERT INTO translation_orders (id, by_account, request_key, plan, price_cents, days, business_id, coin, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (by_account, request_key) DO NOTHING`,
    [id, by, requestKey, plan.id, plan.priceCents, plan.days, config.business, coin, new Date(this.now())]);
    const order = (await this.options.db.query("SELECT * FROM translation_orders WHERE by_account = $1 AND request_key = $2", [by, requestKey])).rows[0]!;
    if (order["plan"] !== plan.id || order["coin"] !== coin) throw new SpeechError("This checkout already belongs to a different pass. Start a new purchase.", 409);
    let paymentId = String(order["payment_id"] ?? "");
    if (!paymentId) {
      const created = await this.provider("/api/payments/create", {
        method: "POST", headers: { "idempotency-key": `nixamp-translation-${order["id"]}` },
        body: JSON.stringify({ business_id: order["business_id"], amount_usd: Number(order["price_cents"]) / 100,
          currency: coin.toLowerCase(), payment_method: "crypto", description: `Nixamp translated audio: ${plan.name} pass`,
          metadata: { app: "nixamp", product: "translation", order_id: order["id"] },
          redirect_url: `${this.options.site}/?translation_order=${order["id"]}` }),
      });
      paymentId = created.payment?.id;
      if (!ID.test(paymentId ?? "")) throw new SpeechError("Checkout did not return a valid payment. Retry this purchase.", 502);
      await this.options.db.query("UPDATE translation_orders SET payment_id = $2 WHERE id = $1 AND payment_id IS NULL", [order["id"], paymentId]);
    }
    return { id: String(order["id"]), url: `https://coinpayportal.com/pay/${paymentId}` };
  }
  async check(by: string, id: string): Promise<{ status: string; access: TranslationAccess }> {
    if (!ID.test(id)) throw new SpeechError("Purchase not found.", 404);
    await this.ensure();
    const order = (await this.options.db.query("SELECT * FROM translation_orders WHERE id = $1 AND by_account = $2", [id, by])).rows[0];
    if (!order) throw new SpeechError("Purchase not found.", 404);
    let status = String(order["status"]);
    if (["pending", "expired"].includes(status) && order["payment_id"]) {
      const result = await this.provider(`/api/payments/${encodeURIComponent(String(order["payment_id"]))}`);
      const payment = result.payment;
      if (payment && verifyTranslationPayment(payment, String(order["payment_id"]), Number(order["price_cents"]))) {
        const now = new Date(this.now()), expires = new Date(this.now() + Number(order["days"]) * DAY);
        // One statement atomically marks the order and adds credit. A retry,
        // second tab or second replica cannot activate the same money twice.
        await this.options.db.query(`WITH paid AS (
          UPDATE translation_orders SET status = 'paid', credited_at = $3, expires_at = $4
          WHERE id = $1 AND by_account = $2 AND status IN ('pending', 'expired') RETURNING by_account, price_cents)
          INSERT INTO translation_wallets (by_account, balance_micros, expires_at)
          SELECT by_account, price_cents::bigint * 10000, $4 FROM paid
          ON CONFLICT (by_account) DO UPDATE SET
            balance_micros = CASE WHEN translation_wallets.expires_at > $3 THEN translation_wallets.balance_micros ELSE 0 END + EXCLUDED.balance_micros,
            expires_at = GREATEST(translation_wallets.expires_at, EXCLUDED.expires_at)`, [id, by, now, expires]);
        status = "paid";
      } else if (payment && ["expired", "failed", "refunded"].includes(payment.status)) {
        status = payment.status;
        await this.options.db.query("UPDATE translation_orders SET status = $3 WHERE id = $1 AND by_account = $2 AND status = 'pending'", [id, by, status]);
      }
    }
    return { status, access: await this.access(by) };
  }
}
