/**
 * The music store on nixamp.com: the AI label's songs as files, bought with
 * crypto through CoinPay.
 *
 * Listening is free on the live stations (with their breaks). What is sold is
 * the files: a song for 10 cents, an album for $1, everything by an artist
 * for $2, as a zip made on the fly by the server that holds them (MP3s with
 * the cover and the words inside, each song's .lyrics.txt, cover.jpg and
 * album.json). A buyer gives an email; once CoinPay says paid (its webhook,
 * or asked when the buyer comes back), the email gets a link to the purchase,
 * and the account with that email sees every purchase under My music on
 * nixamp.com/radio, to play or download again.
 *
 * nixamp.com never holds the music. It signs a grant -- what was bought, from
 * which server, until when -- and the server asks nixamp.com whether a grant
 * is good before it plays or zips anything (/api/v1/store/grant).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, Support } from "./support.ts";
import { SupportError } from "./support.ts";

export type Kind = "song" | "album" | "artist";

/** In cents. */
export const PRICES: Record<Kind, number> = { song: 10, album: 100, artist: 200 };

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const KEY = /^[a-f0-9]{10}$/;
const ALBUM = /^[a-f0-9]{8}$/;
/** A grant is good for a day; pages mint a fresh one each time. */
const GRANT_MS = 24 * 3600_000;

export interface Scope {
  server: string;
  kind: Kind;
  artist: string;
  album: string;
  n: number;
}

export interface Purchase extends Scope {
  id: string;
  token: string;
  email: string;
  userId: string;
  title: string;
  artistName: string;
  amountCents: number;
  coin: string;
  paymentId: string;
  status: "pending" | "paid";
  createdAt: number;
  paidAt: number;
}

interface LabelSong { n: number; title: string }
interface LabelAlbum { key: string; title: string; year: number; songs: LabelSong[] }
interface LabelArtist { key: string; name: string; albums: LabelAlbum[] }
interface LabelView { holder: string; genres: Array<{ genre: string; artists: LabelArtist[] }> }

