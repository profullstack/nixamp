import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "./follows.ts";

export const LIVE_EVENT_STATUSES = [
  "draft",
  "scheduled",
  // Doors open: the room is reachable, the show has not started.
  "starting",
  "live",
  // The set ended and the band came back. Its own state because a listener
  // arriving now is arriving at something, and "ended" would turn them away.
  "encore",
  "ended",
  "cancelled",
  "archived",
] as const;

export const LIVE_EVENT_VISIBILITIES = ["public", "unlisted", "private"] as const;

/**
 * What kind of live this is. NixAmp owns the room; the kind is what a branded
 * client reads to decide which layout, which words, and which panels. Nothing
 * here is named after a site: "concert" is a concert whoever is showing it.
 */
export const LIVE_EVENT_KINDS = ["talk", "class", "concert"] as const;

/**
 * `artist` sits beside moderator: somebody who performs rather than presides.
 * They go on stage and drive the show without being handed the guest list.
 */
export const INVITATION_ROLES = ["listener", "speaker", "artist", "moderator"] as const;
export const INVITATION_STATES = ["pending", "accepted", "declined", "revoked", "expired"] as const;

export type LiveEventStatus = (typeof LIVE_EVENT_STATUSES)[number];
export type LiveEventVisibility = (typeof LIVE_EVENT_VISIBILITIES)[number];
export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];
export type InvitationRole = (typeof INVITATION_ROLES)[number];
export type InvitationState = (typeof INVITATION_STATES)[number];

