/**
 * Music licences on nixamp.com (music-license.ts): the pages and the API.
 *
 *   GET  /license?server=&kind=song|album&artist=&album=&n=   pick a licence for a song or album, then pay
 *   GET  /license?kind=catalog                                the Catalog pass, $29 a year
 *   GET  /license/terms                                       the terms, in plain words
 *   GET  /license/NXL-XXXX-XXXX                               anybody's check of a licence
 *   GET  /licenses/:id?t=                                     the licensee's certificate (printable)
 *   POST /api/v1/licenses/checkout                            {tier, kind, server?, artist?, album?, n?, licensee, project, projectUrl?, email, coin, agree} -> {url}
 *   GET  /api/v1/licenses/NXL-XXXX-XXXX                       the check, as JSON
 *   GET  /api/v1/licenses                                     the signed-in account's licences
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LICENSE_PRICES, TERMS_VERSION, TIER_NAMES, TIER_USE, licenseTerms, type License, type MusicLicenses, type Quote, type Tier } from "./music-license.ts";
import { SupportError, paidIn, payUrl } from "./support.ts";

const CHECK = /^\/license\/(NXL-[A-Z2-9]{4}-[A-Z2-9]{4})$/;
const CHECK_JSON = /^\/api\/v1\/licenses\/(NXL-[A-Z2-9]{4}-[A-Z2-9]{4})$/;
const CERTIFICATE = /^\/licenses\/([0-9a-f-]{36})$/;

export function isLicensePath(path: string): boolean {
  return path === "/license" || path === "/license/terms" || CHECK.test(path) || CERTIFICATE.test(path)
    || path === "/api/v1/licenses/checkout" || path === "/api/v1/licenses" || CHECK_JSON.test(path);
}

export interface LicenseRoutesContext {
  licenses: MusicLicenses;
  account: () => Promise<{ id: string; email: string } | null>;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
  /** The opaque id a server goes by in nixamp.com's addresses. */
  serverId: (base: string) => string;
  site: string;
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const price = (cents: number): string => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const STYLE = `
:root{--bg:#080c09;--fg:#e8efe9;--muted:#9aa79d;--card:#0e1410;--line:#1f2a22;--accent:#3ddc84}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;margin-bottom:16px}
h1{margin:0 0 4px;font-size:1.5rem;overflow-wrap:anywhere}h2{font-size:1.05rem;margin:22px 0 6px}.by{color:var(--muted);margin:0 0 16px}
.cover{border-radius:10px;float:right;margin:0 0 8px 12px;width:120px;height:120px;object-fit:cover;max-width:35%}
fieldset{border:0;padding:0;margin:16px 0 0}legend{color:var(--muted);font-size:.9rem;margin-bottom:6px}
.tier{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:start;border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:8px;cursor:pointer}
.tier:has(input:checked){border-color:var(--accent)}.tier strong{display:block}.tier span{color:var(--muted);font-size:.9rem}.tier b{color:var(--accent);white-space:nowrap}
label.f{display:block;color:var(--muted);font-size:.9rem;margin:12px 0 4px}
input[type=text],input[type=email],input[type=url],select{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
.agree{display:flex;gap:8px;align-items:flex-start;margin-top:14px;color:var(--muted);font-size:.9rem}
button,a.go{display:block;text-align:center;text-decoration:none;margin-top:18px;width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent);color:#06120a;font:inherit;font-weight:800;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
#status{min-height:1.4em;margin-top:12px;color:var(--muted)}
small,.muted{color:var(--muted)}a{color:var(--accent)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:16px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.ok{display:inline-block;padding:2px 10px;border-radius:999px;background:#14361f;color:var(--accent);font-weight:700;font-size:.85rem}
.no{display:inline-block;padding:2px 10px;border-radius:999px;background:#3a1717;color:#ff8f8f;font-weight:700;font-size:.85rem}
code{display:block;white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:.9rem;overflow-wrap:anywhere}
.print{background:transparent;border:1px solid var(--line);color:var(--fg)}
@media print{:root{--bg:#fff;--fg:#000;--muted:#444;--card:#fff;--line:#999;--accent:#000}.noprint{display:none}.card{border-color:#000}}
`;

