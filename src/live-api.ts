import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenFrom, type Account, type Accounts } from "./accounts.ts";
import {
  INVITATION_STATES,
  LIVE_EVENT_KINDS,
  LIVE_EVENT_STATUSES,
  LiveEventError,
  isTicketed,
  type LiveEvent,
  type LiveEventKind,
  type LiveEventStatus,
  type LiveEvents,
} from "./live-events.ts";
import {
  LAYOUT_SCOPES,
  LayoutError,
  PANEL_REGISTRY,
  layoutNameFor,
  type Layout,
  type Layouts,
  presetLayout,
} from "./layouts.ts";
import { needsTicket, ticketFrom, type Tickets } from "./tickets.ts";
import { toRequest } from "./paywall.ts";
import { HAND_RAISE_STATES, RoomError, type Rooms } from "./rooms.ts";

export interface LiveApiOptions {
  events: LiveEvents;
  accounts?: Accounts;
  layouts?: Layouts;
  rooms?: Rooms;
  /** Ticket sales for paid events. Absent means every event is a free one. */
  tickets?: Tickets;
  site?: string;
  email?: (to: string, note: { title: string; body: string; url: string }) => Promise<boolean>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, if-match",
};

function json(response: ServerResponse, code: number, body: unknown): void {
  const value = JSON.stringify(body);
  response.writeHead(code, {
    ...CORS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
  });
  response.end(value);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) throw new LiveEventError("body too large", 413);
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LiveEventError) throw error;
    throw new LiveEventError("bad JSON", 400);
  }
}

function reference(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new LiveEventError("bad event reference", 400);
  }
}

