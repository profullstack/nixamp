/**
 * Support a copyright holder: a payment through nixamp.com's own CoinPay
 * business, for the holders whose money that business may take.
 *
 * A station's now-playing card links a track's holder to their support page.
 * Holders who collect for themselves register their own link on the station
 * (`nixamp station holder set NAME --support URL`); this page is for the
 * holders nixamp.com collects for -- today Profullstack's own music (the
 * band Þrøngva, AI radio) -- named in NIXAMP_SUPPORT_HOLDERS ("id=Name,...").
 *
 * One payment on CoinPay's hosted checkout session: the payer picks any coin
 * nixamp's business takes, or PayPal, and the sale is filed under nixamp.com
 * with the payer's account id (their email when signed out) and email. CoinPay offers no
 * crypto subscription a business key can start (its plan/subscribe API is
 * Stripe's, which we do not use), so "monthly" is not offered rather than
 * pretended.
 */
import { createHash, randomUUID } from "node:crypto";

export interface SupportHolder { id: string; name: string }

export function supportHoldersFrom(env: Record<string, string | undefined> = process.env): SupportHolder[] {
  const raw = env["NIXAMP_SUPPORT_HOLDERS"] ?? "profullstack=Profullstack";
  return raw.split(",").map((one) => one.trim()).filter(Boolean).map((one) => {
    const [id, ...name] = one.split("=");
    return { id: (id ?? "").trim().toLowerCase(), name: name.join("=").trim() || (id ?? "").trim() };
  }).filter((one) => /^[a-z0-9-]{1,40}$/.test(one.id));
}

export const AMOUNTS = [3, 5, 10, 25, 50];
const MIN_USD = 1;
const MAX_USD = 1000;

const SESSION = /^cs_[A-Za-z0-9]{16,64}$/;
const COINPAY = "https://coinpayportal.com";

/** A CoinPay hosted checkout session id (cs_...), as stored where a payment id used to be. */
export function isSessionRef(ref: string): boolean {
  return SESSION.test(ref);
}

/** Where a payer finishes a stored payment: its hosted session, or an older one-coin invoice. */
export function payUrl(ref: string): string {
  return isSessionRef(ref) ? `${COINPAY}/checkout/${ref}` : `${COINPAY}/pay/${encodeURIComponent(ref)}`;
}

/** The site hostname every nixamp sale is filed under at CoinPay. */
export function propertyOf(site: string): string {
  try {
    return new URL(site).hostname.replace(/^www\./, "").toLowerCase() || "nixamp.com";
  } catch {
    return "nixamp.com";
  }
}

/** The coin a stored payment names: "ANY" for a hosted session, where the payer picks (or PayPal). */
export function coinOf(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_]{2,20}$/.test(value.trim()) ? value.trim().toUpperCase() : "ANY";
}

/** "in USDC_POL" for an older one-coin payment; nothing for a session. */
export function paidIn(coin: string): string {
  return coin && coin !== "ANY" ? ` in ${coin}` : "";
}

/** Who pays: CoinPay needs an email for the receipt; the account id defaults to it (a guest). */
export interface Payer { email?: unknown; accountId?: string | null }

export class SupportError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
  }
}

export class Support {
  private merchant: Promise<{ business: string; coins: string[] }> | null = null;
  private merchantUntil = 0;

  constructor(private readonly options: { key: string; site: string; holders: SupportHolder[]; fetcher?: typeof fetch; now?: () => number }) {}

  /** For a subscription's renewals, which ask CoinPay about their payments. */
  get key(): string {
    return this.options.key;
  }

  holder(id: string): SupportHolder | undefined {
    return this.options.holders.find((one) => one.id === id.toLowerCase());
  }

  get enabled(): boolean {
    return Boolean(this.options.key);
  }

