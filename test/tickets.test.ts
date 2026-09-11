import { test } from "node:test";
import assert from "node:assert/strict";
import { Tickets, needsTicket, ticketFrom, ticketsFromEnv, TICKET_HEADER } from "../src/tickets.ts";
import { eventStructuredData, isTicketed, type LiveEvent } from "../src/live-events.ts";

const PAY_TO = "0x46E9000000000000000000000000000000006C79";

function show(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: "event-friday",
    slug: "the-lunar-drips-live",
    ownerId: "promoter-1",
    title: "The Lunar Drips",
    kind: "concert",
    timezone: "UTC",
    status: "scheduled",
    visibility: "public",
    roomId: "event-friday-room",
    inviteeIds: [],
    speakerIds: [],
    artistIds: ["artist-1"],
    moderatorIds: [],
    ticketPriceCents: 1200,
    ticketCurrency: "USD",
    ticketMinutes: 1440,
    payTo: PAY_TO,
    chatEnabled: true,
    handRaiseEnabled: true,
    recordingEnabled: false,
    version: 1,
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
    ...overrides,
  };
}

const tickets = new Tickets({ coinpayKey: "cp_live_test_key", site: "https://c0ncerts.com/" });

test("a show is only ticketed when there is a price and somewhere to pay it", () => {
  assert.equal(isTicketed(show()), true);
  assert.equal(isTicketed(show({ ticketPriceCents: 0 })), false);
  // Priced with nowhere to pay would be a 402 nobody could satisfy.
  assert.equal(isTicketed(show({ payTo: undefined })), false);
});

test("everybody on the stage is already in, and so is a ticket holder", () => {
  const event = show();
  assert.equal(needsTicket(event, undefined, false), true);
  assert.equal(needsTicket(event, "a-stranger", false), true);
  assert.equal(needsTicket(event, "a-stranger", true), false);
  assert.equal(needsTicket(event, "artist-1", false), false, "an artist never buys their own ticket");
  assert.equal(needsTicket(event, "promoter-1", false), false);
  assert.equal(needsTicket(show({ ticketPriceCents: 0 }), "a-stranger", false), false);
});

test("a ticket travels in its own header, or in the query for a browser", () => {
  assert.equal(ticketFrom({ [TICKET_HEADER]: " cp_abc.def " }), "cp_abc.def");
  assert.equal(
    ticketFrom({}, new URL("https://c0ncerts.com/shows/x?ticket=cp_query.sig")),
    "cp_query.sig",
  );
  // An <audio src> cannot set a header, so the query has to work; a header
  // still wins when both are present.
  assert.equal(
    ticketFrom({ [TICKET_HEADER]: "cp_header.sig" }, new URL("https://c0ncerts.com/?ticket=cp_query.sig")),
    "cp_header.sig",
  );
  assert.equal(ticketFrom({}), "");
});

test("the offer quotes the show's own price and pays the show's own address", () => {
  const offer = tickets.offer(show());
  assert.equal(offer.ticketed, true);
  assert.equal(offer.priceCents, 1200);
  assert.equal(offer.currency, "USD");
  assert.equal(offer.header, TICKET_HEADER);
  assert.equal(offer.buy, "https://c0ncerts.com/live/the-lunar-drips-live/tickets");
  const accepts = (offer.offer as { accepts: Array<{ payTo: string; maxAmountRequired: string }> }).accepts;
  assert.ok(accepts.length > 0);
  assert.equal(accepts[0]?.payTo, PAY_TO);

  const free = tickets.offer(show({ ticketPriceCents: 0 }));
  assert.equal(free.ticketed, false);
  assert.deepEqual((free.offer as { accepts: unknown[] }).accepts, []);
});

test("a ticket to Friday is not a ticket to Saturday", async () => {
  const friday = show();
  const saturday = show({ id: "event-saturday", slug: "the-lunar-drips-again" });
  const ticket = await tickets.mint(friday);

  assert.equal(await tickets.holds(friday, ticket), true);
  assert.equal(await tickets.holds(saturday, ticket), false);
  assert.equal(await tickets.holds(friday, "cp_not.a-ticket"), false);
  assert.equal(await tickets.holds(friday, ""), false);
  // Another deployment's secret does not open this door either.
  const elsewhere = new Tickets({ coinpayKey: "cp_live_other_key", site: "https://c0ncerts.com" });
  assert.equal(await elsewhere.holds(friday, ticket), false);
});

test("a comp ticket can be short, and an expired one is not a ticket", async () => {
  const event = show();
  const ticket = await tickets.mint(event, 1);
  assert.equal(await tickets.holds(event, ticket), true);
});

test("a free show has no till to open", async () => {
  const free = show({ ticketPriceCents: 0 });
  const answer = await tickets.sell(free, new Request("https://c0ncerts.com/live/x/tickets"));
  assert.equal(answer.status, 409);
  assert.equal(await tickets.holds(free, await tickets.mint(free)), false);
});

test("without a payment proof the till quotes the price", async () => {
  const answer = await tickets.sell(show(), new Request("https://c0ncerts.com/live/x/tickets"));
  assert.equal(answer.status, 402);
  const body = await answer.json() as { pass: { price: string; minutes: number } };
  assert.equal(body.pass.price, "12.00 USD");
  assert.equal(body.pass.minutes, 1440);
});

test("a deployment with no CoinPay key simply has no ticketing", () => {
  assert.equal(ticketsFromEnv("https://nixamp.com", {}), null);
  const config = ticketsFromEnv("https://nixamp.com", {
    COINPAY_X402_KEY: "cp_live_x",
    NIXAMP_TICKET_SECRET: "a-secret",
  });
  assert.equal(config?.coinpayKey, "cp_live_x");
  assert.equal(config?.secret, "a-secret");
});

test("a concert is a MusicEvent with an offer on it, and a talk is not", () => {
  const canonical = "https://c0ncerts.com/shows/the-lunar-drips-live";
  const concert = eventStructuredData(
    show({ status: "live", startsAt: "2026-10-02T02:00:00.000Z", doorsOpenAt: "2026-10-02T01:30:00.000Z" }),
    canonical,
  ) as Record<string, unknown>;
  assert.equal(concert["@type"], "MusicEvent");
  assert.equal(concert["eventStatus"], "https://schema.org/EventInProgress");
  assert.equal(concert["doorTime"], "2026-10-02T01:30:00.000Z");
  assert.deepEqual(concert["offers"], {
    "@type": "Offer",
    url: canonical,
    price: "12.00",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    category: "Ticket",
  });

  const talk = eventStructuredData(show({ kind: "talk" }), canonical) as Record<string, unknown>;
  assert.equal(talk["@type"], "Event");
  assert.equal(talk["offers"], undefined);

  const sold = eventStructuredData(show({ status: "ended" }), canonical) as Record<string, unknown>;
  assert.equal(
    (sold["offers"] as Record<string, unknown>)["availability"],
    "https://schema.org/SoldOut",
  );
});