function requestedVersion(request: IncomingMessage, input: Record<string, unknown>): number {
  const header = request.headers["if-match"];
  const raw = Array.isArray(header) ? header[0] : header;
  const fromHeader = raw ? Number(raw.replace(/^W\//, "").replace(/^"|"$/g, "")) : NaN;
  return Number.isInteger(fromHeader) && fromHeader > 0 ? fromHeader : Number(input["version"]);
}

function accountName(account: Account): string {
  return account.email.split("@")[0]?.replace(/[._-]+/g, " ").trim() || "Someone";
}

function permissionsFor(event: LiveEvent, account: Account | null, hasTicket = false): string[] {
  const id = account?.id ?? "";
  if (account?.id === event.ownerId || event.moderatorIds.includes(id)) {
    return [
      "event.update",
      "event.start",
      "event.end",
      "event.invite",
      "event.moderate",
      "event.perform",
      "room.listen",
      "room.chat",
      "room.raise_hand",
      "room.speak",
      "recording.start",
      "recording.stop",
      "recording.publish",
      "layout.read",
      "layout.update",
      "panel.add",
      "panel.update",
      "panel.remove",
    ];
  }
  // An artist performs without presiding: on stage, and on the controls that
  // put them there, but never on the guest list or the moderation queue.
  if (event.artistIds.includes(id)) {
    return [
      "event.start",
      "event.end",
      "event.perform",
      "room.listen",
      "room.chat",
      "room.raise_hand",
      "room.speak",
      "recording.start",
      "recording.stop",
      "layout.read",
    ];
  }
  // A paid room admits nobody who has not paid, so even listening is withheld
  // until there is a ticket. A free room is what it always was.
  const listening = isTicketed(event) && !hasTicket ? [] : ["room.listen"];
  return account
    ? [...listening, "room.chat", "room.raise_hand", "layout.read"]
    : [...listening, "layout.read"];
}

function roleOf(event: LiveEvent, account: Account | null, hasTicket: boolean): "viewer" | "member" | "host" {
  const id = account?.id ?? "";
  if (event.ownerId === id || event.moderatorIds.includes(id) || event.artistIds.includes(id)) return "host";
  if (isTicketed(event)) return hasTicket ? "member" : "viewer";
  return account ? "member" : "viewer";
}

function layoutFor(event: LiveEvent, account: Account | null, hasTicket = false): Layout {
  const name = layoutNameFor(event.kind, roleOf(event, account, hasTicket));
  return presetLayout(event.layoutId ?? name) ?? presetLayout(name)!;
}

export interface EventView {
  event: LiveEvent;
  permissions: string[];
  layout: Layout;
  ticket: { required: boolean; held: boolean; priceCents: number; currency: string };
}

function view(event: LiveEvent, account: Account | null, hasTicket = false): EventView {
  return {
    event,
    permissions: permissionsFor(event, account, hasTicket),
    layout: layoutFor(event, account, hasTicket),
    ticket: {
      required: needsTicket(event, account?.id, hasTicket),
      held: hasTicket,
      priceCents: event.ticketPriceCents,
      currency: event.ticketCurrency,
    },
  };
}

/** Whether this request carries a ticket to this event. */
async function ticketHeld(
  request: IncomingMessage,
  url: URL,
  options: LiveApiOptions,
  event: LiveEvent,
): Promise<boolean> {
  if (!options.tickets || !isTicketed(event)) return false;
  return options.tickets.holds(event, ticketFrom(request.headers, url));
}

async function signedIn(request: IncomingMessage, accounts: Accounts | undefined): Promise<Account | null> {
  return accounts?.whoIs(tokenFrom(request.headers)) ?? null;
}

async function requiredAccount(request: IncomingMessage, response: ServerResponse, options: LiveApiOptions): Promise<Account | null> {
  const account = await signedIn(request, options.accounts);
  if (!account) json(response, 401, { error: "sign in first" });
  return account;
}

async function eventAccess(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: LiveApiOptions,
  event: LiveEvent | null,
): Promise<Account | null | false> {
  if (!event) {
    json(response, 404, { error: "event not found" });
    return false;
  }
  const account = await signedIn(request, options.accounts);
  const invited = await options.events.invitationAllows(event.id, url.searchParams.get("invite") ?? "");
  if (!(await options.events.canAccess(event, account?.id)) && !invited) {
    json(response, 404, { error: "event not found" });
    return false;
  }
  return account;
}

async function manage(
  request: IncomingMessage,
  response: ServerResponse,
  options: LiveApiOptions,
  event: LiveEvent,
): Promise<Account | null> {
  const account = await requiredAccount(request, response, options);
  if (!account) return null;
  if (!options.events.canManage(event, account.id)) {
    json(response, 403, { error: "only hosts and moderators can do that" });
    return null;
  }
  return account;
}

/** Everyone on the stage: the host, a moderator, and an invited artist. */
async function perform(
  request: IncomingMessage,
  response: ServerResponse,
  options: LiveApiOptions,
  event: LiveEvent,
): Promise<Account | null> {
  const account = await requiredAccount(request, response, options);
  if (!account) return null;
  if (!options.events.canPerform(event, account.id)) {
    json(response, 403, { error: "only the people on this stage can do that" });
    return null;
  }
  return account;
}

export async function handleLiveApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: LiveApiOptions,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/v1/events") &&
      !path.startsWith("/api/v1/invitations/") &&
      !path.startsWith("/api/v1/layouts") &&
      !path.startsWith("/api/v1/layout-presets")) return false;

  try {
    if (path === "/api/v1/events") {
      if (request.method === "GET") {
        const account = await signedIn(request, options.accounts);
        const statusValue = url.searchParams.get("status") ?? undefined;
        if (statusValue && !LIVE_EVENT_STATUSES.includes(statusValue as LiveEventStatus)) {
          throw new LiveEventError(`status must be one of ${LIVE_EVENT_STATUSES.join(", ")}`, 422);
        }
        const kindValue = url.searchParams.get("kind") ?? undefined;
        if (kindValue && !LIVE_EVENT_KINDS.includes(kindValue as LiveEventKind)) {
          throw new LiveEventError(`kind must be one of ${LIVE_EVENT_KINDS.join(", ")}`, 422);
        }
        const mine = url.searchParams.get("mine") === "true";
        if (mine && !account) {
          json(response, 401, { error: "sign in to see your events" });
          return true;
        }
        const requestedLimit = Number(url.searchParams.get("limit") ?? 30);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
          throw new LiveEventError("limit must be a positive integer", 422);
        }
        const events = await options.events.list({
          ...(mine && account ? { ownerId: account.id } : {}),
          ...(statusValue ? { status: statusValue as LiveEventStatus } : {}),
          ...(kindValue ? { kind: kindValue as LiveEventKind } : {}),
          ...(url.searchParams.get("topic") ? { topic: url.searchParams.get("topic")! } : {}),
          ...(url.searchParams.get("from") ? { from: url.searchParams.get("from")! } : {}),
          limit: requestedLimit,
        });
        json(response, 200, { events });
        return true;
      }
      if (request.method === "POST") {
        const account = await requiredAccount(request, response, options);
        if (!account) return true;
        const input = await body(request);
        const event = await options.events.create(account.id, { ...input, title: input["title"] });
        json(response, 201, view(event, account));
        return true;
      }
      json(response, 405, { error: "GET or POST" });
      return true;
    }

    const invitationMatch = /^\/api\/v1\/invitations\/([^/]+)\/(accept|decline)$/.exec(path);
    if (invitationMatch) {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return true;
      }
      const account = await requiredAccount(request, response, options);
      if (!account) return true;
      const invitation = await options.events.respond(
        reference(invitationMatch[1]!),
        account.id,
        invitationMatch[2] === "accept" ? "accepted" : "declined",
      );
      json(response, 200, { invitation });
      return true;
    }

    const presetMatch = /^\/api\/v1\/layout-presets\/([^/]+)$/.exec(path);
    if (presetMatch) {
      if (request.method !== "GET") {
        json(response, 405, { error: "GET only" });
        return true;
      }
      const layout = presetLayout(reference(presetMatch[1]!));
      json(response, layout ? 200 : 404, layout ? { layout, registry: PANEL_REGISTRY } : { error: "layout preset not found" });
      return true;
    }

    if (path === "/api/v1/layouts" && options.layouts) {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return true;
      }
      const account = await requiredAccount(request, response, options);
      if (!account) return true;
      const input = await body(request);
      const scope = String(input["scope"] ?? "");
      if (!LAYOUT_SCOPES.includes(scope as (typeof LAYOUT_SCOPES)[number]) || !["user", "event"].includes(scope)) {
        throw new LayoutError("regular users may create user or event layouts", 403);
      }
      if (scope === "event") {
        const event = await options.events.get(String(input["scopeId"] ?? ""));
        if (!event || !options.events.canManage(event, account.id)) {
          throw new LayoutError("only an event host can create its layout", 403);
        }
      }
      json(response, 201, {
        layout: await options.layouts.create({
          ...input,
          name: input["name"],
          scope: input["scope"],
        }, account.id),
      });
      return true;
    }

    const layoutMatch = /^\/api\/v1\/layouts\/([^/]+)(?:\/(panels)(?:\/([^/]+))?|\/(reset))?$/.exec(path);
    if (layoutMatch && options.layouts) {
      const layoutId = reference(layoutMatch[1]!);
      if (request.method === "GET" && !layoutMatch[2] && !layoutMatch[4]) {
        const layout = await options.layouts.get(layoutId);
        if (!layout) {
          json(response, 404, { error: "layout not found" });
          return true;
        }
        const account = await signedIn(request, options.accounts);
        if (layout.ownerId && layout.ownerId !== account?.id) {
          json(response, 404, { error: "layout not found" });
          return true;
        }
        json(response, 200, { layout, registry: PANEL_REGISTRY });
        return true;
      }
      const account = await requiredAccount(request, response, options);
      if (!account) return true;
      const input = request.method === "DELETE" ? {} : await body(request);
      const version = requestedVersion(request, input);
      let layout: Layout;
      if (layoutMatch[4] && request.method === "POST") {
        layout = await options.layouts.reset(layoutId, String(input["preset"] ?? ""), version, account.id);
      } else if (layoutMatch[2] && !layoutMatch[3] && request.method === "POST") {
        layout = await options.layouts.addPanel(layoutId, input["panel"] ?? input, version, account.id);
      } else if (layoutMatch[2] && layoutMatch[3] && request.method === "PATCH") {
        layout = await options.layouts.updatePanel(layoutId, reference(layoutMatch[3]), input["panel"] ?? input, version, account.id);
      } else if (layoutMatch[2] && layoutMatch[3] && request.method === "DELETE") {
        layout = await options.layouts.removePanel(layoutId, reference(layoutMatch[3]), version, account.id);
      } else if (!layoutMatch[2] && !layoutMatch[4] && request.method === "PATCH") {
        layout = await options.layouts.update(layoutId, input["panels"], version, account.id);
      } else {
        json(response, 405, { error: "method not allowed" });
        return true;
      }
      json(response, 200, { layout });
      return true;
    }

    const eventMatch = /^\/api\/v1\/events\/([^/]+)(?:\/(invitations|chat|hand-raises|tickets)(?:\/([^/]+))?|\/(doors|start|encore|end|cancel|archive))?$/.exec(path);
    if (!eventMatch) {
      json(response, 404, { error: "no such endpoint" });
      return true;
    }
    const eventRef = reference(eventMatch[1]!);
    const event = await options.events.get(eventRef);
    const collection = eventMatch[2];
    const child = eventMatch[3] ? reference(eventMatch[3]) : undefined;
    const action = eventMatch[4];

    if (!collection && !action) {
      if (request.method === "GET") {
        const account = await eventAccess(request, response, url, options, event);
        if (account === false || !event) return true;
        json(response, 200, view(event, account, await ticketHeld(request, url, options, event)));
        return true;
      }
      const account = await requiredAccount(request, response, options);
      if (!account) return true;
      if (request.method === "PATCH") {
        const input = await body(request);
        const updated = await options.events.update(eventRef, account.id, {
          ...input,
          version: requestedVersion(request, input),
        });
        json(response, 200, view(updated, account, await ticketHeld(request, url, options, updated)));
        return true;
      }
      if (request.method === "DELETE") {
        const removed = await options.events.remove(eventRef, account.id);
        json(response, removed ? 200 : 404, removed ? { ok: true } : { error: "event not found" });
        return true;
      }
      json(response, 405, { error: "GET, PATCH or DELETE" });
      return true;
    }

    if (!event) {
      json(response, 404, { error: "event not found" });
      return true;
    }

    if (action) {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return true;
      }
      // Cancelling and archiving a show are the host's business; opening the
      // doors, playing and coming back on are the band's.
      const account = action === "cancel" || action === "archive"
        ? await manage(request, response, options, event)
        : await perform(request, response, options, event);
      if (!account) return true;
      const input = await body(request);
      const target: Record<string, LiveEventStatus> = {
        doors: "starting",
        start: "live",
        encore: "encore",
        end: "ended",
        cancel: "cancelled",
        archive: "archived",
      };
      const updated = await options.events.transition(event.id, event.ownerId, target[action]!, requestedVersion(request, input));
      json(response, 200, view(updated, account, await ticketHeld(request, url, options, updated)));
      return true;
    }

    if (collection === "invitations") {
      const account = await manage(request, response, options, event);
      if (!account) return true;
      if (request.method === "GET" && !child) {
        json(response, 200, { invitations: await options.events.invitations(event.id, account.id) });
        return true;
      }
      if (request.method === "POST" && !child) {
        const input = await body(request);
        const invitation = await options.events.invite(event.id, account.id, input);
        const inviteUrl = `${(options.site ?? "").replace(/\/$/, "")}/live/${event.slug}?invite=${encodeURIComponent(invitation.token)}`;
        let sent = false;
        if (invitation.email && options.email) {
          sent = await options.email(invitation.email, {
            title: `You are invited to ${event.title}`,
            body: `You are invited as a ${invitation.role} to ${event.title}.`,
            url: inviteUrl,
          });
        }
        json(response, 201, { invitation, inviteUrl, sent });
        return true;
      }
      if (request.method === "DELETE" && child) {
        const revoked = await options.events.revoke(event.id, child, account.id);
        json(response, revoked ? 200 : 404, revoked ? { ok: true } : { error: "invitation not found" });
        return true;
      }
      json(response, 405, { error: "GET, POST or DELETE" });
      return true;
    }

    if (collection === "tickets") {
      // Reading the price is open: a stranger deciding whether to come has to
      // be told what it costs before they are asked for anything.
      if (request.method === "GET" && !child) {
        const account = await signedIn(request, options.accounts);
        const held = await ticketHeld(request, url, options, event);
        if (!options.tickets) {
          json(response, 200, {
            ticket: { ticketed: isTicketed(event), held: false, sales: false },
          });
          return true;
        }
        json(response, 200, {
          ticket: {
            ...options.tickets.offer(event),
            held,
            sales: options.tickets.enabled,
            required: needsTicket(event, account?.id, held),
          },
        });
        return true;
      }
      // The guest list. A host hands out a ticket nobody paid for, which is
      // the only way a venue can comp the press or make a refund good.
      if (request.method === "POST" && child === "comp") {
        if (!options.tickets) {
          json(response, 503, { error: "this deployment does not issue tickets" });
          return true;
        }
        const host = await manage(request, response, options, event);
        if (!host) return true;
        if (!isTicketed(event)) {
          json(response, 409, { error: "this event is free; no ticket is needed" });
          return true;
        }
        const input = await body(request);
        const minutes = Number(input["minutes"] ?? event.ticketMinutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600) {
          throw new LiveEventError("minutes must be between 1 and 525600", 422);
        }
        json(response, 201, { ticket: await options.tickets.mint(event, minutes), header: "x-nixamp-ticket" });
        return true;
      }
      if (request.method === "POST" && !child) {
        if (!options.tickets) {
          json(response, 503, { error: "this deployment does not sell tickets" });
          return true;
        }
        const site = (options.site ?? "https://nixamp.com").replace(/\/$/, "");
        const answer = await options.tickets.sell(event, toRequest(request, site));
        const buffer = Buffer.from(await answer.arrayBuffer());
        response.writeHead(answer.status, {
          ...CORS,
          ...Object.fromEntries(answer.headers),
          "content-length": String(buffer.byteLength),
          "cache-control": "no-store",
        });
        response.end(buffer);
        return true;
      }
      json(response, 405, { error: "GET or POST" });
      return true;
    }

    if (collection === "chat" && options.rooms) {
      const account = await eventAccess(request, response, url, options, event);
      if (account === false) return true;
      if (request.method === "GET" && !child) {
        json(response, 200, { messages: await options.rooms.chat(event.id, url.searchParams.get("after") ?? undefined) });
        return true;
      }
      if (request.method === "POST" && !child) {
        if (!event.chatEnabled) throw new RoomError("chat is off for this event", 409);
        if (!account) {
          json(response, 401, { error: "sign in to chat" });
          return true;
        }
        if (needsTicket(event, account.id, await ticketHeld(request, url, options, event))) {
          json(response, 402, { error: "the chat for this show is for ticket holders" });
          return true;
        }
        const input = await body(request);
        json(response, 201, { message: await options.rooms.post(event.id, account.id, accountName(account), input["body"]) });
        return true;
      }
      if (request.method === "DELETE" && child) {
        const moderator = await manage(request, response, options, event);
        if (!moderator) return true;
        const removed = await options.rooms.removeMessage(event.id, child);
        json(response, removed ? 200 : 404, removed ? { ok: true } : { error: "message not found" });
        return true;
      }
      json(response, 405, { error: "GET, POST or DELETE" });
      return true;
    }

    if (collection === "hand-raises" && options.rooms) {
      if (request.method === "POST" && !child) {
        if (!event.handRaiseEnabled) throw new RoomError("hand raising is off for this event", 409);
        const account = await eventAccess(request, response, url, options, event);
        if (account === false) return true;
        if (!account) {
          json(response, 401, { error: "sign in to raise your hand" });
          return true;
        }
        json(response, 200, { handRaise: await options.rooms.raiseHand(event.id, account.id, accountName(account)) });
        return true;
      }
      const account = await manage(request, response, options, event);
      if (!account) return true;
      if (request.method === "GET" && !child) {
        json(response, 200, { handRaises: await options.rooms.handRaises(event.id) });
        return true;
      }
      if (request.method === "PATCH" && child) {
        const input = await body(request);
        const state = input["state"];
        if (typeof state !== "string" || !HAND_RAISE_STATES.includes(state as (typeof HAND_RAISE_STATES)[number])) {
          throw new RoomError(`state must be one of ${HAND_RAISE_STATES.join(", ")}`, 422);
        }
        json(response, 200, { handRaise: await options.rooms.setHandRaise(event.id, child, state) });
        return true;
      }
      json(response, 405, { error: "GET, POST or PATCH" });
      return true;
    }

    json(response, 404, { error: "no such endpoint" });
    return true;
  } catch (error) {
    if (error instanceof LiveEventError || error instanceof LayoutError || error instanceof RoomError) {
      json(response, error.status, { error: error.message });
      return true;
    }
    json(response, 500, { error: "the live event service failed" });
    return true;
  }
}

export function liveApiPath(path: string): boolean {
  return path.startsWith("/api/v1/events") ||
    path.startsWith("/api/v1/invitations/") ||
    path.startsWith("/api/v1/layouts") ||
    path.startsWith("/api/v1/layout-presets");
}

export function invitationState(value: unknown): string | null {
  return typeof value === "string" && INVITATION_STATES.includes(value as (typeof INVITATION_STATES)[number])
    ? value
    : null;
}