/** A server's public address as given: https, no path, no trailing slash. */
export function serverBase(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function sign(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("base64url");
}

/** `g1.<exp>.<kind>.<artist>.<album|->.<n>.<server, base64url>.<sig>` */
export function makeGrant(secret: string, scope: Scope, exp: number): string {
  const body = ["g1", String(exp), scope.kind, scope.artist, scope.album || "-", String(scope.n), Buffer.from(scope.server).toString("base64url")].join(".");
  return `${body}.${sign(secret, body)}`;
}

export function readGrant(secret: string, grant: string, now = Date.now()): (Scope & { exp: number }) | null {
  const parts = grant.split(".");
  if (parts.length !== 8 || parts[0] !== "g1") return null;
  const body = parts.slice(0, 7).join(".");
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(parts[7]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < now) return null;
  const kind = parts[2] as Kind;
  if (!(kind in PRICES)) return null;
  return { kind, artist: parts[3]!, album: parts[4] === "-" ? "" : parts[4]!, n: Number(parts[5]), server: Buffer.from(parts[6]!, "base64url").toString("utf8"), exp };
}

/** Whether a grant for `scope` covers this file of the catalogue. */
export function covers(scope: Pick<Scope, "kind" | "artist" | "album" | "n">, artist: string, album: string, n?: number): boolean {
  if (scope.artist !== artist) return false;
  if (scope.kind === "artist") return true;
  if (scope.album !== album) return false;
  if (scope.kind === "album") return true;
  return n === undefined ? false : scope.n === n;
}

/**
 * On a server that holds the music: whether nixamp.com signed this grant,
 * asked at /api/v1/store/grant and remembered (a good one until it expires,
 * a refused one for 5 minutes). nixamp.com itself checks with its secret.
 */
export class GrantVerifier {
  private known = new Map<string, { scope: (Scope & { exp: number }) | null; until: number }>();

  constructor(private readonly options: { site: string; secret?: string; fetcher?: typeof fetch; now?: () => number }) {}

  async check(grant: string): Promise<(Scope & { exp: number }) | null> {
    const now = this.options.now?.() ?? Date.now();
    if (!/^g1\.[A-Za-z0-9._-]{20,600}$/.test(grant)) return null;
    if (this.options.secret) return readGrant(this.options.secret, grant, now);
    const hit = this.known.get(grant);
    if (hit && hit.until > now) return hit.scope;
    try {
      const response = await (this.options.fetcher ?? fetch)(`${this.options.site}/api/v1/store/grant?g=${encodeURIComponent(grant)}`, { signal: AbortSignal.timeout(5_000) });
      if (response.status >= 500) return null;
      const body = await response.json() as { ok?: boolean; scope?: Scope & { exp: number } };
      const scope = body.ok && body.scope ? body.scope : null;
      if (this.known.size > 5000) this.known.clear();
      this.known.set(grant, { scope, until: scope ? scope.exp : now + 5 * 60_000 });
      return scope;
    } catch {
      return null;
    }
  }
}

function row(one: Record<string, unknown>): Purchase {
  return {
    id: String(one["id"]), token: String(one["token"]), email: String(one["email"]), userId: String(one["user_id"] ?? ""),
    server: String(one["server"]), kind: String(one["kind"]) as Kind, artist: String(one["artist"]), album: String(one["album"] ?? ""), n: Number(one["n"] ?? 0),
    title: String(one["title"]), artistName: String(one["artist_name"]), amountCents: Number(one["amount_cents"]), coin: String(one["coin"]),
    paymentId: String(one["payment_id"] ?? ""), status: one["status"] === "paid" ? "paid" : "pending",
    createdAt: new Date(String(one["created_at"])).getTime(), paidAt: one["paid_at"] ? new Date(String(one["paid_at"])).getTime() : 0,
  };
}

export interface MusicStoreOptions {
  db: Db;
  support: Support;
  /** Resend; null leaves the receipt unsent (and says so in the log). */
  mail: { apiKey: string; from: string } | null;
  site: string;
  /** Signs the grants; derived from NIXAMP_JWT_SECRET. */
  secret: string;
  /** The servers whose catalogues may be sold here (the directory and the guide's peers). */
  servers: () => string[];
  fetcher?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export class MusicStore {
  private schema: Promise<void> | null = null;

  constructor(private readonly options: MusicStoreOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ready(): Promise<void> {
    this.schema ??= (async () => {
      await this.options.db.query(`CREATE TABLE IF NOT EXISTS music_purchases (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
        server TEXT NOT NULL, kind TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL, artist_name TEXT NOT NULL, amount_cents INTEGER NOT NULL, coin TEXT NOT NULL,
        payment_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL, paid_at TIMESTAMPTZ)`);
      await this.options.db.query("CREATE INDEX IF NOT EXISTS music_purchases_email ON music_purchases (lower(email))");
      await this.options.db.query("CREATE INDEX IF NOT EXISTS music_purchases_user ON music_purchases (user_id)");
      await this.options.db.query("CREATE INDEX IF NOT EXISTS music_purchases_payment ON music_purchases (payment_id)");
    })().catch((error: unknown) => { this.schema = null; throw error; });
    return this.schema;
  }

  /** A server's catalogue, as it publishes it at /api/v1/label. */
  private async catalogue(server: string): Promise<LabelView> {
    const response = await (this.options.fetcher ?? fetch)(`${server}/api/v1/label`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!response.ok) throw new SupportError("That server's catalogue could not be read. Try again.", 502, "catalogue");
    return await response.json() as LabelView;
  }

  /** What is for sale at this address, with its name and price; refused when there is no such thing. */
  async describe(input: Record<string, unknown>): Promise<Scope & { title: string; artistName: string; amountCents: number; songs: number }> {
    const server = serverBase(input["server"]);
    if (!server || !this.options.servers().includes(server)) throw new SupportError("That server does not sell music here.", 404, "not_found");
    const kind = String(input["kind"] ?? "") as Kind;
    if (!(kind in PRICES)) throw new SupportError("Buy a song, an album or an artist.", 400, "invalid_kind");
    const artistKey = String(input["artist"] ?? "");
    const albumKey = kind === "artist" ? "" : String(input["album"] ?? "");
    const n = kind === "song" ? Number(input["n"]) : 0;
    if (!KEY.test(artistKey) || (kind !== "artist" && !ALBUM.test(albumKey)) || (kind === "song" && !(Number.isInteger(n) && n > 0))) throw new SupportError("No such music.", 404, "not_found");
    const view = await this.catalogue(server);
    const artist = view.genres.flatMap((one) => one.artists).find((one) => one.key === artistKey);
    const album = artist?.albums.find((one) => one.key === albumKey);
    const song = album?.songs.find((one) => one.n === n);
    if (!artist || (kind !== "artist" && !album) || (kind === "song" && !song)) throw new SupportError("No such music.", 404, "not_found");
    const title = kind === "artist" ? `Everything by ${artist.name}` : kind === "album" ? `${album!.title} (${album!.year})` : `${song!.title}`;
    const songs = kind === "artist" ? artist.albums.reduce((sum, one) => sum + one.songs.length, 0) : kind === "album" ? album!.songs.length : 1;
    return { server, kind, artist: artistKey, album: albumKey, n, title, artistName: artist.name, amountCents: PRICES[kind], songs };
  }

  /** A purchase waiting for its payment, and where to pay. Signed in, it is the account's too. */
  async checkout(input: Record<string, unknown>, account: { id: string; email: string } | null): Promise<{ url: string; id: string; token: string }> {
    const email = (typeof input["email"] === "string" && input["email"].trim() ? input["email"] : account?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw new SupportError("Give the email your music should go to.", 400, "invalid_email");
    const item = await this.describe(input);
    await this.ready();
    const id = randomUUID();
    const token = randomUUID().replace(/-/g, "");
    const checkout = await this.options.support.pay({
      amountUsd: item.amountCents / 100,
      coin: input["coin"],
      order: `music-${id}`,
      description: `${item.title} by ${item.artistName} (${item.kind === "song" ? "song" : item.kind === "album" ? "album" : "every album"}, MP3)`,
      metadata: { product: "music", purchase: id, kind: item.kind },
      redirect: this.link(id, token),
    });
    await this.options.db.query(`INSERT INTO music_purchases (id, token, email, user_id, server, kind, artist, album, n, title, artist_name, amount_cents, coin, payment_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, token, email, account?.id ?? "", item.server, item.kind, item.artist, item.album, item.n, item.title, item.artistName, item.amountCents, String(input["coin"]).toUpperCase(), checkout.paymentId, new Date(this.now())]);
    return { url: checkout.url, id, token };
  }

  /** The purchase's own page, which is also the receipt link. */
  link(id: string, token: string): string {
    return `${this.options.site}/purchases/${id}?t=${token}`;
  }

  /** A purchase by its link; a pending one asks CoinPay whether it has been paid since. */
  async get(id: string, token: string): Promise<Purchase | null> {
    await this.ready();
    const found = (await this.options.db.query("SELECT * FROM music_purchases WHERE id = $1 AND token = $2", [id, token])).rows[0];
    if (!found) return null;
    const purchase = row(found);
    if (purchase.status === "pending" && purchase.paymentId && (await this.options.support.isPaid(purchase.paymentId)) === true) return (await this.paid(purchase.id)) ?? purchase;
    return purchase;
  }

  /** CoinPay's webhook: a payment of ours that is now paid. False when it is not a music purchase. */
  async settle(paymentId: string): Promise<{ settled: boolean; purchase?: string }> {
    await this.ready();
    const found = (await this.options.db.query("SELECT id, status FROM music_purchases WHERE payment_id = $1", [paymentId])).rows[0];
    if (!found) return { settled: false };
    if (found["status"] === "paid") return { settled: true, purchase: String(found["id"]) };
    if ((await this.options.support.isPaid(paymentId)) !== true) return { settled: false, purchase: String(found["id"]) };
    await this.paid(String(found["id"]));
    return { settled: true, purchase: String(found["id"]) };
  }

  /** Whether CoinPay's webhook is about one of ours. */
  async owns(paymentId: string): Promise<boolean> {
    await this.ready();
    return (await this.options.db.query("SELECT 1 FROM music_purchases WHERE payment_id = $1", [paymentId])).rows.length > 0;
  }

  /** Marks it paid once (the first to get there sends the receipt). */
  private async paid(id: string): Promise<Purchase | null> {
    const updated = (await this.options.db.query("UPDATE music_purchases SET status = 'paid', paid_at = $2 WHERE id = $1 AND status = 'pending' RETURNING *", [id, new Date(this.now())])).rows[0];
    if (!updated) {
      const again = (await this.options.db.query("SELECT * FROM music_purchases WHERE id = $1", [id])).rows[0];
      return again ? row(again) : null;
    }
    const purchase = row(updated);
    await this.mail(purchase.email, `Your music: ${purchase.title}`, [
      `Thank you. "${purchase.title}" by ${purchase.artistName} is yours: MP3s with the cover art and the lyrics, in one zip.`,
      `Download it, now or any time: ${this.link(purchase.id, purchase.token)}`,
      `Sign in to nixamp.com with ${purchase.email} and everything you have bought is under My music on ${this.options.site}/radio#music, to play or download again.`,
    ]);
    return purchase;
  }

  /** Every paid purchase of this account: made signed in, or to its email. */
  async forAccount(account: { id: string; email: string }): Promise<Purchase[]> {
    await this.ready();
    const rows = await this.options.db.query(
      "SELECT * FROM music_purchases WHERE status = 'paid' AND (user_id = $1 OR lower(email) = lower($2)) ORDER BY paid_at DESC LIMIT 500",
      [account.id, account.email],
    );
    return rows.rows.map(row);
  }

  grant(purchase: Scope): string {
    return makeGrant(this.options.secret, purchase, this.now() + GRANT_MS);
  }

  check(grant: string): (Scope & { exp: number }) | null {
    return readGrant(this.options.secret, grant, this.now());
  }

  /** Where the zip of a purchase is made: on the server that holds the music. */
  zipUrl(purchase: Purchase): string {
    return `${purchase.server}/api/v1/label/zip?grant=${encodeURIComponent(this.grant(purchase))}`;
  }

  /** What anybody with the purchase's link (or the account) is shown. */
  view(purchase: Purchase): Record<string, unknown> {
    return {
      id: purchase.id, kind: purchase.kind, title: purchase.title, artistName: purchase.artistName, server: purchase.server,
      artist: purchase.artist, album: purchase.album, n: purchase.n, amountUsd: purchase.amountCents / 100, coin: purchase.coin,
      status: purchase.status, createdAt: purchase.createdAt, paidAt: purchase.paidAt,
      ...(purchase.status === "paid" ? { grant: this.grant(purchase), zip: this.zipUrl(purchase), link: this.link(purchase.id, purchase.token) } : {}),
    };
  }

  private async mail(to: string, subject: string, lines: string[]): Promise<void> {
    if (!this.options.mail) {
      this.options.log?.(`  store: no RESEND_API_KEY, so "${subject}" to ${to} was not sent`);
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
      this.options.log?.(`  store: mail to ${to} failed: ${(error as Error).message}`);
    }
  }
}