  private async provider(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    if (!this.options.key) throw new SupportError("Support payments are not set up here.", 503, "unavailable");
    const response = await (this.options.fetcher ?? fetch)(`https://coinpayportal.com${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.options.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body["success"] !== true) throw new SupportError("The payment service did not answer; nothing was charged. Try again.", 502, "provider");
    return body;
  }

  /** The business and the coins it has a wallet for, asked at most every 10 minutes. */
  async coins(): Promise<{ business: string; coins: string[] }> {
    const now = this.options.now?.() ?? Date.now();
    if (!this.merchant || now >= this.merchantUntil) {
      this.merchantUntil = now + 600_000;
      this.merchant = this.provider("/api/supported-coins").then((body) => {
        const business = String(body["business_id"] ?? "");
        if (!/^[0-9a-f-]{36}$/.test(business)) throw new SupportError("Support payments are not set up here.", 503, "unavailable");
        const coins = (Array.isArray(body["coins"]) ? body["coins"] : [])
          .filter((coin): coin is { symbol: string; is_active: boolean; has_wallet: boolean } => typeof coin === "object" && coin !== null)
          .filter((coin) => coin.is_active && coin.has_wallet && typeof coin.symbol === "string")
          .map((coin) => coin.symbol);
        return { business, coins };
      }).catch((error: unknown) => { this.merchant = null; throw error; });
    }
    return this.merchant;
  }

  /** The POST /api/checkout/sessions body: what CoinPay files the sale under. */
  sessionBody(input: { amountUsd: number; description: string; metadata: Record<string, unknown>; redirect: string; cancel?: string; email: string; accountId: string }): Record<string, unknown> {
    return {
      amount: Math.max(0.01, Math.round(input.amountUsd * 100) / 100),
      currency: "USD",
      description: input.description.slice(0, 200),
      customer_email: input.email,
      account_id: input.accountId,
      property: propertyOf(this.options.site),
      metadata: { app: "nixamp", ...input.metadata },
      success_url: input.redirect,
      cancel_url: input.cancel ?? input.redirect,
      expires_in_minutes: 60,
    };
  }

  /** Open a CoinPay hosted checkout session; its id stands where a payment id used to. */
  private async session(input: { amountUsd: number; description: string; metadata: Record<string, unknown>; redirect: string; cancel?: string } & Payer): Promise<{ url: string; paymentId: string }> {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new SupportError("Give an email for the receipt.", 400, "invalid_email");
    const accountId = (typeof input.accountId === "string" && input.accountId.trim()) || email;
    const created = await this.provider("/api/checkout/sessions", {
      method: "POST",
      body: JSON.stringify(this.sessionBody({ ...input, email, accountId })),
    });
    const id = typeof created["id"] === "string" ? created["id"] : "";
    if (!SESSION.test(id)) throw new SupportError("The checkout did not start; nothing was charged. Try again.", 502, "provider");
    return { url: payUrl(id), paymentId: id };
  }

  /**
   * Any CoinPay checkout on nixamp's business (a purchase in the store): no
   * holder, no floor but a cent. A hosted session, so the payer picks any coin
   * or PayPal there; `coin` is what an older page still sends, and is ignored.
   */
  async pay(input: { amountUsd: number; coin?: unknown; description: string; metadata: Record<string, unknown>; redirect: string; order: string } & Payer): Promise<{ url: string; paymentId: string }> {
    return this.session({ ...input, metadata: { order: input.order, ...input.metadata } });
  }

  /**
   * Whether CoinPay counts this payment as paid; null when it did not answer.
   * A session (cs_...) is asked as a session: paid by any coin or PayPal.
   */
  async isPaid(paymentId: string): Promise<boolean | null> {
    if (isSessionRef(paymentId)) {
      try {
        const response = await (this.options.fetcher ?? fetch)(`${COINPAY}/api/checkout/sessions/${encodeURIComponent(paymentId)}`, {
          signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${this.options.key}` },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { session?: { id?: string; status?: string } };
        if (body.session?.id !== paymentId) return null;
        return body.session.status === "paid";
      } catch {
        return null;
      }
    }
    try {
      const response = await (this.options.fetcher ?? fetch)(`https://coinpayportal.com/api/payments/${encodeURIComponent(paymentId)}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.options.key}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { payment?: { status?: string } };
      return PAID.has(String(body.payment?.status ?? ""));
    } catch {
      return null;
    }
  }

  /** A CoinPay checkout for this much, to this holder; the address to send the payer to. */
  async checkout(input: { holder?: unknown; amountUsd?: unknown; coin?: unknown; station?: unknown; track?: unknown; metadata?: Record<string, unknown> } & Payer): Promise<{ url: string; paymentId: string }> {
    const holder = typeof input.holder === "string" ? this.holder(input.holder) : undefined;
    if (!holder) throw new SupportError("Nobody by that name is supported here.", 404, "not_found");
    const amount = Number(input.amountUsd);
    if (!Number.isFinite(amount) || amount < MIN_USD || amount > MAX_USD) throw new SupportError(`Choose an amount from $${MIN_USD} to $${MAX_USD}.`, 400, "invalid_amount");
    const clean = (value: unknown): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, 120) : "");
    const order = randomUUID();
    return this.session({
      amountUsd: amount,
      description: `Support ${holder.name} on nixamp`,
      metadata: { product: "support", holder: holder.id, order, station: clean(input.station), track: clean(input.track), ...(input.metadata ?? {}) },
      redirect: `${this.options.site}/support/${holder.id}?thanks=1`,
      cancel: `${this.options.site}/support/${holder.id}`,
      email: input.email,
      accountId: input.accountId ?? null,
    });
  }
}

const STYLE = `
:root{--bg:#080c09;--fg:#e8efe9;--muted:#9aa79d;--card:#0e1410;--line:#1f2a22;--accent:#3ddc84}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{margin:0 0 6px;font-size:1.5rem}p{color:var(--muted);margin:0 0 18px}
.amounts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.amounts button{flex:1 1 64px;padding:10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;font-weight:700;cursor:pointer}
.amounts button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
label{display:block;color:var(--muted);font-size:.9rem;margin:10px 0 4px}
input,select{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button.go{margin-top:18px;width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent);color:#06120a;font:inherit;font-weight:800;cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
#status{min-height:1.4em;margin-top:12px;color:var(--muted)}
.thanks{color:var(--accent);font-weight:700}
.often{display:flex;gap:8px;margin:0 0 14px}.often label{flex:1;margin:0;display:flex;gap:8px;align-items:center;justify-content:center;padding:10px;border:1px solid var(--line);border-radius:10px;color:var(--fg);cursor:pointer}
.often input{width:auto}
small{display:block;margin-top:18px;color:var(--muted)}small a{color:inherit}
`;

const SCRIPT = `
(async () => {
  const holder = location.pathname.split("/").filter(Boolean)[1] || "";
  const params = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  let amount = 5;
  for (const b of document.querySelectorAll(".amounts button")) {
    b.addEventListener("click", () => {
      amount = Number(b.dataset.usd);
      $("#other").value = "";
      for (const o of document.querySelectorAll(".amounts button")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  const monthly = () => document.querySelector("input[name=often]:checked").value === "monthly";
  for (const r of document.querySelectorAll("input[name=often]")) r.addEventListener("change", () => {
    $("#email-label").textContent = monthly() ? "Email, for the receipt and each month's payment link (and the cancel link)" : "Email, for the receipt";
    $("#go").textContent = monthly() ? "Pay the first month" : "Continue to payment";
  });
  if (params.get("thanks")) { $("#status").className = "thanks"; $("#status").textContent = "Thank you. Your payment is on its way."; }
  try {
    const info = await (await fetch("/api/v1/support/" + encodeURIComponent(holder), { cache: "no-store" })).json();
    if (info.name) { $("#who").textContent = info.name; document.title = "Support " + info.name + " · nixamp"; }
    if (info.error) { $("#go").disabled = true; $("#status").textContent = info.error; }
  } catch { $("#status").textContent = "Payments are not available right now."; }
  $("#form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const other = Number($("#other").value);
    const usd = other > 0 ? other : amount;
    $("#go").disabled = true;
    $("#status").textContent = "Starting the checkout…";
    try {
      const r = await fetch("/api/v1/support/" + encodeURIComponent(holder), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: usd, email: $("#email").value, station: params.get("station") || "", track: params.get("track") || "",
          ...(monthly() ? { monthly: true } : {}) }) });
      const body = await r.json();
      if (r.ok && body.url) { location.href = body.url; return; }
      $("#status").textContent = body.error || "That did not work.";
    } catch { $("#status").textContent = "Could not reach the payment service."; }
    $("#go").disabled = false;
  });
})();
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const SUPPORT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Support · nixamp</title>
<link rel="icon" href="/favicon.png">
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Support <span id="who">the artist</span></h1>
    <p>Pay the copyright holder of the music you are listening to, directly, through CoinPay: any coin, or PayPal. Once, or every month.</p>
    <form id="form">
      <div class="often"><label><input type="radio" name="often" value="once" checked> One time</label><label><input type="radio" name="often" value="monthly"> Monthly</label></div>
      <div class="amounts">${AMOUNTS.map((usd, at) => `<button type="button" data-usd="${usd}" aria-pressed="${at === 1}">$${usd}</button>`).join("")}</div>
      <label for="other">Or another amount (US$)</label>
      <input id="other" type="number" min="1" max="1000" step="1" inputmode="numeric">
      <label id="email-label" for="email">Email, for the receipt</label>
      <input id="email" type="email" autocomplete="email" maxlength="254" required>
      <button id="go" class="go" type="submit">Continue to payment</button>
      <div id="status" role="status" aria-live="polite"></div>
    </form>
    <small>Payments go through <a href="https://coinpayportal.com">CoinPay</a> to nixamp.com, which pays the holder. You pick the coin, or PayPal, on CoinPay's page. Monthly: each month we email a new payment link; nothing is taken until you pay it, and every email has a one-click cancel.</small>
  </div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

export const SUPPORT_CSP = [
  "default-src 'none'", `script-src ${hash(SCRIPT)}`, `style-src ${hash(STYLE)}`, "connect-src 'self'",
  "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

/** Postgres, as nixamp.com's pool offers it. */
export interface Db { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

/** What CoinPay calls a payment that has been made. */
const PAID = new Set(["confirmed", "forwarding", "forwarded", "forwarding_failed", "completed"]);
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;

/** One month on from a time, on the same day where the month has it. */
export function nextMonth(at: number): number {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

/**
 * Monthly support, run here rather than by CoinPay: CoinPay's only merchant
 * subscriptions are Stripe's, and its recurring invoices refuse a scoped key.
 * A subscription is an email, an amount, a coin and a holder. Month one is
 * paid at once on CoinPay's checkout; each month after, a new payment is made
 * and its link emailed, with a one-click cancel. A month left unpaid ends it
 * (lapsed) rather than emailing forever.
 */
export class SupportSubscriptions {
  private schema: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    db: Db;
    support: Support;
    /** Resend; null leaves renewals unsent (and says so in the log). */
    mail: { apiKey: string; from: string } | null;
    site: string;
    fetcher?: typeof fetch;
    now?: () => number;
    log?: (line: string) => void;
  }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ready(): Promise<void> {
    this.schema ??= (async () => {
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS support_subscriptions (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, holder TEXT NOT NULL, email TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, coin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        cycles INTEGER NOT NULL DEFAULT 0, last_payment_id TEXT, next_due TIMESTAMPTZ NOT NULL,
        station TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, canceled_at TIMESTAMPTZ)`);
      await this.options.db.query("CREATE INDEX IF NOT EXISTS support_subscriptions_due ON support_subscriptions (status, next_due)");
    })().catch((error: unknown) => { this.schema = null; throw error; });
    return this.schema;
  }

  /** Month one: a subscription and its first checkout. */
  async start(input: { holder?: unknown; amountUsd?: unknown; coin?: unknown; email?: unknown; station?: unknown; track?: unknown; accountId?: string | null }): Promise<{ url: string; id: string }> {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new SupportError("Give an email for the monthly payment links.", 400, "invalid_email");
    const holder = typeof input.holder === "string" ? this.options.support.holder(input.holder) : undefined;
    if (!holder) throw new SupportError("Nobody by that name is supported here.", 404, "not_found");
    await this.ready();
    const live = await this.options.db.query("SELECT count(*)::int AS n FROM support_subscriptions WHERE email = $1 AND status = 'active'", [email]);
    if (Number(live.rows[0]?.["n"] ?? 0) >= 10) throw new SupportError("That email already has ten monthly supports.", 409, "too_many");
    const id = randomUUID();
    const token = randomUUID().replace(/-/g, "");
    const checkout = await this.options.support.checkout({ ...input, email, holder: holder.id, metadata: { subscription: id, cycle: 1 } } as Parameters<Support["checkout"]>[0]);
    // The payer picks the coin (or PayPal) on CoinPay; an older page may still name one.
    const coin = (typeof input.coin === "string" && input.coin.trim() ? input.coin : "ANY").toUpperCase();
    const paidWith = coin === "ANY" ? "" : ` in ${coin}`;
    const now = this.now();
    await this.options.db.query(`INSERT INTO support_subscriptions (id, token, holder, email, amount_cents, coin, cycles, last_payment_id, next_due, station, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)`,
    [id, token, holder.id, email, Math.round(Number(input.amountUsd) * 100), coin, checkout.paymentId, new Date(nextMonth(now)), typeof input.station === "string" ? input.station.slice(0, 20) : "", new Date(now)]);
    await this.mail(email, `Your monthly support for ${holder.name}`, [
      `Thank you for supporting ${holder.name} on nixamp, $${Number(input.amountUsd).toFixed(2)} a month${paidWith}.`,
      `This month: ${checkout.url}`,
      `Each month we email you a new payment link like this one. Nothing is taken without you paying it.`,
      `Stop at any time: ${this.cancelLink(id, token)}`,
    ]);
    return { url: checkout.url, id };
  }

  cancelLink(id: string, token: string): string {
    return `${this.options.site}/support/cancel?s=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
  }

  async cancel(id: string, token: string): Promise<{ canceled: boolean; holder: string }> {
    await this.ready();
    const found = await this.options.db.query("UPDATE support_subscriptions SET status = 'canceled', canceled_at = $3 WHERE id = $1 AND token = $2 AND status <> 'canceled' RETURNING holder", [id, token, new Date(this.now())]);
    const row = found.rows[0];
    if (!row) {
      const known = await this.options.db.query("SELECT holder FROM support_subscriptions WHERE id = $1 AND token = $2", [id, token]);
      if (!known.rows[0]) throw new SupportError("That cancel link is not one of ours.", 404, "not_found");
      return { canceled: true, holder: String(known.rows[0]["holder"]) };
    }
    return { canceled: true, holder: String(row["holder"]) };
  }

  private async paid(paymentId: string): Promise<boolean | null> {
    // A session (cs_...) or an older one-coin payment, asked the same way checkouts are.
    return this.options.support.isPaid(paymentId);
  }

  /** Every subscription now due: a new month's payment and its link, or lapsed when last month went unpaid. */
  async renew(): Promise<{ renewed: number; lapsed: number }> {
    await this.ready();
    const due = await this.options.db.query("SELECT * FROM support_subscriptions WHERE status = 'active' AND next_due <= $1 ORDER BY next_due LIMIT 200", [new Date(this.now())]);
    let renewed = 0;
    let lapsed = 0;
    for (const row of due.rows) {
      const id = String(row["id"]);
      const last = String(row["last_payment_id"] ?? "");
      const paid = last ? await this.paid(last) : false;
      if (paid === null) continue; // CoinPay did not answer: ask again next time.
      const holder = this.options.support.holder(String(row["holder"]));
      if (!paid || !holder) {
        await this.options.db.query("UPDATE support_subscriptions SET status = 'lapsed' WHERE id = $1 AND status = 'active'", [id]);
        lapsed += 1;
        if (holder) await this.mail(String(row["email"]), `Your monthly support for ${holder.name} has stopped`, [
          `Last month's payment was not made, so we have stopped sending payment links. Nothing more will be asked.`,
          `Start again any time: ${this.options.site}/support/${holder.id}`,
        ]);
        continue;
      }
      const amountUsd = Number(row["amount_cents"]) / 100;
      const cycle = Number(row["cycles"]) + 1;
      let checkout: { url: string; paymentId: string };
      try {
        checkout = await this.options.support.checkout({ holder: holder.id, amountUsd, email: String(row["email"]), station: String(row["station"] ?? ""), metadata: { subscription: id, cycle } } as Parameters<Support["checkout"]>[0]);
      } catch (error) {
        this.options.log?.(`  support: renewal ${id} could not start a payment: ${(error as Error).message}`);
        continue;
      }
      await this.options.db.query("UPDATE support_subscriptions SET cycles = $2, last_payment_id = $3, next_due = $4 WHERE id = $1", [id, cycle, checkout.paymentId, new Date(nextMonth(new Date(String(row["next_due"])).getTime()))]);
      await this.mail(String(row["email"]), `This month's support for ${holder.name}`, [
        `Your monthly support for ${holder.name}: $${amountUsd.toFixed(2)}, in any coin or PayPal.`,
        `Pay this month: ${checkout.url}`,
        `Stop at any time: ${this.cancelLink(id, String(row["token"]))}`,
      ]);
      renewed += 1;
    }
    return { renewed, lapsed };
  }

  startSchedule(everyMs = 3600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.renew().catch((error: unknown) => this.options.log?.(`  support: renewals failed: ${(error as Error).message}`)), everyMs);
    this.timer.unref?.();
  }

  private async mail(to: string, subject: string, lines: string[]): Promise<void> {
    if (!this.options.mail) {
      this.options.log?.(`  support: no RESEND_API_KEY, so "${subject}" to ${to} was not sent`);
      return;
    }
    try {
      await (this.options.fetcher ?? fetch)("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.options.mail.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.options.mail.from, to: [to], subject, text: `${lines.join("\n\n")}\n\nnixamp.com` }),
      });
    } catch (error) {
      this.options.log?.(`  support: mail to ${to} failed: ${(error as Error).message}`);
    }
  }
}