const SCRIPT = `
(() => {
  const $ = (s) => document.querySelector(s);
  const print = $("#print");
  if (print) print.addEventListener("click", () => window.print());
  const form = $("#license");
  if (!form) return;
  const status = $("#status");
  const pay = $("#pay");
  const label = () => { const one = form.querySelector("input[name=tier]:checked"); pay.textContent = one ? "Pay " + one.dataset.price : "Pick a licence"; };
  form.addEventListener("change", label);
  label();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    pay.disabled = true;
    status.textContent = "Starting the checkout…";
    const data = new FormData(form);
    try {
      const r = await fetch("/api/v1/licenses/checkout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ ...JSON.parse(document.body.dataset.item), tier: data.get("tier"), licensee: data.get("licensee"), project: data.get("project"),
          projectUrl: data.get("projectUrl"), email: data.get("email"), agree: data.get("agree") === "on" }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "The checkout did not start.");
      status.textContent = "Taking you to CoinPay…";
      location.href = body.url;
    } catch (error) {
      status.textContent = error.message;
      pay.disabled = false;
    }
  });
})();
`;

export const LICENSE_CSP = ["default-src 'none'", `script-src ${hash(SCRIPT)}`, `style-src ${hash(STYLE)}`, "img-src 'self' https:", "connect-src 'self'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");

