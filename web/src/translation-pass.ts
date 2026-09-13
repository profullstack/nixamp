import type { TranslationAccess } from "../../src/translation-passes.ts";
const money = (micros: number): string => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(micros / 1_000_000);
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class TranslationPurchase {
  private access: TranslationAccess | null = null;
  private account = "";
  private opener: HTMLElement | null = null;
  private order = "";
  private requestKey = "";
  private selected = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading = false;
  private problem = "";
  private checking = false;
  private readonly dialog = element<HTMLDialogElement>("translation-purchase");
  private readonly plan = element<HTMLSelectElement>("translation-plan");
  private readonly coin = element<HTMLSelectElement>("translation-coin");
  private readonly buy = element<HTMLButtonElement>("translation-checkout");
  private readonly note = element<HTMLParagraphElement>("translation-purchase-note");
  private readonly checkoutLink = element<HTMLAnchorElement>("translation-checkout-link");
  constructor(private readonly options: { account: () => string; changed: () => void }) {
    element("translation-purchase-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => { if (this.timer) clearTimeout(this.timer); this.timer = null; this.opener?.focus({ preventScroll: true }); });
    element("translation-sign-in").addEventListener("click", () => this.dialog.close());
    this.plan.addEventListener("change", () => this.describe());
    this.buy.addEventListener("click", () => void this.purchase());
    element("translation-check-payment").addEventListener("click", () => void this.check());
    window.addEventListener("pagehide", () => { if (this.timer) clearTimeout(this.timer); });
    setInterval(() => { if (this.options.account() && (!this.access || this.access.required)) void this.refresh(); }, 30_000);
  }
  private status(text: string): void { if (this.note.textContent !== text) this.note.textContent = text; }
  loaded(): boolean { return this.access !== null; }
  loadingMessage(): string { return this.problem || "Checking audio credit…"; }
  ready(): boolean { return this.access?.required === false || !!(this.access && this.access.balanceMicros > 0 && this.access.expires && Date.parse(this.access.expires) > Date.now()); }
  button(): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.textContent = "$";
    button.title = "Buy translated audio"; button.setAttribute("aria-label", "Buy translated audio"); button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", "translation-purchase"); button.dataset["translationBuy"] = "";
    button.addEventListener("click", () => this.open(button)); return button;
  }
  open(opener: HTMLElement): void {
    this.opener = opener;
    if (!this.dialog.open) this.dialog.showModal();
    this.status("");
    void this.refresh().then(() => { if (this.order && this.dialog.open) void this.check(); });
  }
  async refresh(): Promise<void> {
    const account = this.options.account();
    this.problem = "";
    if (this.account !== account) { this.account = account; this.access = null; this.order = ""; this.requestKey = ""; this.checkoutLink.hidden = true; }
    try {
      const response = await fetch("/api/v1/translation-passes", { signal: AbortSignal.timeout(15_000) });
      const body = await response.json(); if (this.account !== account || this.options.account() !== account) return;
      if (!response.ok) throw new Error(body.error || "Purchases are unavailable.");
      this.access = body as TranslationAccess;
      const coins = this.access.coins ?? [];
      if ([...this.coin.options].map(option => option.value).join() !== coins.join() && document.activeElement !== this.coin) this.coin.replaceChildren(...coins.map(coin => new Option(coin.replaceAll("_", " · "), coin)));
      const plans = this.access.plans ?? [];
      if (!this.plan.options.length) this.plan.replaceChildren(...plans.map(plan => new Option(`${plan.name} · ${money(plan.priceCents * 10000)}`, plan.id)));
      this.describe();
      const balance = this.access.required ? `${money(this.access.balanceMicros)} audio credit${this.access.expires ? ` · expires ${new Date(this.access.expires).toLocaleString()}` : ""}` : "";
      element("translation-balance").textContent = balance;
      element("translation-purchase-balance").textContent = balance;
      element("translation-sign-in").hidden = !!account;
      this.buy.disabled = !account || !this.access.available || this.loading;
      if (!this.access.available && this.dialog.open) this.status(this.access.required ? "Checkout is temporarily unavailable. Existing credit still works." : "This server sponsors translated audio; no purchase is required.");
      const returned = new URLSearchParams(location.search).get("translation_order");
      const pending = this.access.orders?.find(order => order.id === returned || order.id === this.order) ?? this.access.orders?.[0];
      if (pending && !this.order) { this.order = pending.id; this.link(pending.url); }
      if (returned && !this.order && /^[a-f0-9-]{36}$/i.test(returned) && account) { this.order = returned; void this.check(); }
      this.options.changed();
      if (this.order && !this.dialog.open && !this.checking) void this.check();
    } catch (error) { this.problem = error instanceof Error ? error.message : "Audio credit could not be checked. Use Buy to retry."; if (this.dialog.open) this.status(this.problem); this.options.changed(); }
  }
  private describe(): void {
    const plan = this.access?.plans.find(plan => plan.id === this.plan.value);
    if (!plan) return;
    const minutes = Math.floor((plan.priceCents / 100) / ((0.22 * 3 / 60 + 0.05) * 5));
    element("translation-plan-description").textContent = `${money(plan.priceCents * 10000)} credit. Expires ${plan.days === 1 ? "24 hours" : `${plan.days} days`} after payment. About ${minutes} minutes at 1,000 spoken characters/minute; usage varies. No automatic renewal.`;
  }
  private link(url: string): void {
    if (!/^https:\/\/coinpayportal\.com\/pay\/[a-f0-9-]{36}$/i.test(url)) throw new Error("Invalid checkout address.");
    this.checkoutLink.href = url; this.checkoutLink.hidden = false; element("translation-check-payment").hidden = false;
  }
  private async purchase(): Promise<void> {
    if (this.loading || !this.account) return;
    const account = this.account;
    const selected = `${this.plan.value}|${this.coin.value}`;
    if (!this.requestKey || this.selected !== selected) { this.requestKey = crypto.randomUUID(); this.selected = selected; }
    this.loading = true; this.buy.disabled = true; this.status("Preparing secure checkout…");
    try {
      const response = await fetch("/api/v1/translation-passes/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: this.plan.value, coin: this.coin.value, requestKey: this.requestKey }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json();
      if (this.options.account() !== account) return;
      if (!response.ok) throw new Error(body.error || "Checkout could not be opened.");
      this.order = body.id; this.link(body.url);
      this.status("Open secure checkout to pay. Your video keeps playing in this tab. Credit appears after payment confirmation.");
      this.poll();
    } catch (error) { this.status(error instanceof Error ? error.message : "Checkout could not be opened."); }
    finally { this.loading = false; this.buy.disabled = !this.account || !this.access?.available; }
  }
  private poll(): void { if (this.timer) clearTimeout(this.timer); if (this.dialog.open && this.order) this.timer = setTimeout(() => void this.check(), 5000); }
  private async check(): Promise<void> {
    if (!this.order || !this.account || this.checking) return;
    this.checking = true;
    const order = this.order, account = this.account;
    try {
      const response = await fetch(`/api/v1/translation-passes/orders/${encodeURIComponent(order)}`, { signal: AbortSignal.timeout(20_000) });
      const body = await response.json(); if (this.account !== account || this.order !== order) return;
      if (!response.ok) throw new Error(body.error || "Payment status could not be checked.");
      if (body.status === "paid") {
        this.order = ""; this.requestKey = ""; this.checkoutLink.hidden = true; element("translation-check-payment").hidden = true;
        this.status("Payment confirmed. Enable Translate audio whenever you are ready.");
        const url = new URL(location.href); url.searchParams.delete("translation_order"); history.replaceState(history.state, "", url);
        await this.refresh(); return;
      }
      this.status(body.status === "pending" ? "Waiting for payment confirmation…" : `Payment ${body.status}. Check again if you have already sent it.`);
      if (body.status === "pending") this.poll();
    } catch (error) { this.status(error instanceof Error ? error.message : "Payment status could not be checked."); }
    finally { this.checking = false; }
  }
}
