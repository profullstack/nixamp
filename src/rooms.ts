import { randomUUID } from "node:crypto";
import type { Queryable } from "./follows.ts";

export const ROOM_ROLES = ["listener", "speaker", "moderator", "host"] as const;
export const HAND_RAISE_STATES = ["raised", "invited", "dismissed", "returned"] as const;

export type RoomRole = (typeof ROOM_ROLES)[number];
export type HandRaiseState = (typeof HAND_RAISE_STATES)[number];

export interface ChatMessage {
  id: string;
  eventId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  deletedAt?: string;
}

export interface HandRaise {
  eventId: string;
  accountId: string;
  displayName: string;
  state: HandRaiseState;
  raisedAt: string;
  updatedAt: string;
}

export class RoomError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const ROOM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS live_event_chat (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES live_events(id) ON DELETE CASCADE,
    author_id    TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS live_event_chat_timeline
    ON live_event_chat (event_id, created_at, id);

  CREATE TABLE IF NOT EXISTS live_event_hand_raises (
    event_id     TEXT NOT NULL REFERENCES live_events(id) ON DELETE CASCADE,
    account_id   TEXT NOT NULL,
    display_name TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'raised',
    raised_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, account_id),
    CHECK (state IN ('raised', 'invited', 'dismissed', 'returned'))
  );
  CREATE INDEX IF NOT EXISTS live_event_hand_raises_queue
    ON live_event_hand_raises (event_id, state, raised_at);
`;

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function messageFrom(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row["id"] ?? ""),
    eventId: String(row["event_id"] ?? ""),
    authorId: String(row["author_id"] ?? ""),
    authorName: String(row["author_name"] ?? "Someone"),
    body: String(row["body"] ?? ""),
    createdAt: timestamp(row["created_at"]),
    ...(row["deleted_at"] ? { deletedAt: timestamp(row["deleted_at"]) } : {}),
  };
}

function handRaiseFrom(row: Record<string, unknown>): HandRaise {
  return {
    eventId: String(row["event_id"] ?? ""),
    accountId: String(row["account_id"] ?? ""),
    displayName: String(row["display_name"] ?? "Someone"),
    state: String(row["state"] ?? "raised") as HandRaiseState,
    raisedAt: timestamp(row["raised_at"]),
    updatedAt: timestamp(row["updated_at"]),
  };
}

function clean(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string") throw new RoomError(`${name} must be text`, 422);
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!result) throw new RoomError(`${name} is required`, 422);
  if (result.length > limit) throw new RoomError(`${name} is too long`, 422);
  return result;
}

export class Rooms {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(ROOM_SCHEMA).then(() => undefined);
    await this.ready;
  }

  async chat(eventId: string, after?: string, limit = 100): Promise<ChatMessage[]> {
    await this.ensure();
    const count = Math.min(200, Math.max(1, Math.floor(limit)));
    const { rows } = await this.db.query(
      `SELECT * FROM live_event_chat
       WHERE event_id = $1 AND deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
       ORDER BY created_at, id LIMIT $3`,
      [eventId, after || null, count],
    );
    return rows.map(messageFrom);
  }

  async post(eventId: string, authorId: string, authorName: string, body: unknown): Promise<ChatMessage> {
    if (!authorId) throw new RoomError("sign in to chat", 401);
    const safeBody = clean(body, "message", 1000);
    const safeName = clean(authorName || "Someone", "author name", 100);
    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO live_event_chat (id, event_id, author_id, author_name, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), eventId, authorId, safeName, safeBody],
    );
    const row = rows[0];
    if (!row) throw new RoomError("could not send the message", 500);
    return messageFrom(row);
  }

  async removeMessage(eventId: string, messageId: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(
      `UPDATE live_event_chat SET deleted_at = now()
       WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL RETURNING id`,
      [messageId, eventId],
    );
    return rows.length > 0;
  }

  async raiseHand(eventId: string, accountId: string, displayName: string): Promise<HandRaise> {
    if (!accountId) throw new RoomError("sign in to raise your hand", 401);
    const safeName = clean(displayName || "Someone", "display name", 100);
    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO live_event_hand_raises (event_id, account_id, display_name, state)
       VALUES ($1, $2, $3, 'raised')
       ON CONFLICT (event_id, account_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         state = 'raised',
         raised_at = now(),
         updated_at = now()
       RETURNING *`,
      [eventId, accountId, safeName],
    );
    const row = rows[0];
    if (!row) throw new RoomError("could not raise your hand", 500);
    return handRaiseFrom(row);
  }

  async handRaises(eventId: string): Promise<HandRaise[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT * FROM live_event_hand_raises
       WHERE event_id = $1 AND state IN ('raised', 'invited')
       ORDER BY CASE state WHEN 'raised' THEN 0 ELSE 1 END, raised_at`,
      [eventId],
    );
    return rows.map(handRaiseFrom);
  }

  async setHandRaise(eventId: string, accountId: string, state: unknown): Promise<HandRaise> {
    if (typeof state !== "string" || !HAND_RAISE_STATES.includes(state as HandRaiseState)) {
      throw new RoomError(`state must be one of ${HAND_RAISE_STATES.join(", ")}`, 422);
    }
    await this.ensure();
    const { rows } = await this.db.query(
      `UPDATE live_event_hand_raises SET state = $3, updated_at = now()
       WHERE event_id = $1 AND account_id = $2 RETURNING *`,
      [eventId, accountId, state],
    );
    const row = rows[0];
    if (!row) throw new RoomError("hand raise not found", 404);
    return handRaiseFrom(row);
  }
}
