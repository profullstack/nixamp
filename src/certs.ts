/**
 * Certificates: one wildcard per handle, issued and renewed by nixamp.com.
 *
 * A server that has been given `server2.chovy.nixamp.com` still answers over
 * plain http until it has a certificate, and getting one by hand is exactly
 * the manual step this exists to remove. So nixamp.com, which already holds
 * the zone, does the whole thing: it orders `*.chovy.nixamp.com` and
 * `chovy.nixamp.com` from Let's Encrypt, answers the DNS-01 challenge by
 * writing the `_acme-challenge` TXT record itself, keeps the result in the
 * database, renews it when it gets close to expiry, and hands cert and key
 * to that account's servers over the authenticated API.
 *
 * One wildcard per handle, not one certificate per server. Let's Encrypt
 * rate-limits per registered domain -- nixamp.com, for all of us -- and every
 * server an account starts is covered by the wildcard it already has.
 *
 * The ACME dance takes minutes, mostly waiting for DNS to propagate, so it is
 * never done inside a request. `forHandle` starts it in the background and
 * answers "issuing"; the server asks again in a while.
 */
import acme from "acme-client";
import type { DnsZone } from "./dns.ts";
import type { Queryable } from "./follows.ts";

export interface Issued {
  /** PEM, the full chain. */
  cert: string;
  /** PEM. */
  key: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Where a DNS-01 challenge gets written, and unwritten. */
export interface Challenge {
  set(host: string, value: string): Promise<void>;
  clear(host: string, value: string): Promise<void>;
}

/** Something that turns a list of names into a certificate. ACME, in production. */
export interface Issuer {
  issue(names: string[], challenge: Challenge): Promise<Issued>;
}

export interface AcmeIssuerOptions {
  /** acme.directory.letsencrypt.production, or .staging while trying things out. */
  directoryUrl: string;
  /** The account contact Let's Encrypt writes to about expiry. */
  email: string;
  /** The account's private key, PEM. Kept by the caller; see Certs.accountKey. */
  accountKey: () => Promise<string>;
  /**
   * How long to wait after writing the TXT before letting the CA look for it.
   * A registrar's API answers at once; the world's resolvers do not.
   */
  propagationMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A minute is what Porkbun's 600-second floor tends to cost in practice. */
export const DEFAULT_PROPAGATION_MS = 60_000;
/** Renew inside the last thirty days, which is what Let's Encrypt recommends. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
/** A failed order is worth trying again, but not every time somebody asks. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Let's Encrypt, through acme-client, by DNS-01 only: a wildcard cannot be
 * proved any other way, and the zone is the one thing nixamp.com does hold.
 */
export class AcmeIssuer implements Issuer {
  constructor(private readonly options: AcmeIssuerOptions) {}

  async issue(names: string[], challenge: Challenge): Promise<Issued> {
    const [first, ...rest] = names;
    if (!first) throw new Error("nothing to issue a certificate for");
    const propagationMs = this.options.propagationMs ?? DEFAULT_PROPAGATION_MS;
    const sleep = this.options.sleep ?? wait;

    const client = new acme.Client({
      directoryUrl: this.options.directoryUrl,
      accountKey: await this.options.accountKey(),
    });
    // A fresh key per certificate. Reusing the account key for the
    // certificate would make one leak two.
    const [key, csr] = await acme.crypto.createCsr({ commonName: first, altNames: [first, ...rest] });

    const cert = await client.auto({
      csr,
      email: this.options.email,
      termsOfServiceAgreed: true,
      challengePriority: ["dns-01"],
      // acme-client would otherwise resolve the TXT itself before telling the
      // CA to, and from wherever nixamp.com runs that lookup can lag the CA's.
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
        await challenge.set(`_acme-challenge.${authz.identifier.value}`, keyAuthorization);
        await sleep(propagationMs);
      },
      challengeRemoveFn: async (authz, _challenge, keyAuthorization) => {
        await challenge.clear(`_acme-challenge.${authz.identifier.value}`, keyAuthorization);
      },
    });

