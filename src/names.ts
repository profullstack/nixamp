/**
 * An account's names: the servers it runs, each with a hostname under its handle.
 *
 * `server2.chovy.nixamp.com` used to be a record somebody typed into the
 * registrar by hand, which is why the second machine came up as a bare IP
 * over http. A name is now a row against the account, mirrored into the zone
 * as an A and an AAAA record, and the account may make, change and drop as
 * many as it reasonably needs without anybody holding a registrar key.
 *
 * The database row is the truth and the zone follows it: the zone is written
 * first, so a registrar that refuses is an error to the caller and nothing is
 * stored, rather than a row that claims a name the world cannot resolve.
 */
import type { Queryable } from "./follows.ts";
import { isReserved } from "./handles.ts";
import { isIPv4, isIPv6, type DnsZone } from "./dns.ts";

export interface NameRecord {
  label: string;
  host: string;
  a: string;
  aaaa: string;
  ttl: number;
  createdAt: number;
  updatedAt: number;
}

/** An error with the HTTP status it deserves, so a route can pass it straight on. */
export class NameError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Names nobody may give a server, over and above the handles nobody may take:
 * the mail and discovery names a client resolves on its own, anything an
 * underscore marks as a protocol record, and anything punycode-shaped.
 */
const RESERVED_LABELS = new Set([
  "www", "mail", "mx", "smtp", "imap", "pop", "ns1", "ns2", "ftp",
  "_dmarc", "_acme-challenge", "autoconfig", "autodiscover",
]);

/**
 * The label a server may have: two to thirty of [a-z0-9-], not starting or
 * ending with a hyphen, lowercased for the caller who typed it in capitals.
 * "" when it is not one, so a route can say so in one sentence.
 */
export function validLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const label = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/.test(label)) return "";
  if (label.startsWith("_") || label.startsWith("xn--")) return "";
  if (RESERVED_LABELS.has(label) || isReserved(label)) return "";
  return label;
}

const TABLE = "dns_names";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    account_id  TEXT NOT NULL,
    handle      TEXT NOT NULL,
    label       TEXT NOT NULL,
    a           TEXT NOT NULL DEFAULT '',
    aaaa        TEXT NOT NULL DEFAULT '',
    ttl         INTEGER NOT NULL DEFAULT 600,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (handle, label)
  );
  CREATE INDEX IF NOT EXISTS ${TABLE}_account ON ${TABLE} (account_id);
