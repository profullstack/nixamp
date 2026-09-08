/**
 * Paying to listen, once a stream is busy.
 *
 * A nixamp serving a handful of friends should cost nothing and ask nothing.
 * Past that it is bandwidth someone is paying for, so the gate opens: over the
 * free listener count, a new listener is answered 402 with an x402 offer and a
 * dollar buys a day.
 *
 * Three things are deliberate. The count is of *live* listeners, so a stream
 * quietens back to free on its own. Only the audio is gated, because a 402 on
 * /api/state would break the page that has to render the offer. And nobody is
 * ever cut off mid-track: the gate is asked once, when a request arrives, and
 * a listener who got in stays in.
 */
import { createGateway } from "@profullstack/x402-gateway";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Listeners who get in for nothing. The sixth is the one who pays. */
export const FREE_LISTENERS = 5;

export interface PaywallConfig {
  enabled: boolean;
  /** EVM address that receives the USDC. Without one there is nothing to pay to. */
  payTo: string;
  /** A scoped CoinPay key with payments:create. */
  coinpayKey: string;
  priceCents: number;
  /** What one price buys. 1440 is a day. */
  passMinutes: number;
}

export const DEFAULT_PAYWALL: PaywallConfig = {
  enabled: false,
  payTo: "",
  coinpayKey: "",
  priceCents: 100,
  passMinutes: 1440,
};

/** Only the audio is behind the gate. */
export const GATED = ["/api/stream/", "/api/media/"];

export function isGated(path: string): boolean {
  return GATED.some((prefix) => path.startsWith(prefix));
}

/**
 * Whether this request should be charged at all. Configuration first, because
 * a disabled paywall must never answer 402; then the path, then how busy the
 * stream is.
 */
export function shouldCharge(config: PaywallConfig, path: string, liveListeners: number): boolean {
  if (!config.enabled || !config.payTo) return false;
  if (!isGated(path)) return false;
  return liveListeners > FREE_LISTENERS;
}

export interface PaywallOptions {
  config: () => PaywallConfig;
  /** How many listeners are on the audio routes right now. */
  liveListeners: () => number;
  /**
   * The origin a payer is quoted, which has to be one they can reach. A
   * function because the port is not known until the socket is bound.
   */
  siteUrl: () => string;
  /** True for the operator's own browser, which never pays to hear its own music. */
  exempt: (request: IncomingMessage) => boolean;
}

/**
 * A node http shim over the gateway's Fetch-API handler. Returns true when it
 * answered the request, so the server's own routing can stop.
 */
export function createPaywall(options: PaywallOptions) {
  let built: { key: string; handle: (request: Request) => Promise<Response | null> } | null = null;

  /** Rebuilt when the configuration changes, because it can change at runtime. */
  const gateway = (config: PaywallConfig, siteUrl: string) => {
    const key = `${siteUrl} ${JSON.stringify(config)}`;
    if (built?.key === key) return built.handle;
    const gate = createGateway({
      siteUrl,
      siteName: "nixamp",
      payTo: config.payTo,
      priceCents: config.priceCents,
      passMinutes: config.passMinutes,
      coinpay: { apiKey: config.coinpayKey },
      header: "x-nixamp-pass",
      path: "/listen/pay",
      // Whether to charge is about how busy this stream is, not about who is
      // asking, so the agent lists play no part.
      isPaidAgent: () => true,
      benefits: ["Listen to this stream for a day, as many tracks as you like."],
    });
    built = { key, handle: (request) => gate.handle(request) };
    return built.handle;
  };

  return async function paywall(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<boolean> {
    const config = options.config();
    // The sales page answers whenever the paywall is configured, so a listener
    // can buy a pass before the stream is busy enough to need one.
    const selling = config.enabled && config.payTo !== "" && path.startsWith("/listen/pay");
    if (!selling && !shouldCharge(config, path, options.liveListeners())) return false;
    if (options.exempt(request)) return false;

    const siteUrl = options.siteUrl();
    const answer = await gateway(config, siteUrl)(toRequest(request, siteUrl));
    if (answer === null) return false;

    const body = await rewrite(answer, siteUrl);
    response.writeHead(answer.status, {
      ...Object.fromEntries(answer.headers),
      "content-length": String(body.byteLength),
    });
    response.end(body);
    return true;
  };
}

/**
 * The gateway sells crawl access, and says so: its 402 tells the caller that
 * "payment is required for training crawlers". Someone trying to hear a song
 * is not a crawler, so the sentence is replaced on the way out. The offer
 * itself is untouched -- only the words are ours.
 */
export async function rewrite(answer: Response, siteUrl: string): Promise<Buffer> {
  const raw = Buffer.from(await answer.arrayBuffer());
  if (answer.status !== 402 || !(answer.headers.get("content-type") ?? "").includes("json")) return raw;

  try {
    const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    parsed["error"] =
      `This stream has more than ${FREE_LISTENERS} people listening. ` +
      `A pass is ${(parsed as { pass?: { price?: string } }).pass?.price ?? "$1"} for a day: ${siteUrl}/listen/pay`;
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    // Not JSON after all: send exactly what the gateway produced.
    return raw;
  }
}

/**
 * Enough of a Fetch Request for the gateway: it reads the URL, the method and
 * headers. A body would need streaming, and nothing it gates has one.
 */
export function toRequest(request: IncomingMessage, siteUrl: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(new URL(request.url ?? "/", siteUrl), {
    method: request.method ?? "GET",
    headers,
  });
}

/** Read a paywall out of the environment, for an operator who runs one by hand. */
export function paywallFromEnv(env: NodeJS.ProcessEnv = process.env): PaywallConfig {
  const price = Number(env["NIXAMP_PRICE_CENTS"]);
  const minutes = Number(env["NIXAMP_PASS_MINUTES"]);
  return {
    enabled: env["NIXAMP_X402"] === "1",
    payTo: env["NIXAMP_PAY_TO"] ?? "",
    coinpayKey: env["COINPAY_X402_KEY"] ?? "",
    priceCents: Number.isFinite(price) && price > 0 ? Math.floor(price) : DEFAULT_PAYWALL.priceCents,
    passMinutes:
      Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : DEFAULT_PAYWALL.passMinutes,
  };
}

/**
 * The directory's answer may carry a configuration, which is how a server is
 * turned on and off from nixamp.com. Anything missing keeps what it had, and
 * a payTo the operator did not set is never invented here.
 */
export function applyRemoteConfig(current: PaywallConfig, remote: unknown): PaywallConfig {
  if (typeof remote !== "object" || remote === null) return current;
  const record = remote as Record<string, unknown>;
  const price = Number(record["priceCents"]);
  const minutes = Number(record["passMinutes"]);
  return {
    enabled: typeof record["enabled"] === "boolean" ? record["enabled"] : current.enabled,
    payTo: typeof record["payTo"] === "string" && record["payTo"] ? record["payTo"] : current.payTo,
    coinpayKey:
      typeof record["coinpayKey"] === "string" && record["coinpayKey"]
        ? record["coinpayKey"]
        : current.coinpayKey,
    priceCents: Number.isFinite(price) && price > 0 ? Math.floor(price) : current.priceCents,
    passMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : current.passMinutes,
  };
}