export interface LiveEvent {
  id: string;
  slug: string;
  ownerId: string;
  title: string;
  description?: string;
  topic?: string;
  kind: LiveEventKind;
  /** When the room opens, ahead of the music. Optional, and never after startsAt. */
  doorsOpenAt?: string;
  startsAt?: string;
  endsAt?: string;
  timezone: string;
  expectedDurationMinutes?: number;
  status: LiveEventStatus;
  visibility: LiveEventVisibility;
  roomId: string;
  inviteeIds: string[];
  speakerIds: string[];
  artistIds: string[];
  moderatorIds: string[];
  /** 0 is a free show. Above it, a ticket is a paid pass to this room. */
  ticketPriceCents: number;
  ticketCurrency: string;
  /** How long one ticket admits for. A day by default, which covers a replay. */
  ticketMinutes: number;
  /** Where the ticket money goes: the performer's address, not the platform's. */
  payTo?: string;
  chatEnabled: boolean;
  handRaiseEnabled: boolean;
  recordingEnabled: boolean;
  recordingId?: string;
  layoutId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventInvitation {
  id: string;
  eventId: string;
  inviterId: string;
  inviteeId?: string;
  email?: string;
  role: InvitationRole;
  state: InvitationState;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedInvitation extends EventInvitation {
  token: string;
}

export interface CreateLiveEventInput {
  title: unknown;
  description?: unknown;
  topic?: unknown;
  kind?: unknown;
  doorsOpenAt?: unknown;
  ticketPriceCents?: unknown;
  ticketCurrency?: unknown;
  ticketMinutes?: unknown;
  payTo?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  timezone?: unknown;
  expectedDurationMinutes?: unknown;
  visibility?: unknown;
  chatEnabled?: unknown;
  handRaiseEnabled?: unknown;
  recordingEnabled?: unknown;
  layoutId?: unknown;
}

export interface UpdateLiveEventInput extends Partial<CreateLiveEventInput> {
  version: unknown;
  status?: unknown;
  recordingId?: unknown;
}

export interface EventListQuery {
  ownerId?: string;
  status?: LiveEventStatus;
  kind?: LiveEventKind;
  topic?: string;
  from?: string;
  limit?: number;
}

export class LiveEventError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const EVENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS live_events (
    id                         TEXT PRIMARY KEY,
    slug                       TEXT NOT NULL UNIQUE,
    owner_id                   TEXT NOT NULL,
    title                      TEXT NOT NULL,
    description                TEXT NOT NULL DEFAULT '',
    topic                      TEXT NOT NULL DEFAULT '',
    kind                       TEXT NOT NULL DEFAULT 'talk',
    doors_open_at              TIMESTAMPTZ,
    ticket_price_cents         INTEGER NOT NULL DEFAULT 0,
    ticket_currency            TEXT NOT NULL DEFAULT 'USD',
    ticket_minutes             INTEGER NOT NULL DEFAULT 1440,
    pay_to                     TEXT,
    starts_at                  TIMESTAMPTZ,
    ends_at                    TIMESTAMPTZ,
    timezone                   TEXT NOT NULL DEFAULT 'UTC',
    expected_duration_minutes  INTEGER,
    status                     TEXT NOT NULL,
    visibility                 TEXT NOT NULL,
    room_id                    TEXT NOT NULL UNIQUE,
    chat_enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    hand_raise_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    recording_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
    recording_id               TEXT,
    layout_id                  TEXT,
    version                    INTEGER NOT NULL DEFAULT 1,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (visibility IN ('public', 'unlisted', 'private')),
    CHECK (ticket_price_cents >= 0),
    CHECK (ticket_minutes BETWEEN 1 AND 525600),
    CHECK (expected_duration_minutes IS NULL OR expected_duration_minutes BETWEEN 1 AND 1440),
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
  );
  CREATE INDEX IF NOT EXISTS live_events_discovery
    ON live_events (visibility, status, starts_at, updated_at DESC);
  CREATE INDEX IF NOT EXISTS live_events_owner
    ON live_events (owner_id, updated_at DESC);

  -- The repo has no migration runner, so a table that already exists is
  -- brought forward here. Every statement is idempotent, and the CHECKs are
  -- replaced by name rather than added twice: the originals were unnamed, so
  -- the ones carrying the old status list are found by what they say.
  -- The columns come before any index on them: nixamp.com had live_events
  -- from before 0.17.0, and an index on kind ahead of ADD COLUMN kind failed
  -- there while every fresh database (tests, CI) sailed through.
  ALTER TABLE live_events ADD COLUMN IF NOT EXISTS kind               TEXT    NOT NULL DEFAULT 'talk';
  ALTER TABLE live_events ADD COLUMN IF NOT EXISTS doors_open_at      TIMESTAMPTZ;
  ALTER TABLE live_events ADD COLUMN IF NOT EXISTS ticket_price_cents INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE live_events ADD COLUMN IF NOT EXISTS ticket_currency    TEXT    NOT NULL DEFAULT 'USD';
  ALTER TABLE live_events ADD COLUMN IF NOT EXISTS ticket_minutes     INTEGER NOT NULL DEFAULT 1440;
  ALTER TABLE live_events ADD COLUMN IF NOT EXISTS pay_to             TEXT;
  CREATE INDEX IF NOT EXISTS live_events_kind
    ON live_events (kind, status, starts_at);

  DO $$
  DECLARE stale record;
  BEGIN
    FOR stale IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'live_events'::regclass AND contype = 'c'
        AND conname <> 'live_events_status_allowed'
        AND pg_get_constraintdef(oid) LIKE '%archived%'
    LOOP
      EXECUTE format('ALTER TABLE live_events DROP CONSTRAINT %I', stale.conname);
    END LOOP;
    FOR stale IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'live_event_invitations'::regclass AND contype = 'c'
        AND conname <> 'live_event_invitations_role_allowed'
        AND pg_get_constraintdef(oid) LIKE '%moderator%'
    LOOP
      EXECUTE format('ALTER TABLE live_event_invitations DROP CONSTRAINT %I', stale.conname);
    END LOOP;
  END $$;

  ALTER TABLE live_events DROP CONSTRAINT IF EXISTS live_events_status_allowed;
  ALTER TABLE live_events ADD CONSTRAINT live_events_status_allowed
    CHECK (status IN ('draft', 'scheduled', 'starting', 'live', 'encore', 'ended', 'cancelled', 'archived'));
  ALTER TABLE live_events DROP CONSTRAINT IF EXISTS live_events_kind_allowed;
  ALTER TABLE live_events ADD CONSTRAINT live_events_kind_allowed
    CHECK (kind IN ('talk', 'class', 'concert'));

  CREATE TABLE IF NOT EXISTS live_event_invitations (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL REFERENCES live_events(id) ON DELETE CASCADE,
    inviter_id  TEXT NOT NULL,
    invitee_id  TEXT,
    email        TEXT,
    role         TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending',
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (state IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    CHECK (invitee_id IS NOT NULL OR email IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS live_event_invitations_event
    ON live_event_invitations (event_id, state, created_at);
  CREATE INDEX IF NOT EXISTS live_event_invitations_invitee
    ON live_event_invitations (invitee_id, state);

  ALTER TABLE live_event_invitations DROP CONSTRAINT IF EXISTS live_event_invitations_role_allowed;
  ALTER TABLE live_event_invitations ADD CONSTRAINT live_event_invitations_role_allowed
    CHECK (role IN ('listener', 'speaker', 'artist', 'moderator'));
`;

const SELECT_EVENT = `
  SELECT e.*,
    COALESCE((
      SELECT array_agg(DISTINCT i.invitee_id) FILTER (WHERE i.invitee_id IS NOT NULL)
      FROM live_event_invitations i
      WHERE i.event_id = e.id AND i.state IN ('pending', 'accepted')
    ), ARRAY[]::text[]) AS invitee_ids,
    COALESCE((
      SELECT array_agg(DISTINCT i.invitee_id) FILTER (WHERE i.invitee_id IS NOT NULL)
      FROM live_event_invitations i
      WHERE i.event_id = e.id AND i.state = 'accepted' AND i.role = 'speaker'
    ), ARRAY[]::text[]) AS speaker_ids,
    COALESCE((
      SELECT array_agg(DISTINCT i.invitee_id) FILTER (WHERE i.invitee_id IS NOT NULL)
      FROM live_event_invitations i
      WHERE i.event_id = e.id AND i.state = 'accepted' AND i.role = 'artist'
    ), ARRAY[]::text[]) AS artist_ids,
    COALESCE((
      SELECT array_agg(DISTINCT i.invitee_id) FILTER (WHERE i.invitee_id IS NOT NULL)
      FROM live_event_invitations i
      WHERE i.event_id = e.id AND i.state = 'accepted' AND i.role = 'moderator'
    ), ARRAY[]::text[]) AS moderator_ids
  FROM live_events e
`;

const TRANSITIONS: Record<LiveEventStatus, readonly LiveEventStatus[]> = {
  draft: ["scheduled", "starting", "live", "cancelled"],
  scheduled: ["draft", "starting", "live", "cancelled"],
  starting: ["live", "cancelled"],
  live: ["encore", "ended", "cancelled"],
  // An encore can go back on: a second one is still the same show.
  encore: ["live", "ended", "cancelled"],
  ended: ["archived"],
  cancelled: ["archived"],
  archived: [],
};

function text(value: unknown, name: string, limit: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new LiveEventError(`${name} is required`, 422);
    return "";
  }
  if (typeof value !== "string") throw new LiveEventError(`${name} must be text`, 422);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (required && cleaned === "") throw new LiveEventError(`${name} is required`, 422);
  if (cleaned.length > limit) throw new LiveEventError(`${name} is too long`, 422);
  return cleaned;
}

function timestamp(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new LiveEventError(`${name} must be an ISO timestamp`, 422);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new LiveEventError(`${name} must be an ISO timestamp`, 422);
  return date.toISOString();
}

function boolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new LiveEventError(`${name} must be true or false`, 422);
  return value;
}

function optionalInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new LiveEventError(`${name} must be between 1 and 1440`, 422);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
  name: string,
): T[number] {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new LiveEventError(`${name} must be one of ${allowed.join(", ")}`, 422);
  }
  return value as T[number];
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.startsWith("{")) {
    return value.slice(1, -1).split(",").filter(Boolean);
  }
  return [];
}

/** Whole cents, never negative, and nothing silly enough to be a typo. */
function cents(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new LiveEventError(`${name} must be a whole number of cents between 0 and 1000000`, 422);
  }
  return value;
}

function minutes(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 525_600) {
    throw new LiveEventError(`${name} must be between 1 and 525600`, 422);
  }
  return value;
}

/**
 * Where a ticket is paid to. An address that is not an address is refused
 * here rather than at the till, because a show whose money goes nowhere sells
 * tickets happily and only fails once somebody has paid.
 */
export function payToAddress(value: unknown, name = "payTo"): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new LiveEventError(`${name} must be an 0x EVM address`, 422);
  }
  return value.trim();
}

function eventFrom(row: Record<string, unknown>): LiveEvent {
  return {
    id: String(row["id"] ?? ""),
    slug: String(row["slug"] ?? ""),
    ownerId: String(row["owner_id"] ?? ""),
    title: String(row["title"] ?? ""),
    ...(row["description"] ? { description: String(row["description"]) } : {}),
    ...(row["topic"] ? { topic: String(row["topic"]) } : {}),
    kind: (LIVE_EVENT_KINDS.includes(String(row["kind"] ?? "talk") as LiveEventKind)
      ? String(row["kind"] ?? "talk")
      : "talk") as LiveEventKind,
    ...(iso(row["doors_open_at"]) ? { doorsOpenAt: iso(row["doors_open_at"]) } : {}),
    ...(iso(row["starts_at"]) ? { startsAt: iso(row["starts_at"]) } : {}),
    ...(iso(row["ends_at"]) ? { endsAt: iso(row["ends_at"]) } : {}),
    timezone: String(row["timezone"] ?? "UTC"),
    ...(row["expected_duration_minutes"] !== null && row["expected_duration_minutes"] !== undefined
      ? { expectedDurationMinutes: Number(row["expected_duration_minutes"]) }
      : {}),
    status: String(row["status"] ?? "draft") as LiveEventStatus,
    visibility: String(row["visibility"] ?? "private") as LiveEventVisibility,
    roomId: String(row["room_id"] ?? ""),
    inviteeIds: strings(row["invitee_ids"]),
    speakerIds: strings(row["speaker_ids"]),
    artistIds: strings(row["artist_ids"]),
    moderatorIds: strings(row["moderator_ids"]),
    ticketPriceCents: Number(row["ticket_price_cents"] ?? 0),
    ticketCurrency: String(row["ticket_currency"] ?? "USD"),
    ticketMinutes: Number(row["ticket_minutes"] ?? 1440),
    ...(row["pay_to"] ? { payTo: String(row["pay_to"]) } : {}),
    chatEnabled: Boolean(row["chat_enabled"]),
    handRaiseEnabled: Boolean(row["hand_raise_enabled"]),
    recordingEnabled: Boolean(row["recording_enabled"]),
    ...(row["recording_id"] ? { recordingId: String(row["recording_id"]) } : {}),
    ...(row["layout_id"] ? { layoutId: String(row["layout_id"]) } : {}),
    version: Number(row["version"] ?? 1),
    createdAt: iso(row["created_at"]) ?? new Date(0).toISOString(),
    updatedAt: iso(row["updated_at"]) ?? new Date(0).toISOString(),
  };
}

function invitationFrom(row: Record<string, unknown>): EventInvitation {
  return {
    id: String(row["id"] ?? ""),
    eventId: String(row["event_id"] ?? ""),
    inviterId: String(row["inviter_id"] ?? ""),
    ...(row["invitee_id"] ? { inviteeId: String(row["invitee_id"]) } : {}),
    ...(row["email"] ? { email: String(row["email"]) } : {}),
    role: String(row["role"] ?? "listener") as InvitationRole,
    state: String(row["state"] ?? "pending") as InvitationState,
    ...(iso(row["expires_at"]) ? { expiresAt: iso(row["expires_at"]) } : {}),
    createdAt: iso(row["created_at"]) ?? new Date(0).toISOString(),
    updatedAt: iso(row["updated_at"]) ?? new Date(0).toISOString(),
  };
}

export function eventSlug(value: unknown): string {
  if (typeof value !== "string") throw new LiveEventError("title must be text", 422);
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "live";
}

export function canTransition(from: LiveEventStatus, to: LiveEventStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function canManageEvent(event: LiveEvent, accountId: string | undefined): boolean {
  return Boolean(accountId && (event.ownerId === accountId || event.moderatorIds.includes(accountId)));
}

export function canPerformEvent(event: LiveEvent, accountId: string | undefined): boolean {
  return canManageEvent(event, accountId) || Boolean(accountId && event.artistIds.includes(accountId));
}

/** Whether the room itself is open: doors, the show, and the encore. */
export function isRoomOpen(event: LiveEvent): boolean {
  return event.status === "starting" || event.status === "live" || event.status === "encore";
}

/** Whether a ticket has to be bought before this room admits anybody. */
export function isTicketed(event: LiveEvent): boolean {
  return event.ticketPriceCents > 0 && Boolean(event.payTo);
}

/**
 * schema.org for one event.
 *
 * A concert is a MusicEvent with an Offer on it, because that is what a search
 * engine will show as a ticket price and a date. Everything else stays a plain
 * Event, which is what it was before concerts existed.
 */
export function eventStructuredData(event: LiveEvent, canonical: string): Record<string, unknown> {
  const status = event.status === "cancelled"
    ? "https://schema.org/EventCancelled"
    : event.status === "live" || event.status === "encore" || event.status === "starting"
      ? "https://schema.org/EventInProgress"
      : event.status === "ended" || event.status === "archived"
        ? "https://schema.org/EventCompleted"
        : "https://schema.org/EventScheduled";
  const description = event.description || `Listen to ${event.title} live.`;
  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": event.kind === "concert" ? "MusicEvent" : "Event",
    name: event.title,
    description,
    eventStatus: status,
    eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    ...(event.doorsOpenAt ? { doorTime: event.doorsOpenAt } : {}),
    ...(event.startsAt ? { startDate: event.startsAt } : {}),
    ...(event.endsAt ? { endDate: event.endsAt } : {}),
    url: canonical,
    location: { "@type": "VirtualLocation", url: canonical },
  };
  if (event.kind !== "concert") return base;
  return {
    ...base,
    ...(event.topic ? { performer: { "@type": "MusicGroup", name: event.topic } } : {}),
    offers: {
      "@type": "Offer",
      url: canonical,
      price: (event.ticketPriceCents / 100).toFixed(2),
      priceCurrency: event.ticketCurrency,
      availability: event.status === "cancelled" || event.status === "ended" || event.status === "archived"
        ? "https://schema.org/SoldOut"
        : "https://schema.org/InStock",
      category: isTicketed(event) ? "Ticket" : "Free",
    },
  };
}

export class LiveEvents {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    // A failed schema run is not remembered: the next request tries again
    // rather than answering 500 until the process restarts.
    this.ready ??= this.db.query(EVENT_SCHEMA).then(
      () => undefined,
      (error: unknown) => {
        this.ready = null;
        throw error;
      },
    );
    await this.ready;
  }

  async create(ownerId: string, input: CreateLiveEventInput): Promise<LiveEvent> {
    if (!ownerId) throw new LiveEventError("sign in to create an event", 401);
    const id = randomUUID();
    const title = text(input.title, "title", 160, true);
    const startsAt = timestamp(input.startsAt, "startsAt");
    const endsAt = timestamp(input.endsAt, "endsAt");
    const doorsOpenAt = timestamp(input.doorsOpenAt, "doorsOpenAt");
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new LiveEventError("endsAt must be after startsAt", 422);
    }
    if (doorsOpenAt && startsAt && doorsOpenAt > startsAt) {
      throw new LiveEventError("doorsOpenAt must be at or before startsAt", 422);
    }
    const ticketPriceCents = cents(input.ticketPriceCents, 0, "ticketPriceCents");
    const payTo = payToAddress(input.payTo);
    if (ticketPriceCents > 0 && !payTo) {
      throw new LiveEventError("a ticketed event needs a payTo address", 422);
    }
    const baseSlug = eventSlug(title);
    const values = [
      id,
      baseSlug,
      ownerId,
      title,
      text(input.description, "description", 5000),
      text(input.topic, "topic", 100),
      enumValue(input.kind, LIVE_EVENT_KINDS, "talk", "kind"),
      doorsOpenAt,
      ticketPriceCents,
      text(input.ticketCurrency ?? "USD", "ticketCurrency", 8, true).toUpperCase(),
      minutes(input.ticketMinutes, 1440, "ticketMinutes"),
      payTo,
      startsAt,
      endsAt,
      text(input.timezone ?? "UTC", "timezone", 100, true),
      optionalInteger(input.expectedDurationMinutes, "expectedDurationMinutes"),
      startsAt ? "scheduled" : "draft",
      enumValue(input.visibility, LIVE_EVENT_VISIBILITIES, "public", "visibility"),
      `event-${id.slice(0, 12)}`,
      boolean(input.chatEnabled, true, "chatEnabled"),
      boolean(input.handRaiseEnabled, true, "handRaiseEnabled"),
      boolean(input.recordingEnabled, false, "recordingEnabled"),
      text(input.layoutId, "layoutId", 100),
    ];
    await this.ensure();
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await this.db.query(
        `INSERT INTO live_events (
          id, slug, owner_id, title, description, topic, kind, doors_open_at,
          ticket_price_cents, ticket_currency, ticket_minutes, pay_to,
          starts_at, ends_at, timezone,
          expected_duration_minutes, status, visibility, room_id, chat_enabled,
          hand_raise_enabled, recording_enabled, layout_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULLIF($12, ''), $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, NULLIF($23, '')
        ) RETURNING *`,
        values,
      ));
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      values[1] = `${baseSlug}-${id.slice(0, 6)}`;
      ({ rows } = await this.db.query(
        `INSERT INTO live_events (
          id, slug, owner_id, title, description, topic, kind, doors_open_at,
          ticket_price_cents, ticket_currency, ticket_minutes, pay_to,
          starts_at, ends_at, timezone,
          expected_duration_minutes, status, visibility, room_id, chat_enabled,
          hand_raise_enabled, recording_enabled, layout_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULLIF($12, ''), $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, NULLIF($23, '')
        ) RETURNING *`,
        values,
      ));
    }
    const row = rows[0];
    if (!row) throw new LiveEventError("could not create the event", 500);
    return eventFrom({ ...row, invitee_ids: [], speaker_ids: [], artist_ids: [], moderator_ids: [] });
  }

  async list(query: EventListQuery = {}): Promise<LiveEvent[]> {
    await this.ensure();
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.ownerId) {
      values.push(query.ownerId);
      where.push(`e.owner_id = $${values.length}`);
    } else {
      where.push("e.visibility = 'public'");
      where.push("e.status <> 'archived'");
    }
    if (query.status) {
      values.push(query.status);
      where.push(`e.status = $${values.length}`);
    }
    if (query.kind) {
      values.push(query.kind);
      where.push(`e.kind = $${values.length}`);
    }
    if (query.topic) {
      values.push(query.topic);
      where.push(`lower(e.topic) = lower($${values.length})`);
    }
    if (query.from) {
      const from = timestamp(query.from, "from");
      values.push(from);
      where.push(`COALESCE(e.starts_at, e.updated_at) >= $${values.length}`);
    }
    const requestedLimit = Number.isFinite(query.limit) ? Math.floor(query.limit!) : 30;
    const limit = Math.min(100, Math.max(1, requestedLimit));
    values.push(limit);
    const { rows } = await this.db.query(
      `${SELECT_EVENT}
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE e.status
           WHEN 'live' THEN 0 WHEN 'encore' THEN 0 WHEN 'starting' THEN 1
           WHEN 'scheduled' THEN 2 ELSE 3 END,
         e.starts_at NULLS LAST, e.updated_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(eventFrom);
  }

  async get(reference: string): Promise<LiveEvent | null> {
    if (!reference) return null;
    await this.ensure();
    const { rows } = await this.db.query(
      `${SELECT_EVENT} WHERE e.id = $1 OR e.slug = $1 LIMIT 1`,
      [reference],
    );
    return rows[0] ? eventFrom(rows[0]) : null;
  }

  async byRoom(roomId: string): Promise<LiveEvent | null> {
    if (!roomId) return null;
    await this.ensure();
    const { rows } = await this.db.query(`${SELECT_EVENT} WHERE e.room_id = $1 LIMIT 1`, [roomId]);
    return rows[0] ? eventFrom(rows[0]) : null;
  }

  async canAccess(event: LiveEvent, accountId: string | undefined): Promise<boolean> {
    if (event.visibility !== "private") return true;
    if (!accountId) return false;
    if (event.ownerId === accountId || event.moderatorIds.includes(accountId)) return true;
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT 1 FROM live_event_invitations
       WHERE event_id = $1 AND invitee_id = $2 AND state = 'accepted' LIMIT 1`,
      [event.id, accountId],
    );
    return rows.length > 0;
  }

  async invitationAllows(eventId: string, token: string): Promise<boolean> {
    if (!eventId || !token) return false;
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT 1 FROM live_event_invitations
       WHERE event_id = $1 AND token_hash = $2
         AND state IN ('pending', 'accepted')
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [eventId, hashToken(token)],
    );
    return rows.length > 0;
  }

  canManage(event: LiveEvent, accountId: string | undefined): boolean {
    return canManageEvent(event, accountId);
  }

  /**
   * Who may put sound on this stage. The owner, a moderator, and an invited
   * artist who accepted: performing and presiding are different jobs, and a
   * support act should not need the guest list to play.
   */
  canPerform(event: LiveEvent, accountId: string | undefined): boolean {
    return canPerformEvent(event, accountId);
  }

  async update(reference: string, ownerId: string, input: UpdateLiveEventInput): Promise<LiveEvent> {
    const current = await this.get(reference);
    if (!current) throw new LiveEventError("event not found", 404);
    if (current.ownerId !== ownerId) throw new LiveEventError("only the event owner can change it", 403);
    if (!Number.isInteger(input.version) || Number(input.version) < 1) {
      throw new LiveEventError("version is required", 428);
    }
    if (Number(input.version) !== current.version) {
      throw new LiveEventError("the event changed; reload it and try again", 409);
    }

    const title = input.title === undefined ? current.title : text(input.title, "title", 160, true);
    const startsAt = input.startsAt === undefined ? current.startsAt ?? null : timestamp(input.startsAt, "startsAt");
    const endsAt = input.endsAt === undefined ? current.endsAt ?? null : timestamp(input.endsAt, "endsAt");
    const doorsOpenAt = input.doorsOpenAt === undefined
      ? current.doorsOpenAt ?? null
      : timestamp(input.doorsOpenAt, "doorsOpenAt");
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new LiveEventError("endsAt must be after startsAt", 422);
    }
    if (doorsOpenAt && startsAt && doorsOpenAt > startsAt) {
      throw new LiveEventError("doorsOpenAt must be at or before startsAt", 422);
    }
    const ticketPriceCents = cents(input.ticketPriceCents, current.ticketPriceCents, "ticketPriceCents");
    const payTo = input.payTo === undefined ? current.payTo ?? "" : payToAddress(input.payTo);
    if (ticketPriceCents > 0 && !payTo) {
      throw new LiveEventError("a ticketed event needs a payTo address", 422);
    }
    const nextStatus = enumValue(input.status, LIVE_EVENT_STATUSES, current.status, "status");
    if (!canTransition(current.status, nextStatus)) {
      throw new LiveEventError(`an event cannot move from ${current.status} to ${nextStatus}`, 409);
    }
    if (nextStatus === "scheduled" && !startsAt) {
      throw new LiveEventError("a scheduled event needs startsAt", 422);
    }

    const { rows } = await this.db.query(
      `UPDATE live_events SET
        title = $4,
        description = $5,
        topic = $6,
        starts_at = $7,
        ends_at = $8,
        timezone = $9,
        expected_duration_minutes = $10,
        status = $11,
        visibility = $12,
        chat_enabled = $13,
        hand_raise_enabled = $14,
        recording_enabled = $15,
        recording_id = $16,
        layout_id = $17,
        kind = $18,
        doors_open_at = $19,
        ticket_price_cents = $20,
        ticket_currency = $21,
        ticket_minutes = $22,
        pay_to = NULLIF($23, ''),
        version = version + 1,
        updated_at = now()
       WHERE (id = $1 OR slug = $1) AND owner_id = $2 AND version = $3
       RETURNING *`,
      [
        reference,
        ownerId,
        current.version,
        title,
        input.description === undefined ? current.description ?? "" : text(input.description, "description", 5000),
        input.topic === undefined ? current.topic ?? "" : text(input.topic, "topic", 100),
        startsAt,
        endsAt,
        input.timezone === undefined ? current.timezone : text(input.timezone, "timezone", 100, true),
        input.expectedDurationMinutes === undefined
          ? current.expectedDurationMinutes ?? null
          : optionalInteger(input.expectedDurationMinutes, "expectedDurationMinutes"),
        nextStatus,
        enumValue(input.visibility, LIVE_EVENT_VISIBILITIES, current.visibility, "visibility"),
        boolean(input.chatEnabled, current.chatEnabled, "chatEnabled"),
        boolean(input.handRaiseEnabled, current.handRaiseEnabled, "handRaiseEnabled"),
        boolean(input.recordingEnabled, current.recordingEnabled, "recordingEnabled"),
        input.recordingId === undefined ? current.recordingId ?? null : text(input.recordingId, "recordingId", 160) || null,
        input.layoutId === undefined ? current.layoutId ?? null : text(input.layoutId, "layoutId", 100) || null,
        enumValue(input.kind, LIVE_EVENT_KINDS, current.kind, "kind"),
        doorsOpenAt,
        ticketPriceCents,
        input.ticketCurrency === undefined
          ? current.ticketCurrency
          : text(input.ticketCurrency, "ticketCurrency", 8, true).toUpperCase(),
        minutes(input.ticketMinutes, current.ticketMinutes, "ticketMinutes"),
        payTo,
      ],
    );
    const row = rows[0];
    if (!row) throw new LiveEventError("the event changed; reload it and try again", 409);
    return eventFrom({
      ...row,
      invitee_ids: current.inviteeIds,
      speaker_ids: current.speakerIds,
      artist_ids: current.artistIds,
      moderator_ids: current.moderatorIds,
    });
  }

  async transition(reference: string, ownerId: string, status: LiveEventStatus, version: number): Promise<LiveEvent> {
    return this.update(reference, ownerId, { version, status });
  }

  async remove(reference: string, ownerId: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(
      `DELETE FROM live_events WHERE (id = $1 OR slug = $1) AND owner_id = $2 RETURNING id`,
      [reference, ownerId],
    );
    return rows.length > 0;
  }

  async invite(
    eventId: string,
    inviterId: string,
    input: { inviteeId?: unknown; email?: unknown; role?: unknown; expiresAt?: unknown },
  ): Promise<CreatedInvitation> {
    const event = await this.get(eventId);
    if (!event) throw new LiveEventError("event not found", 404);
    if (!this.canManage(event, inviterId)) throw new LiveEventError("only hosts and moderators can invite", 403);
    const inviteeId = text(input.inviteeId, "inviteeId", 160);
    const email = text(input.email, "email", 320).toLowerCase();
    if (!inviteeId && !email) throw new LiveEventError("give an inviteeId or email", 422);
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      throw new LiveEventError("that does not look like an email address", 422);
    }
    const role = enumValue(input.role, INVITATION_ROLES, "listener", "role");
    const expiresAt = timestamp(input.expiresAt, "expiresAt");
    const token = randomBytes(24).toString("base64url");
    const id = randomUUID();
    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO live_event_invitations (
        id, event_id, inviter_id, invitee_id, email, role, token_hash, expires_at
       ) VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7, $8)
       RETURNING *`,
      [id, event.id, inviterId, inviteeId, email, role, hashToken(token), expiresAt],
    );
    const row = rows[0];
    if (!row) throw new LiveEventError("could not create the invitation", 500);
    return { ...invitationFrom(row), token };
  }

  async invitations(eventId: string, accountId: string): Promise<EventInvitation[]> {
    const event = await this.get(eventId);
    if (!event) throw new LiveEventError("event not found", 404);
    if (!this.canManage(event, accountId)) throw new LiveEventError("only hosts and moderators can see invitations", 403);
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT * FROM live_event_invitations WHERE event_id = $1 ORDER BY created_at DESC`,
      [event.id],
    );
    return rows.map(invitationFrom);
  }

  async respond(token: string, accountId: string, state: "accepted" | "declined"): Promise<EventInvitation> {
    if (!token) throw new LiveEventError("invitation not found", 404);
    await this.ensure();
    const { rows } = await this.db.query(
      `UPDATE live_event_invitations SET
         state = $3,
         invitee_id = COALESCE(invitee_id, NULLIF($2, '')),
         updated_at = now()
       WHERE token_hash = $1 AND state = 'pending'
         AND (expires_at IS NULL OR expires_at > now())
       RETURNING *`,
      [hashToken(token), accountId, state],
    );
    const row = rows[0];
    if (!row) throw new LiveEventError("that invitation is invalid or expired", 410);
    return invitationFrom(row);
  }

  async revoke(eventId: string, invitationId: string, accountId: string): Promise<boolean> {
    const event = await this.get(eventId);
    if (!event) throw new LiveEventError("event not found", 404);
    if (!this.canManage(event, accountId)) throw new LiveEventError("only hosts and moderators can revoke invitations", 403);
    await this.ensure();
    const { rows } = await this.db.query(
      `UPDATE live_event_invitations SET state = 'revoked', updated_at = now()
       WHERE id = $1 AND event_id = $2 AND state = 'pending' RETURNING id`,
      [invitationId, event.id],
    );
    return rows.length > 0;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