    const info = acme.crypto.readCertificateInfo(cert);
    return { cert, key: key.toString(), expiresAt: info.notAfter.getTime() };
  }
}

export type CertState =
  | { status: "ready"; cert: string; key: string; expiresAt: number; renewing: boolean }
  | { status: "issuing"; since: number }
  | { status: "failed"; error: string; at: number }
  | { status: "none" };

export interface CertsOptions {
  renewBeforeMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS certs (
    handle      TEXT PRIMARY KEY,
    cert        TEXT NOT NULL,
    key         TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS acme_account (
    id       INTEGER PRIMARY KEY,
    key_pem  TEXT NOT NULL
  );
`;

interface Stored {
  cert: string;
  key: string;
  expiresAt: number;
}

/** What is happening to a handle's certificate right now, in this process. */
type Work =
  | { kind: "issuing"; since: number; done: Promise<void> }
  | { kind: "failed"; error: string; at: number };

/**
 * The certificates, one per handle, and the work of getting them.
 *
 * The rows are the truth and survive a restart; what is in flight lives in
 * memory, because nixamp.com is one process and an order interrupted by a
 * deploy is simply started again when next asked for.
 */
export class Certs {
  private ready: Promise<void> | null = null;
  private readonly work = new Map<string, Work>();
  private readonly renewBeforeMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly db: Queryable,
    private readonly zone: DnsZone,
    private readonly issuer: Issuer,
    options: CertsOptions = {},
  ) {
    this.renewBeforeMs = options.renewBeforeMs ?? RENEW_BEFORE_MS;
    this.retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  /**
   * The ACME account key, made once and kept. Losing it would not lose any
   * certificate, but every renewal would register a new account, and Let's
   * Encrypt rate-limits those too.
   */
  async accountKey(): Promise<string> {
    await this.ensure();
    const { rows } = await this.db.query("SELECT key_pem FROM acme_account WHERE id = 1");
    const kept = rows[0]?.["key_pem"];
    if (typeof kept === "string" && kept !== "") return kept;
    const made = (await acme.crypto.createPrivateKey()).toString();
    await this.db.query(
      "INSERT INTO acme_account (id, key_pem) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [made],
    );
    // Somebody else may have won the race to insert; theirs is the account now.
    const again = await this.db.query("SELECT key_pem FROM acme_account WHERE id = 1");
    const winner = again.rows[0]?.["key_pem"];
    return typeof winner === "string" && winner !== "" ? winner : made;
  }

  /** The names one handle's certificate covers: every server it has, and the handle itself. */
  namesFor(handle: string): string[] {
    return [`*.${handle}.${this.zone.zone}`, `${handle}.${this.zone.zone}`];
  }

  private async stored(handle: string): Promise<Stored | null> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT cert, key, expires_at FROM certs WHERE handle = $1",
      [handle],
    );
    const row = rows[0];
    if (!row) return null;
    const cert = row["cert"];
    const key = row["key"];
    const expires = row["expires_at"];
    if (typeof cert !== "string" || typeof key !== "string") return null;
    const expiresAt = expires instanceof Date ? expires.getTime() : new Date(String(expires)).getTime();
    if (!Number.isFinite(expiresAt)) return null;
    return { cert, key, expiresAt };
  }

  /**
   * A handle's certificate, or what is being done about the lack of one.
   *
   * Never blocks on the CA. With nothing stored, or something failed long
   * enough ago to be worth another go, an order starts in the background and
   * the answer is "issuing". With one stored that is near its end, the answer
   * is still the old one -- it is valid -- and a renewal starts alongside.
   */
  async forHandle(handle: string): Promise<CertState> {
    const kept = await this.stored(handle);
    const inFlight = this.work.get(handle);

    if (kept && kept.expiresAt > this.now()) {
      const renewing = kept.expiresAt - this.now() < this.renewBeforeMs;
      if (renewing && !(inFlight?.kind === "issuing")) this.begin(handle, "renewal");
      return {
        status: "ready",
        cert: kept.cert,
        key: kept.key,
        expiresAt: kept.expiresAt,
        renewing: renewing || inFlight?.kind === "issuing",
      };
    }

    if (inFlight?.kind === "issuing") return { status: "issuing", since: inFlight.since };
    if (inFlight?.kind === "failed" && this.now() - inFlight.at < this.retryAfterMs) {
      return { status: "failed", error: inFlight.error, at: inFlight.at };
    }
    const started = this.begin(handle, kept ? "replacement of an expired certificate" : "first certificate");
    return { status: "issuing", since: started.since };
  }

  /** Order in the background, and remember how it went. */
  private begin(handle: string, why: string): { since: number } {
    const since = this.now();
    const names = this.namesFor(handle);
    this.log(`  Ordering a certificate for ${names.join(" and ")} (${why}).`);
    const done = this.issuer
      .issue(names, {
        set: (host, value) => this.zone.add(host, "TXT", value, 600),
        clear: (host, value) => this.zone.remove(host, "TXT", value),
      })
      .then(async (issued) => {
        await this.ensure();
        await this.db.query(
          `INSERT INTO certs (handle, cert, key, expires_at, issued_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (handle) DO UPDATE SET cert = EXCLUDED.cert, key = EXCLUDED.key,
             expires_at = EXCLUDED.expires_at, issued_at = now()`,
          [handle, issued.cert, issued.key, new Date(issued.expiresAt).toISOString()],
        );
        const days = Math.max(0, Math.round((issued.expiresAt - this.now()) / (24 * 60 * 60 * 1000)));
        this.log(`  Certificate for *.${handle}.${this.zone.zone} issued, good for ${days} days.`);
        this.work.delete(handle);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`  Certificate for *.${handle}.${this.zone.zone} failed: ${message}`);
        this.work.set(handle, { kind: "failed", error: message, at: this.now() });
      });
    const work: Work = { kind: "issuing", since, done };
    this.work.set(handle, work);
    return work;
  }

  /** For tests and shutdown: whatever order is in flight for a handle. */
  async settle(handle: string): Promise<void> {
    const inFlight = this.work.get(handle);
    if (inFlight?.kind === "issuing") await inFlight.done;
  }
}
