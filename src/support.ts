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
 * One payment, in crypto, on CoinPay's hosted checkout. CoinPay offers no
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

export class SupportError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
  }
}

export class Support {
  private merchant: Promise<{ business: string; coins: string[] }> | null = null;
  private merchantUntil = 0;

  constructor(private readonly options: { key: string; site: string; holders: SupportHolder[]; fetcher?: typeof fetch; now?: () => number }) {}

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

  /** A CoinPay checkout for this much, to this holder; the address to send the payer to. */
  async checkout(input: { holder?: unknown; amountUsd?: unknown; coin?: unknown; station?: unknown; track?: unknown }): Promise<{ url: string }> {
    const holder = typeof input.holder === "string" ? this.holder(input.holder) : undefined;
    if (!holder) throw new SupportError("Nobody by that name is supported here.", 404, "not_found");
    const amount = Number(input.amountUsd);
    if (!Number.isFinite(amount) || amount < MIN_USD || amount > MAX_USD) throw new SupportError(`Choose an amount from $${MIN_USD} to $${MAX_USD}.`, 400, "invalid_amount");
    const { business, coins } = await this.coins();
    const coin = typeof input.coin === "string" ? input.coin.toUpperCase() : "";
    if (!coins.includes(coin)) throw new SupportError(`Pay with one of: ${coins.join(", ")}.`, 400, "invalid_coin");
    const clean = (value: unknown): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, 120) : "");
    const order = randomUUID();
    const created = await this.provider("/api/payments/create", {
      method: "POST",
      headers: { "idempotency-key": `nixamp-support-${order}` },
      body: JSON.stringify({
        business_id: business,
        amount_usd: Math.round(amount * 100) / 100,
        currency: coin.toLowerCase(),
        payment_method: "crypto",
        description: `Support ${holder.name} on nixamp`,
        metadata: { app: "nixamp", product: "support", holder: holder.id, order, station: clean(input.station), track: clean(input.track) },
        redirect_url: `${this.options.site}/support/${holder.id}?thanks=1`,
      }),
    });
    const payment = created["payment"] as { id?: unknown } | undefined;
    const id = typeof payment?.id === "string" ? payment.id : "";
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new SupportError("The checkout did not start; nothing was charged. Try again.", 502, "provider");
    return { url: `https://coinpayportal.com/pay/${id}` };
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
  if (params.get("thanks")) { $("#status").className = "thanks"; $("#status").textContent = "Thank you. Your payment is on its way."; }
  try {
    const info = await (await fetch("/api/v1/support/" + encodeURIComponent(holder), { cache: "no-store" })).json();
    if (info.name) { $("#who").textContent = info.name; document.title = "Support " + info.name + " · nixamp"; }
    const coins = info.coins || [];
    $("#coin").replaceChildren(...coins.map((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c.replace(/_/g, " "); return o; }));
    if (!coins.length) { $("#go").disabled = true; $("#status").textContent = info.error || "Payments are not available right now."; }
  } catch { $("#status").textContent = "Payments are not available right now."; }
  $("#form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const other = Number($("#other").value);
    const usd = other > 0 ? other : amount;
    $("#go").disabled = true;
    $("#status").textContent = "Starting the checkout…";
    try {
      const r = await fetch("/api/v1/support/" + encodeURIComponent(holder), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: usd, coin: $("#coin").value, station: params.get("station") || "", track: params.get("track") || "" }) });
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
    <p>Pay the copyright holder of the music you are listening to, directly. One payment, in crypto, through CoinPay.</p>
    <form id="form">
      <div class="amounts">${AMOUNTS.map((usd, at) => `<button type="button" data-usd="${usd}" aria-pressed="${at === 1}">$${usd}</button>`).join("")}</div>
      <label for="other">Or another amount (US$)</label>
      <input id="other" type="number" min="1" max="1000" step="1" inputmode="numeric">
      <label for="coin">Pay with</label>
      <select id="coin"></select>
      <button id="go" class="go" type="submit">Continue to payment</button>
      <div id="status" role="status" aria-live="polite"></div>
    </form>
    <small>Payments go through <a href="https://coinpayportal.com">CoinPay</a> to nixamp.com, which pays the holder. Nothing recurs.</small>
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