function page(title: string, body: string, options: { data?: string; index?: boolean; description?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · nixamp</title>${options.index ? "" : `<meta name="robots" content="noindex">`}${options.description ? `<meta name="description" content="${escape(options.description)}">` : ""}
<link rel="icon" href="/favicon.png" type="image/png"><style>${STYLE}</style></head>
<body${options.data ? ` data-item="${escape(options.data)}"` : ""}><main>${body}</main><script>${SCRIPT}</script></body></html>`;
}

function html(response: ServerResponse, status: number, text: string, method: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": LICENSE_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  response.end(method === "HEAD" ? undefined : text);
}

/** The tiers sold for what is being licensed, cheapest first. */
function tiersFor(kind: Quote["kind"]): Tier[] {
  return (Object.keys(LICENSE_PRICES) as Tier[]).filter((tier) => LICENSE_PRICES[tier][kind]).sort((a, b) => LICENSE_PRICES[a][kind]! - LICENSE_PRICES[b][kind]!);
}

function certificate(license: License, ctx: LicenseRoutesContext, full: boolean): string {
  const view = ctx.licenses.view(license, full);
  const active = Boolean(view["active"]);
  return `<div class="card">
<p>${active ? `<span class="ok">Active licence</span>` : license.status === "paid" ? `<span class="no">Pass ended ${day(license.expiresAt)}</span>` : `<span class="no">Not paid yet</span>`}</p>
<h1>${escape(TIER_NAMES[license.tier])} licence ${escape(license.code)}</h1>
<p class="by">${escape(license.title)}${license.kind === "catalog" ? "" : ` · ${escape(license.artistName)}`}</p>
<dl>
<dt>Licensee</dt><dd>${escape(license.licensee)}</dd>
<dt>Project</dt><dd>${escape(license.project)}${license.projectUrl ? ` · <a href="${escape(license.projectUrl)}" rel="nofollow noopener">${escape(license.projectUrl)}</a>` : ""}</dd>
<dt>Covers</dt><dd>${escape(TIER_USE[license.tier])}</dd>
<dt>Licensor</dt><dd>${escape(ctx.licenses.holder)}</dd>
${license.paidAt ? `<dt>Issued</dt><dd>${day(license.paidAt)}</dd>` : ""}
${license.expiresAt ? `<dt>New projects until</dt><dd>${day(license.expiresAt)} (projects published before then stay licensed)</dd>` : `<dt>Term</dt><dd>For good, worldwide, non-exclusive</dd>`}
<dt>Terms</dt><dd><a href="/license/terms">Version ${escape(license.terms)}</a></dd>
<dt>Check</dt><dd><a href="/license/${escape(license.code)}">${escape(ctx.site)}/license/${escape(license.code)}</a></dd>
</dl>
<h2>Credit line</h2>
<p class="muted">Required wherever the project shows credits or a description, with the link:</p>
<code>${escape(String(view["credit"]))}</code>
${full ? `<button id="print" class="print noprint" type="button">Print or save as PDF</button>` : ""}
</div>`;
}

export async function handleLicenseRoutes(request: IncomingMessage, response: ServerResponse, path: string, url: URL, ctx: LicenseRoutesContext): Promise<boolean> {
  if (!isLicensePath(path)) return false;
  const method = request.method ?? "GET";
  const licenses = ctx.licenses;
  try {
    if (path === "/license" && (method === "GET" || method === "HEAD")) {
      const asked = Object.fromEntries(url.searchParams.entries());
      const kind = asked["kind"] === "catalog" ? "catalog" : asked["kind"] === "album" ? "album" : "song";
      let quote: Quote;
      try {
        quote = await licenses.quote({ ...asked, kind, tier: tiersFor(kind)[0] });
      } catch (error) {
        html(response, 404, page("Not licensable", `<div class="card"><h1>Not licensable</h1><p class="by">${escape((error as Error).message)}</p><p><a href="/music">Back to the music</a></p></div>`), method);
        return true;
      }
      const me = await ctx.account().catch(() => null);
      const cover = quote.kind === "catalog" ? "" : `<img class="cover" src="${escape(`/api/v1/music/file/${ctx.serverId(quote.server)}/${quote.artist}/${quote.album}/cover.jpg`)}" alt="">`;
      const tiers = tiersFor(quote.kind);
      const options = tiers.map((tier, at) => `<label class="tier"><input type="radio" name="tier" value="${tier}" data-price="${price(LICENSE_PRICES[tier][quote.kind]!)}"${at === (tiers.length > 1 ? 1 : 0) ? " checked" : ""}>
<div><strong>${escape(TIER_NAMES[tier])}</strong><span>${escape(TIER_USE[tier])}</span></div><b>${price(LICENSE_PRICES[tier][quote.kind]!)}${tier === "catalog" ? "/year" : ""}</b></label>`).join("");
      const what = quote.kind === "catalog" ? `Every song by every artist ${escape(licenses.holder)} releases on nixamp` : quote.kind === "album" ? `The album "${escape(quote.title)}" by ${escape(quote.artistName)}` : `"${escape(quote.title)}" by ${escape(quote.artistName)}`;
      html(response, 200, page(`License ${quote.title}`, `<div class="card">${cover}
<h1>License ${quote.kind === "catalog" ? "the whole catalogue" : "this music"}</h1>
<p class="by">${what}</p>
<p class="muted">For your game, app, video or podcast. A download is for listening; a licence lets you put the music in your project and publish it. Worldwide, non-exclusive, and every use credits the artist with a link to their page.</p>
<form id="license">
<fieldset><legend>Licence</legend>${options}</fieldset>
<label class="f" for="licensee">Licensed to (your name or company)</label>
<input id="licensee" name="licensee" type="text" required minlength="2" maxlength="120" autocomplete="organization">
<label class="f" for="project">${quote.kind === "catalog" ? "Your studio, channel or business" : "Project the music goes in"}</label>
<input id="project" name="project" type="text" required minlength="2" maxlength="160">
<label class="f" for="projectUrl">Project link (optional)</label>
<input id="projectUrl" name="projectUrl" type="url" maxlength="300" placeholder="https://">
<label class="f" for="email">Email (your certificate goes here)</label>
<input id="email" name="email" type="email" required autocomplete="email" value="${escape(me?.email ?? "")}">
<label class="agree"><input type="checkbox" name="agree" required> <span>I agree to the <a href="/license/terms" target="_blank" rel="noopener">licence terms</a>, including the credit with a link to the artist's page.</span></label>
<button id="pay" type="submit">Pay</button>
</form>
<p id="status" role="status" aria-live="polite"></p>
<small>Payments go through <a href="https://coinpayportal.com">CoinPay</a> to nixamp.com: pick any coin, or PayPal, on CoinPay's page. You get a certificate with a licence code that anybody can check at ${escape(ctx.site)}/license/&lt;code&gt;.</small>
</div>`, { data: JSON.stringify({ kind: quote.kind, ...(quote.kind === "catalog" ? {} : { server: ctx.serverId(quote.server), artist: quote.artist, album: quote.album, n: quote.n }) }) }), method);
      return true;
    }
    if (path === "/license/terms" && (method === "GET" || method === "HEAD")) {
      const sections = licenseTerms(licenses.holder, ctx.site).map((one) => `<h2>${escape(one.heading)}</h2><p>${escape(one.text)}</p>`).join("");
      html(response, 200, page("Music licence terms", `<div class="card"><h1>Music licence terms</h1><p class="by">Version ${TERMS_VERSION} · ${escape(licenses.holder)}</p>${sections}<p><a href="/music">The music</a> · <a href="/license?kind=catalog">Catalog pass</a></p></div>`,
        { index: true, description: `How you may use ${licenses.holder}'s AI music in your games, apps and videos: Creator, Indie, Commercial and the Catalog pass.` }), method);
      return true;
    }
    const check = CHECK.exec(path);
    if (check && (method === "GET" || method === "HEAD")) {
      const license = await licenses.byCode(check[1]!);
      html(response, license ? 200 : 404, page(license ? `Licence ${license.code}` : "No such licence", license
        ? certificate(license, ctx, false)
        : `<div class="card"><h1>No such licence</h1><p class="by">${escape(check[1]!)} is not a paid nixamp music licence.</p></div>`), method);
      return true;
    }
    const mine = CERTIFICATE.exec(path);
    if (mine && (method === "GET" || method === "HEAD")) {
      const license = await licenses.get(mine[1]!, url.searchParams.get("t") ?? "");
      if (!license) {
        html(response, 404, page("No such licence", `<div class="card"><h1>No such licence</h1><p class="by">That link is not one of ours.</p></div>`), method);
        return true;
      }
      const body = license.status === "paid"
        ? certificate(license, ctx, true)
        : `<div class="card"><h1>${escape(TIER_NAMES[license.tier])} licence ${escape(license.code)}</h1><p class="by">${escape(license.title)} · ${price(license.amountCents)}${escape(paidIn(license.coin))}</p>
<p>Waiting for your payment. Once CoinPay confirms it, your certificate is here and in your email (${escape(license.email)}). This page checks again when you reload it.</p>
<a class="go" href="${escape(payUrl(license.paymentId))}">Open the payment</a></div>`;
      html(response, 200, page(`Licence ${license.code}`, body), method);
      return true;
    }
    const checkJson = CHECK_JSON.exec(path);
    if (checkJson && method === "GET") {
      const license = await licenses.byCode(checkJson[1]!);
      response.setHeader("access-control-allow-origin", "*");
      ctx.json(response, license ? 200 : 404, license ? { license: licenses.view(license, false) } : { error: "no such licence", code: "not_found" });
      return true;
    }
    if (path === "/api/v1/licenses/checkout" && method === "POST") {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(await ctx.readBody(request)) as Record<string, unknown>;
      } catch {
        ctx.json(response, 400, { error: "the body is not JSON", code: "bad_json" });
        return true;
      }
      const me = await ctx.account().catch(() => null);
      ctx.json(response, 201, await licenses.checkout(input, me));
      return true;
    }
    if (path === "/api/v1/licenses" && method === "GET") {
      const me = await ctx.account().catch(() => null);
      if (!me) {
        ctx.json(response, 401, { error: "sign in to see your licences", code: "unauthorized" });
        return true;
      }
      ctx.json(response, 200, { licenses: (await licenses.forAccount(me)).map((one) => licenses.view(one, true)) });
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
