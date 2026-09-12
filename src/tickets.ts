/**
 * Tickets: a paid pass to one room.
 *
 * The same x402 machinery the crawler paywall runs on, pointed at a single
 * event instead of at a whole server. A ticket is a signed token with an
 * expiry and nothing else -- no table, no seat map, no order row -- which is
 * what makes it usable from a client on another origin that holds no database.
 *
 * Three things are deliberate:
 *
 * - The signing secret is per event, derived from the deployment's secret and
 *   the event id. A ticket to Friday is therefore not a ticket to Saturday,
 *   and no revocation list is needed to make that true.
 * - The money goes to the event's own `payTo`, so the performer is paid
 *   directly and nixamp is never in the middle of it.
 * - A free event has no till at all: `sell` refuses rather than quoting 0.00,
 *   because a 402 nobody can satisfy is worse than an open door.
 */
import { createHash } from "node:crypto";
import { createGateway, mintPass } from "@profullstack/x402-gateway";
import {
  canPerformEvent,
  isTicketed,
  type LiveEvent,
} from "./live-events.ts";

/** Where a ticket rides. Same shape as the crawl pass, different name. */
export const TICKET_HEADER = "x-nixamp-ticket";

export interface TicketOptions {
  /** A scoped CoinPay key with payments:create. Without it nothing sells. */
  coinpayKey: string;
  /** Pass signing secret. Defaults to the CoinPay key, as the gateway does. */
  secret?: string;
  /** The origin a buyer is quoted, which has to be one they can reach. */
  site: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
}

export interface TicketOffer {
  ticketed: boolean;
  priceCents: number;
  currency: string;
  minutes: number;
  header: string;
  buy: string;
  /** The x402 body, for a client that pays rather than reads. */
  offer: unknown;
}

/** The ticket a request presents: its own header, or the query for a browser. */
export function ticketFrom(
  headers: Record<string, string | string[] | undefined>,
  url?: URL,
): string {
  const raw = headers[TICKET_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header && header.trim()) return header.trim();
  return url?.searchParams.get("ticket")?.trim() ?? "";
}

/**
 * Whether this person still has to buy something before the room opens.
 *
 * Everyone on the stage is already in: an artist who had to buy a ticket to
 * their own show would be a bug with a refund attached. So is the person who
 * is holding a valid one.
 */
export function needsTicket(
  event: LiveEvent,
  accountId: string | undefined,
  hasTicket: boolean,
): boolean {
  if (!isTicketed(event)) return false;
  if (canPerformEvent(event, accountId)) return false;
  return !hasTicket;
}

export class Tickets {
  private readonly built = new Map<string, ReturnType<typeof createGateway>>();

  constructor(private readonly options: TicketOptions) {}

  /** Whether tickets can actually be sold here, as opposed to merely priced. */
  get enabled(): boolean {
    return Boolean(this.options.coinpayKey);
  }

  /**
   * The secret one event's tickets are signed with. Derived rather than
   * stored: it has to be the same on every process that serves the event, and
   * different for every event.
   */
  private secretFor(event: LiveEvent): string {
    const base = this.options.secret || this.options.coinpayKey || "nixamp-tickets";
    return createHash("sha256").update(`${base}:ticket:${event.id}`).digest("hex");
  }

  private gatewayFor(event: LiveEvent) {
    const site = this.options.site.replace(/\/$/, "");
    const key = `${site}|${event.id}|${event.ticketPriceCents}|${event.ticketCurrency}|${event.ticketMinutes}|${event.payTo ?? ""}`;
    const known = this.built.get(key);
    if (known) return known;
    const gateway = createGateway({
      siteUrl: site,
      siteName: event.title,
      payTo: event.payTo ?? "",
      priceCents: event.ticketPriceCents,
      currency: event.ticketCurrency,
      passMinutes: event.ticketMinutes,
      coinpay: { apiKey: this.options.coinpayKey },
      secret: this.secretFor(event),
      header: TICKET_HEADER,
      path: `/live/${event.slug}/tickets`,
      // Nothing here is about who is asking: a ticket is a ticket whatever
      // the user agent says it is.
      isPaidAgent: () => true,
      benefits: [`Watch ${event.title} live, and the replay for ${event.ticketMinutes} minutes.`],
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    // Bounded, so a directory of thousands of events cannot grow a gateway
    // per event and keep them all.
    if (this.built.size > 200) this.built.clear();
    this.built.set(key, gateway);
    return gateway;
  }

  /** What a ticket costs and how to buy one, without answering a request. */
  offer(event: LiveEvent): TicketOffer {
    const site = this.options.site.replace(/\/$/, "");
    return {
      ticketed: isTicketed(event),
      priceCents: event.ticketPriceCents,
      currency: event.ticketCurrency,
      minutes: event.ticketMinutes,
      header: TICKET_HEADER,
      buy: `${site}/live/${event.slug}/tickets`,
      offer: isTicketed(event) ? this.gatewayFor(event).offer(1) : { x402Version: 2, accepts: [] },
    };
  }

  /**
   * A ticket nobody paid for: the guest list.
   *
   * Every venue has one, and a show that cannot comp the press, the support
   * act's friends or a refunded buyer is a show whose only answer to a
   * problem is "pay again". It is the same signed token a sale produces, so
   * nothing downstream has to know which kind it is holding.
   */
  async mint(event: LiveEvent, minutes = event.ticketMinutes): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const pass = await mintPass({
      secret: this.secretFor(event),
      ref: `comp:${event.id}`,
      expiresAt: now + Math.max(1, Math.floor(minutes)) * 60,
      now,
    });
    return pass.token;
  }

  /** Whether this token is a ticket this deployment minted for this event. */
  async holds(event: LiveEvent, token: string): Promise<boolean> {
    if (!token || !isTicketed(event)) return false;
    return this.gatewayFor(event).verifyPass(token);
  }

  /**
   * Sell one. Handed the buyer's request, because the payment proof travels
   * in its headers; answers 402 with the offer, or 200 with the ticket.
   */
  async sell(event: LiveEvent, request: Request): Promise<Response> {
    if (!isTicketed(event)) {
      return Response.json({ error: "this event is free; no ticket is needed" }, { status: 409 });
    }
    if (!this.enabled) {
      return Response.json({ error: "ticket sales are not switched on here" }, { status: 503 });
    }
    return this.gatewayFor(event).sell(request);
  }
}

/** Read a Tickets configuration out of the environment. */
export function ticketsFromEnv(
  site: string,
  env: NodeJS.ProcessEnv = process.env,
): TicketOptions | null {
  const coinpayKey = env["COINPAY_X402_KEY"] ?? "";
  if (!coinpayKey) return null;
  return {
    coinpayKey,
    site,
    ...(env["NIXAMP_TICKET_SECRET"] ? { secret: env["NIXAMP_TICKET_SECRET"] } : {}),
  };
}