`;

export const MIN_TTL = 600;
export const MAX_TTL = 86_400;
/** Enough for a rack, not enough for a squatter. */
export const DEFAULT_PER_ACCOUNT = 20;

interface Row {
  account_id: string;
  handle: string;
  label: string;
  a: string;
  aaaa: string;
  ttl: number;
  created_at: unknown;
  updated_at: unknown;
}

function when(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(String(value ?? 0)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export class Names {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly dns: DnsZone,
    private readonly limits: { perAccount?: number } = {},
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  private host(handle: string, label: string): string {
    return `${label}.${handle}.${this.dns.zone}`;
  }

  private record(handle: string, row: Row): NameRecord {
    return {
      label: row.label,
      host: this.host(handle, row.label),
      a: row.a ?? "",
      aaaa: row.aaaa ?? "",
      ttl: Number(row.ttl) || MIN_TTL,
      createdAt: when(row.created_at),
      updatedAt: when(row.updated_at),
    };
  }

  async list(accountId: string, handle: string): Promise<NameRecord[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT account_id, handle, label, a, aaaa, ttl, created_at, updated_at
       FROM ${TABLE} WHERE account_id = $1 AND handle = $2 ORDER BY created_at`,
      [accountId, handle],
    );
    return (rows as unknown as Row[]).map((row) => this.record(handle, row));
  }

  /** The row for one name, whoever owns it. */
  private async find(handle: string, label: string): Promise<Row | null> {
    const { rows } = await this.db.query(
      `SELECT account_id, handle, label, a, aaaa, ttl, created_at, updated_at
       FROM ${TABLE} WHERE handle = $1 AND label = $2`,
      [handle, label],
    );
    return (rows[0] as unknown as Row | undefined) ?? null;
  }

  /**
   * Make or change a name. `null` for a family takes that record away,
   * `undefined` leaves it as it was, so a server that has only ever had an
   * IPv4 address can be given an IPv6 one without restating the first.
   */
  async set(
    accountId: string,
    handle: string,
    wanted: unknown,
    want: { a?: string | null; aaaa?: string | null; ttl?: number },
  ): Promise<NameRecord> {
    const label = validLabel(wanted);
    if (label === "") throw new NameError(400, "that is not a name a server can have");
    if (want.a !== undefined && want.a !== null && !isIPv4(want.a)) {
      throw new NameError(400, "that is not an IPv4 address");
    }
    if (want.aaaa !== undefined && want.aaaa !== null && !isIPv6(want.aaaa)) {
      throw new NameError(400, "that is not an IPv6 address");
    }
    await this.ensure();

    const existing = await this.find(handle, label);
    if (existing !== null && existing.account_id !== accountId) {
      throw new NameError(409, "that name belongs to somebody else");
    }
    if (existing === null) {
      const { rows } = await this.db.query(
        `SELECT count(*)::int AS n FROM ${TABLE} WHERE account_id = $1`,
        [accountId],
      );
      const have = Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
      const limit = this.limits.perAccount ?? DEFAULT_PER_ACCOUNT;
      if (have >= limit) throw new NameError(422, `an account may have ${limit} names, and this one has ${have}`);
    }

    // What the name will point at once this is done.
    const a = want.a === undefined ? (existing?.a ?? "") : (want.a ?? "");
    const aaaa = want.aaaa === undefined ? (existing?.aaaa ?? "") : (want.aaaa ?? "");
    if (a === "" && aaaa === "") throw new NameError(400, "give an address");
    const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, Math.floor(want.ttl ?? existing?.ttl ?? MIN_TTL)));

    // The zone first. A registrar that says no is the caller's problem to hear
    // about now, not a row that claims a name the world cannot resolve.
    const host = this.host(handle, label);
    try {
      if (a !== "") await this.dns.set(host, "A", a, ttl);
      else if (existing !== null && existing.a !== "") await this.dns.remove(host, "A");
      if (aaaa !== "") await this.dns.set(host, "AAAA", aaaa, ttl);
      else if (existing !== null && existing.aaaa !== "") await this.dns.remove(host, "AAAA");
    } catch (error) {
      throw new NameError(502, `the zone did not take that record: ${(error as Error).message}`);
    }

    const { rows } = await this.db.query(
      `INSERT INTO ${TABLE} (account_id, handle, label, a, aaaa, ttl)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (handle, label) DO UPDATE
         SET a = EXCLUDED.a, aaaa = EXCLUDED.aaaa, ttl = EXCLUDED.ttl, updated_at = now()
       RETURNING account_id, handle, label, a, aaaa, ttl, created_at, updated_at`,
      [accountId, handle, label, a, aaaa, ttl],
    );
    const row = rows[0] as unknown as Row | undefined;
    return this.record(handle, row ?? {
      account_id: accountId, handle, label, a, aaaa, ttl,
      created_at: existing?.created_at ?? new Date(), updated_at: new Date(),
    });
  }

  /** Take a name away. False when it is not this account's to take. */
  async remove(accountId: string, handle: string, wanted: unknown): Promise<boolean> {
    const label = validLabel(wanted);
    if (label === "") return false;
    await this.ensure();
    const existing = await this.find(handle, label);
    if (existing === null || existing.account_id !== accountId) return false;

    const host = this.host(handle, label);
    try {
      await this.dns.remove(host, "A");
      await this.dns.remove(host, "AAAA");
    } catch (error) {
      throw new NameError(502, `the zone did not let go of that record: ${(error as Error).message}`);
    }
    await this.db.query(`DELETE FROM ${TABLE} WHERE account_id = $1 AND handle = $2 AND label = $3`, [
      accountId, handle, label,
    ]);
    return true;
  }
}
