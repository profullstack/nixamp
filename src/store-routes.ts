/**
 * The music store's pages and API on nixamp.com (music-store.ts).
 *
 *   GET  /buy?server=&kind=&artist=&album=&n=     what it is, the price, email + coin, Pay
 *   GET  /purchases/:id?t=                        the receipt: waiting, or Download the zip
 *   GET  /api/v1/store/coins                      the coins nixamp's CoinPay business takes
 *   POST /api/v1/store/checkout                   {server, kind, artist, album?, n?, email, coin} -> {url}
 *   GET  /api/v1/store/purchases                  the signed-in account's music (My music on /radio)
 *   GET  /api/v1/store/purchases/:id?t=           one purchase by its link
 *   GET  /api/v1/store/grant?g=                   a server asks whether a grant is good
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PRICES, type MusicStore } from "./music-store.ts";
import { SupportError } from "./support.ts";

const PURCHASE = /^\/purchases\/([0-9a-f-]{36})$/;
const ONE = /^\/api\/v1\/store\/purchases\/([0-9a-f-]{36})$/;

export function isStorePath(path: string): boolean {
  return path === "/buy" || PURCHASE.test(path) || path === "/api/v1/store/coins" || path === "/api/v1/store/checkout"
    || path === "/api/v1/store/purchases" || ONE.test(path) || path === "/api/v1/store/grant";
}

export interface StoreRoutesContext {
  store: MusicStore;
  coins: () => Promise<string[]>;
  /** The signed-in account, or null. */
  account: () => Promise<{ id: string; email: string } | null>;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
}

