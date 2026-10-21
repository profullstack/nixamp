/**
 * Licences to use the AI label's music in somebody's own work: a game, an
 * app, a video, a podcast. A download (music-store.ts) is for listening; a
 * licence is permission to put the music in a project and publish it.
 *
 *   Creator     a song, $5     online videos, streams, podcasts, social posts, monetized or not
 *   Indie       a song, $25    all of Creator, plus games, apps, sites, software and films,
 *               an album, $100 for a licensee under US$100,000 of revenue a year
 *   Commercial  a song, $250   any use in the licensee's own products and ads, any size
 *   Catalog     $29 a year     Indie, for every artist the label releases, unlimited projects
 *
 * Every licence is worldwide, non-exclusive and for good (the catalogue pass:
 * for every project published while it is active), and every use credits the
 * artist with a link to their page. The terms are TERMS below (license-routes.ts
 * serves them at /license/terms); each licence records the version it was sold
 * under. Paid through nixamp.com's CoinPay business like the store.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Db, Support } from "./support.ts";
import { SupportError, coinOf } from "./support.ts";
import type { MusicStore } from "./music-store.ts";

export type Tier = "creator" | "indie" | "commercial" | "catalog";
export type LicenseKind = "song" | "album" | "catalog";

/** In cents, by tier and what is licensed; a missing pair is not sold. */
export const LICENSE_PRICES: Record<Tier, Partial<Record<LicenseKind, number>>> = {
  creator: { song: 500 },
  indie: { song: 2500, album: 10000 },
  commercial: { song: 25000 },
  catalog: { catalog: 2900 },
};

export const TIER_NAMES: Record<Tier, string> = { creator: "Creator", indie: "Indie", commercial: "Commercial", catalog: "Catalog pass" };

/** What each tier lets a licensee do, in a line. */
export const TIER_USE: Record<Tier, string> = {
  creator: "Online videos, livestreams, podcasts and social posts, monetized or not. Not games, apps, ads or broadcast.",
  indie: "Everything in Creator, plus games, apps, websites, software and films, for a licensee earning under US$100,000 a year.",
  commercial: "Any use in your own products, games, apps, films and advertising, broadcast included, at any size.",
  catalog: "The Indie licence for every song by every artist the label releases, for any number of projects published while the pass is active.",
};

export const TERMS_VERSION = "1";
const YEAR_MS = 365 * 24 * 3600_000;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const CODE = /^NXL-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export interface License {
  id: string;
  /** What the certificate and the public check go by: NXL-XXXX-XXXX. */
  code: string;
  token: string;
  email: string;
  userId: string;
  licensee: string;
  project: string;
  projectUrl: string;
  tier: Tier;
  kind: LicenseKind;
  server: string;
  artist: string;
  album: string;
  n: number;
  title: string;
  artistName: string;
  /** Where the credit links: the artist's page, or the label's for the catalogue pass. */
  creditUrl: string;
  amountCents: number;
  coin: string;
  paymentId: string;
  status: "pending" | "paid";
  terms: string;
  createdAt: number;
  paidAt: number;
  /** The catalogue pass only: when new projects stop being covered. 0 is never. */
  expiresAt: number;
}

/** A licence code: unambiguous letters and digits, for reading out or typing in. */
function newCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((one) => alphabet[one % alphabet.length]).join("");
  return `NXL-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function httpsUrl(value: unknown): string {
  const text = clean(value, 300);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function row(one: Record<string, unknown>): License {
  const time = (value: unknown): number => (value ? new Date(String(value)).getTime() : 0);
  return {
    id: String(one["id"]), code: String(one["code"]), token: String(one["token"]), email: String(one["email"]), userId: String(one["user_id"] ?? ""),
    licensee: String(one["licensee"]), project: String(one["project"]), projectUrl: String(one["project_url"] ?? ""),
    tier: String(one["tier"]) as Tier, kind: String(one["kind"]) as LicenseKind, server: String(one["server"] ?? ""), artist: String(one["artist"] ?? ""),
    album: String(one["album"] ?? ""), n: Number(one["n"] ?? 0), title: String(one["title"]), artistName: String(one["artist_name"]), creditUrl: String(one["credit_url"]),
    amountCents: Number(one["amount_cents"]), coin: String(one["coin"]), paymentId: String(one["payment_id"] ?? ""),
    status: one["status"] === "paid" ? "paid" : "pending", terms: String(one["terms"]), createdAt: time(one["created_at"]), paidAt: time(one["paid_at"]), expiresAt: time(one["expires_at"]),
  };
}

export interface MusicLicensesOptions {
  db: Db;
  support: Support;
  /** The store: what a song or album is, from the server that holds it. */
  store: Pick<MusicStore, "describe">;
  mail: { apiKey: string; from: string } | null;
  /** https://nixamp.com */
  site: string;
  /** Who licenses: the label's holder. */
  holder?: string;
  /** The opaque id a server goes by in nixamp.com's addresses (music-hub.ts serverId). */
  serverId: (base: string) => string;
  fetcher?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Quote {
  tier: Tier;
  kind: LicenseKind;
  server: string;
  artist: string;
  album: string;
  n: number;
  title: string;
  artistName: string;
  creditUrl: string;
  amountCents: number;
}

export class MusicLicenses {
  private schema: Promise<void> | null = null;

  constructor(private readonly options: MusicLicensesOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get holder(): string {
    return this.options.holder ?? "Profullstack, Inc.";
  }

  private ready(): Promise<void> {
    this.schema ??= (async () => {
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS music_licenses (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, token TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
        licensee TEXT NOT NULL, project TEXT NOT NULL, project_url TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL, kind TEXT NOT NULL, server TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL, artist_name TEXT NOT NULL, credit_url TEXT NOT NULL, amount_cents INTEGER NOT NULL, coin TEXT NOT NULL,
        payment_id TEXT, status TEXT NOT NULL DEFAULT 'pending', terms TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, paid_at TIMESTAMPTZ, expires_at TIMESTAMPTZ)`);
      await this.options.db.query("CREATE INDEX IF NOT EXISTS music_licenses_email ON music_licenses (lower(email))");
      await this.options.db.query("CREATE INDEX IF NOT EXISTS music_licenses_user ON music_licenses (user_id)");
      await this.options.db.query("CREATE INDEX IF NOT EXISTS music_licenses_payment ON music_licenses (payment_id)");
    })().catch((error: unknown) => { this.schema = null; throw error; });
    return this.schema;
  }

  /** What would be licensed and for how much; refused when the pair is not sold or the music is not there. */
  async quote(input: Record<string, unknown>): Promise<Quote> {
    const tier = String(input["tier"] ?? (input["kind"] === "catalog" ? "catalog" : "indie")) as Tier;
    const kind = (tier === "catalog" ? "catalog" : String(input["kind"] ?? "")) as LicenseKind;
    const cents = LICENSE_PRICES[tier]?.[kind];
    if (!cents) throw new SupportError("That licence is not sold: Creator and Commercial are per song, Indie per song or album, the Catalog pass covers everything.", 400, "invalid_tier");
    if (kind === "catalog") {
      return { tier, kind, server: "", artist: "", album: "", n: 0, title: `Every artist released by ${this.holder}`, artistName: this.holder, creditUrl: `${this.options.site}/music`, amountCents: cents };
    }
    const item = await this.options.store.describe({ ...input, kind });
    return {
      tier, kind, server: item.server, artist: item.artist, album: item.album, n: item.n, title: item.title, artistName: item.artistName,
      creditUrl: `${this.options.site}/music/artist/${this.options.serverId(item.server)}/${item.artist}`, amountCents: cents,
    };
  }

  /** A licence waiting for its payment, and where to pay. */
  async checkout(input: Record<string, unknown>, account: { id: string; email: string } | null): Promise<{ url: string; id: string; token: string; code: string }> {
    if (input["agree"] !== true) throw new SupportError("Agree to the licence terms first.", 400, "terms_required");
    const email = (clean(input["email"], 254) || account?.email || "").toLowerCase();
    if (!EMAIL.test(email)) throw new SupportError("Give the email the licence should go to.", 400, "invalid_email");
    const licensee = clean(input["licensee"], 120);
    if (licensee.length < 2) throw new SupportError("Say who the licence is for: your name or your company's.", 400, "licensee_required");
    const project = clean(input["project"], 160);
    if (project.length < 2) throw new SupportError("Name the project the music goes in (the catalogue pass: your studio or channel).", 400, "project_required");
    const quote = await this.quote(input);
    await this.ready();
    const id = randomUUID();
    const token = randomUUID().replace(/-/g, "");
    const code = newCode();
    const checkout = await this.options.support.pay({
      amountUsd: quote.amountCents / 100,
      email,
      accountId: account?.id || email,
      order: `license-${id}`,
      description: `${TIER_NAMES[quote.tier]} licence: ${quote.title}${quote.kind === "catalog" ? ", one year" : ` by ${quote.artistName}`} for ${project}`,
      metadata: { product: "music-license", license: id, tier: quote.tier, kind: quote.kind },
      redirect: this.link(id, token),
    });
    await this.options.db.query(`INSERT INTO music_licenses (id, code, token, email, user_id, licensee, project, project_url, tier, kind, server, artist, album, n,
      title, artist_name, credit_url, amount_cents, coin, payment_id, terms, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [id, code, token, email, account?.id ?? "", licensee, project, httpsUrl(input["projectUrl"]), quote.tier, quote.kind, quote.server, quote.artist, quote.album, quote.n,
      quote.title, quote.artistName, quote.creditUrl, quote.amountCents, coinOf(input["coin"]), checkout.paymentId, TERMS_VERSION, new Date(this.now())]);
    return { url: checkout.url, id, token, code };
  }

  /** The licensee's own page: the certificate once paid. */
  link(id: string, token: string): string {
    return `${this.options.site}/licenses/${id}?t=${token}`;
  }

  /** Anybody's check of a licence by its code: a client asking whether a game's music is licensed. */
  verifyUrl(code: string): string {
    return `${this.options.site}/license/${code}`;
  }

  async get(id: string, token: string): Promise<License | null> {
    await this.ready();
    const found = (await this.options.db.query("SELECT * FROM music_licenses WHERE id = $1 AND token = $2", [id, token])).rows[0];
    if (!found) return null;
    const license = row(found);
    if (license.status === "pending" && license.paymentId && (await this.options.support.isPaid(license.paymentId)) === true) return (await this.paid(license.id)) ?? license;
    return license;
  }

  /** A paid licence by its code, for the public check; a pending one is not anybody's business. */
  async byCode(code: string): Promise<License | null> {
    if (!CODE.test(code)) return null;
    await this.ready();
    const found = (await this.options.db.query("SELECT * FROM music_licenses WHERE code = $1 AND status = 'paid'", [code])).rows[0];
    return found ? row(found) : null;
  }

  async owns(paymentId: string): Promise<boolean> {
    await this.ready();
    return (await this.options.db.query("SELECT 1 FROM music_licenses WHERE payment_id = $1", [paymentId])).rows.length > 0;
  }

  /** CoinPay's webhook for one of ours. */
  async settle(paymentId: string): Promise<{ settled: boolean; license?: string }> {
    await this.ready();
    const found = (await this.options.db.query("SELECT id, status FROM music_licenses WHERE payment_id = $1", [paymentId])).rows[0];
    if (!found) return { settled: false };
    if (found["status"] === "paid") return { settled: true, license: String(found["id"]) };
    if ((await this.options.support.isPaid(paymentId)) !== true) return { settled: false, license: String(found["id"]) };
    await this.paid(String(found["id"]));
    return { settled: true, license: String(found["id"]) };
  }

  async forAccount(account: { id: string; email: string }): Promise<License[]> {
    await this.ready();
    const rows = await this.options.db.query(
      "SELECT * FROM music_licenses WHERE status = 'paid' AND (user_id = $1 OR lower(email) = lower($2)) ORDER BY paid_at DESC LIMIT 500",
      [account.id, account.email],
    );
    return rows.rows.map(row);
  }

  /** Marks it paid once; the catalogue pass runs a year from then. The first to get here sends the certificate. */
  private async paid(id: string): Promise<License | null> {
    const now = new Date(this.now());
    const updated = (await this.options.db.query(
      "UPDATE music_licenses SET status = 'paid', paid_at = $2, expires_at = CASE WHEN kind = 'catalog' THEN $3::timestamptz ELSE NULL END WHERE id = $1 AND status = 'pending' RETURNING *",
      [id, now, new Date(this.now() + YEAR_MS)],
    )).rows[0];
    if (!updated) {
      const again = (await this.options.db.query("SELECT * FROM music_licenses WHERE id = $1", [id])).rows[0];
      return again ? row(again) : null;
    }
    const license = row(updated);
    await this.mail(license.email, `Your music licence ${license.code}: ${license.title}`, [
      `Thank you. ${license.licensee} now holds a ${TIER_NAMES[license.tier]} licence (${license.code}) for "${license.title}"${license.kind === "catalog" ? "" : ` by ${license.artistName}`}, for ${license.project}.`,
      `What it covers: ${TIER_USE[license.tier]}${license.expiresAt ? ` Projects published before ${new Date(license.expiresAt).toISOString().slice(0, 10)} stay licensed for good.` : ""}`,
      `Credit the music where your project has credits or a description, with a link to the artist's page: ${creditLine(license)}`,
      `Your certificate, to keep or print: ${this.link(license.id, license.token)}`,
      `Anybody can check it (a store, a platform, a client): ${this.verifyUrl(license.code)}`,
      `The terms (version ${license.terms}): ${this.options.site}/license/terms`,
    ]);
    return license;
  }

  /** What the licensee's page and the public check show. */
  view(license: License, full: boolean): Record<string, unknown> {
    const now = this.now();
    return {
      code: license.code, licensee: license.licensee, project: license.project, projectUrl: license.projectUrl,
      tier: license.tier, tierName: TIER_NAMES[license.tier], use: TIER_USE[license.tier], kind: license.kind,
      title: license.title, artistName: license.artistName, creditUrl: license.creditUrl, credit: creditLine(license),
      status: license.status, active: license.status === "paid" && (!license.expiresAt || license.expiresAt > now),
      paidAt: license.paidAt, expiresAt: license.expiresAt, terms: license.terms, termsUrl: `${this.options.site}/license/terms`, verify: this.verifyUrl(license.code),
      ...(full ? { id: license.id, email: license.email, amountUsd: license.amountCents / 100, coin: license.coin, paymentId: license.paymentId, link: this.link(license.id, license.token) } : {}),
    };
  }

  private async mail(to: string, subject: string, lines: string[]): Promise<void> {
    if (!this.options.mail) {
      this.options.log?.(`  licences: no RESEND_API_KEY, so "${subject}" to ${to} was not sent`);
      return;
    }
    try {
      await (this.options.fetcher ?? fetch)("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.options.mail.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.options.mail.from, to: [to], subject, text: `${lines.join("\n\n")}\n\nnixamp.com` }),
      });
    } catch (error) {
      this.options.log?.(`  licences: mail to ${to} failed: ${(error as Error).message}`);
    }
  }
}