function hash(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

const STYLE = `
:root{--bg:#080c09;--fg:#e8efe9;--muted:#9aa79d;--card:#0e1410;--line:#1f2a22;--accent:#3ddc84}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{margin:0 0 4px;font-size:1.5rem;overflow-wrap:anywhere}.by{color:var(--muted);margin:0 0 16px}
.price{font-size:2rem;font-weight:800;color:var(--accent);margin:8px 0}
ul{color:var(--muted);padding-left:20px}
label{display:block;color:var(--muted);font-size:.9rem;margin:12px 0 4px}
input,select{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button,a.go{display:block;text-align:center;text-decoration:none;margin-top:18px;width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent);color:#06120a;font:inherit;font-weight:800;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
#status{min-height:1.4em;margin-top:12px;color:var(--muted)}
small{display:block;margin-top:18px;color:var(--muted)}small a,p a{color:var(--accent)}
`;

const BUY_SCRIPT = `
(async () => {
  const $ = (s) => document.querySelector(s);
  const status = $("#status");
  try {
    const coins = await (await fetch("/api/v1/store/coins")).json();
    const cheap = ["USDC_POL", "USDC_SOL", "SOL", "POL", "LTC", "USDC_BASE", "USDC"];
    const list = (coins.coins || []).slice().sort((a, b) => (cheap.indexOf(a) + 1 || 99) - (cheap.indexOf(b) + 1 || 99));
    $("#coin").replaceChildren(...list.map((c) => Object.assign(document.createElement("option"), { value: c, textContent: c })));
  } catch { status.textContent = "Payments are not available right now."; }
  $("#buy").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#pay");
    button.disabled = true;
    status.textContent = "Starting the checkout…";
    const form = new FormData(event.currentTarget);
    try {
      const r = await fetch("/api/v1/store/checkout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ ...JSON.parse(document.body.dataset.item), email: form.get("email"), coin: form.get("coin") }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "The checkout did not start.");
      status.textContent = "Taking you to CoinPay…";
      location.href = body.url;
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();
`;

export const STORE_CSP = ["default-src 'none'", `script-src ${hash(BUY_SCRIPT)}`, `style-src ${hash(STYLE)}`, "img-src https:", "connect-src 'self'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");

function page(title: string, body: string, data = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · nixamp</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.png" type="image/png"><style>${STYLE}</style></head>
<body${data ? ` data-item="${escape(data)}"` : ""}><main>${body}</main>${data ? `<script>${BUY_SCRIPT}</script>` : ""}</body></html>`;
}

function price(cents: number): string {
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

function html(response: ServerResponse, status: number, text: string, method: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": STORE_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  response.end(method === "HEAD" ? undefined : text);
}

export async function handleStoreRoutes(request: IncomingMessage, response: ServerResponse, path: string, url: URL, ctx: StoreRoutesContext): Promise<boolean> {
  if (!isStorePath(path)) return false;
  const method = request.method ?? "GET";
  const store = ctx.store;
  try {
    if (path === "/buy" && (method === "GET" || method === "HEAD")) {
      let item;
      try {
        item = await store.describe(Object.fromEntries(url.searchParams.entries()));
      } catch (error) {
        html(response, 404, page("Not for sale", `<div class="card"><h1>Not for sale</h1><p class="by">${escape((error as Error).message)}</p></div>`), method);
        return true;
      }
      const me = await ctx.account().catch(() => null);
      const what = item.kind === "song" ? "One song" : item.kind === "album" ? `The album, ${item.songs} songs` : `Everything by ${escape(item.artistName)}, ${item.songs} songs so far`;
      const cover = item.kind === "artist" ? "" : `<img src="${escape(`${item.server}/api/v1/label/${item.artist}/${item.album}/cover.jpg`)}" alt="" width="160" height="160" style="border-radius:10px;float:right;margin:0 0 8px 12px;max-width:40%;height:auto">`;
      html(response, 200, page(`Download ${item.title}`, `<div class="card">${cover}
<h1>${escape(item.title)}</h1><p class="by">${escape(item.artistName)}</p>
<div class="price">${price(item.amountCents)}</div>
<ul><li>${what}, as MP3</li><li>Album artwork and the lyrics, inside each file and beside it</li><li>One zip, yours to keep; download again any time</li></ul>
<form id="buy">
<label for="email">Email (your download link goes here)</label>
<input id="email" name="email" type="email" required autocomplete="email" value="${escape(me?.email ?? "")}">
<label for="coin">Pay with</label>
<select id="coin" name="coin" required></select>
<button id="pay" type="submit">Pay ${price(item.amountCents)} with crypto</button>
</form>
<p id="status" role="status" aria-live="polite"></p>
<small>Payments go through <a href="https://coinpayportal.com">CoinPay</a> to nixamp.com. For small amounts pick a coin with low fees (USDC on Polygon or Solana, SOL, LTC). Listening on the live stations is always free.${me ? "" : ` <a href="/radio#music">Sign in</a> with the same email to keep everything under My music.`}</small>
</div>`, JSON.stringify({ server: item.server, kind: item.kind, artist: item.artist, album: item.album, n: item.n })), method);
      return true;
    }
    const receipt = PURCHASE.exec(path);
    if (receipt && (method === "GET" || method === "HEAD")) {
      const purchase = await store.get(receipt[1]!, url.searchParams.get("t") ?? "");
      if (!purchase) {
        html(response, 404, page("No such purchase", `<div class="card"><h1>No such purchase</h1><p class="by">That link is not one of ours.</p></div>`), method);
        return true;
      }
      const body = purchase.status === "paid"
        ? `<div class="card"><h1>${escape(purchase.title)}</h1><p class="by">${escape(purchase.artistName)} · paid ${price(purchase.amountCents)}</p>
<a class="go" href="${escape(store.zipUrl(purchase))}" download>Download the zip</a>
<small>MP3s with the cover art and lyrics, plus each song's .lyrics.txt, cover.jpg and album.json. Keep this page's address (it is in your email too) to download again. Signed in to nixamp.com as ${escape(purchase.email)}, everything you bought is under <a href="/radio#music">My music</a>, to play or download.</small></div>`
        : `<div class="card"><h1>${escape(purchase.title)}</h1><p class="by">${escape(purchase.artistName)} · ${price(purchase.amountCents)} in ${escape(purchase.coin)}</p>
<p>Waiting for your payment. Once CoinPay confirms it, your download is here and in your email (${escape(purchase.email)}). This page checks again when you reload it.</p>
<a class="go" href="https://coinpayportal.com/pay/${escape(purchase.paymentId)}">Open the payment</a></div>`;
      html(response, 200, page(purchase.title, body), method);
      return true;
    }
    if (path === "/api/v1/store/coins" && method === "GET") {
      ctx.json(response, 200, { coins: await ctx.coins(), prices: { song: PRICES.song / 100, album: PRICES.album / 100, artist: PRICES.artist / 100 } });
      return true;
    }
    if (path === "/api/v1/store/checkout" && method === "POST") {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(await ctx.readBody(request)) as Record<string, unknown>;
      } catch {
        ctx.json(response, 400, { error: "the body is not JSON", code: "bad_json" });
        return true;
      }
      const me = await ctx.account().catch(() => null);
      const made = await store.checkout(input, me);
      ctx.json(response, 201, made);
      return true;
    }
    if (path === "/api/v1/store/purchases" && method === "GET") {
      const me = await ctx.account().catch(() => null);
      if (!me) {
        ctx.json(response, 401, { error: "sign in to see your music", code: "unauthorized" });
        return true;
      }
      ctx.json(response, 200, { email: me.email, purchases: (await store.forAccount(me)).map((one) => store.view(one)) });
      return true;
    }
    const one = ONE.exec(path);
    if (one && method === "GET") {
      const purchase = await store.get(one[1]!, url.searchParams.get("t") ?? "");
      if (!purchase) {
        ctx.json(response, 404, { error: "no such purchase", code: "not_found" });
        return true;
      }
      ctx.json(response, 200, { purchase: store.view(purchase) });
      return true;
    }
    if (path === "/api/v1/store/grant" && method === "GET") {
      const scope = store.check(url.searchParams.get("g") ?? "");
      ctx.json(response, scope ? 200 : 403, scope ? { ok: true, scope } : { ok: false });
      return true;
    }
    ctx.json(response, 405, { error: "not like that", code: "method_not_allowed" });
    return true;
  } catch (error) {
    if (error instanceof SupportError) ctx.json(response, error.status, { error: error.message, code: error.code });
    else ctx.json(response, 500, { error: error instanceof Error ? error.message : String(error), code: "internal" });
    return true;
  }
}