/** The credit a licence asks for, ready to paste. */
export function creditLine(license: Pick<License, "kind" | "title" | "artistName" | "creditUrl" | "code">): string {
  return license.kind === "catalog"
    ? `Music: "<song>" by <artist> (<the artist's nixamp page>), licensed from ${license.artistName} on nixamp (${license.code})`
    : `Music: "${license.title}" by ${license.artistName} (${license.creditUrl}), licensed on nixamp (${license.code})`;
}

/** The licence terms, version TERMS_VERSION: plain words, shown at /license/terms and agreed to at checkout. */
export function licenseTerms(holder: string, site: string): Array<{ heading: string; text: string }> {
  return [
    { heading: "Who", text: `These terms are between ${holder} ("we"), which releases the AI label's music on nixamp, and the person or company named on the licence ("you").` },
    { heading: "What you may do", text: "Use the licensed recordings, and their lyrics, in your own project: put them in it, edit, cut, loop and mix them, and publish, sell and distribute the project with the music inside it, worldwide, for as long as the project exists. The licence is non-exclusive: others may license the same music." },
    { heading: "Which uses", text: `Creator: ${TIER_USE.creator} Indie: ${TIER_USE.indie} Commercial: ${TIER_USE.commercial} A song or album licence is for the one project named on it; the Catalog pass covers any number of your projects.` },
    { heading: "The Catalog pass", text: `${TIER_USE.catalog} It runs one year from payment. A project first published while it is active stays licensed for good; a project published after it ends needs a new pass or its own licence.` },
    { heading: "Credit", text: "Credit the music where your project shows credits or a description (end credits, an about screen, a video description, show notes), with a link to the artist's page on nixamp. The certificate gives the line to use. If there is nowhere to credit, put it where people can find it, such as your project's website." },
    { heading: "What you may not do", text: "Sell, give away or publish the music on its own or as music (a track, an album, a sample pack, a stock or production library), or let others take it out of your project to use separately. Register the music as yours, or claim it with a content ID system (YouTube Content ID and the like). Use it as a trademark, jingle or sound logo. Use it to train or evaluate AI models. Use it in anything unlawful, defamatory or hateful." },
    { heading: "Transfer", text: "The licence is yours and is not transferable, except with the project it is in: if you sell the project, the licence goes with it." },
    { heading: "AI and rights", text: `The music and lyrics are made with AI and released by ${holder}. In some countries, including the United States, works made by AI have limited or no copyright protection. This licence is our written permission and our promise not to claim against your licensed use; we do not promise that nobody else can use the same music.` },
    { heading: "No warranty", text: "The music is licensed as it is, without warranty. Our total liability under a licence is what you paid for it." },
    { heading: "Ending", text: "If you break these terms the licence ends for new uses; tell us and fix it within 30 days and it continues." },
    { heading: "Proof", text: `Every licence has a code (NXL-XXXX-XXXX) and a public page at ${site}/license/<code> that says who holds it, for what, and whether it is active.` },
    { heading: "Law", text: "California law governs these terms." },
  ];
}
