/**
 * The zone: where a server's name is written down.
 *
 * nixamp.com hands every signed-in account's servers a name under
 * `<label>.<handle>.nixamp.com`, and a name is only a name once it resolves.
 * The records live at Porkbun, behind an API key that stays on nixamp.com:
 * a server asks nixamp.com for its name, and nixamp.com is the only thing
 * that ever talks to the registrar. The certificate module needs the same
 * zone for its `_acme-challenge` TXT records, which is why TXT is here too.
 *
 * Behind an interface, because a test wants a zone it can read back without
 * a network, and a nixamp started without keys still wants the rest of the
 * code to run.
 */
import { isIP } from "node:net";

export type RecordType = "A" | "AAAA" | "TXT";

export interface DnsRecord {
  id: string;
  /** The full hostname, e.g. "server2.chovy.nixamp.com". */
  host: string;
  type: RecordType;
  content: string;
  ttl: number;
}

export interface DnsZone {
  /** The apex this zone answers for: "nixamp.com". */
  readonly zone: string;
  list(host: string, type: RecordType): Promise<DnsRecord[]>;
  /** Afterwards exactly one record of that host and type exists, with this content. */
  set(host: string, type: RecordType, content: string, ttl?: number): Promise<void>;
  /** One more. An ACME order for a wildcard and its apex wants two TXT at once. */
  add(host: string, type: RecordType, content: string, ttl?: number): Promise<void>;
  /** All of host and type, or only those whose content matches. */
  remove(host: string, type: RecordType, content?: string): Promise<void>;
}

/** 2026, not 1998: an address is either family, and both are first class. */
export function isIPv4(value: unknown): boolean {
  return typeof value === "string" && isIP(value) === 4;
}

export function isIPv6(value: unknown): boolean {
  return typeof value === "string" && isIP(value) === 6;
}

/** Porkbun's floor. Anything lower is silently raised, so it is raised here, loudly. */
export const MIN_TTL = 600;

function ttlOf(ttl: number | undefined): number {
  return Math.max(MIN_TTL, Math.floor(ttl ?? MIN_TTL));
}

/**
 * A zone kept in memory. For tests, and for a nixamp started without registrar
 * keys, where a name can be handed out and simply will not resolve -- which the
 * operator is told about elsewhere, rather than crashing here.
 */
export class MemoryZone implements DnsZone {
  readonly records: DnsRecord[] = [];
  private sequence = 0;

  constructor(readonly zone: string) {}

  async list(host: string, type: RecordType): Promise<DnsRecord[]> {
    return this.records.filter((record) => record.host === host && record.type === type);
  }

  async set(host: string, type: RecordType, content: string, ttl?: number): Promise<void> {
    await this.remove(host, type);
    await this.add(host, type, content, ttl);
  }

  async add(host: string, type: RecordType, content: string, ttl?: number): Promise<void> {
    this.records.push({ id: String(++this.sequence), host, type, content, ttl: ttlOf(ttl) });
  }

  async remove(host: string, type: RecordType, content?: string): Promise<void> {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i] as DnsRecord;
      if (record.host !== host || record.type !== type) continue;
      if (content !== undefined && record.content !== content) continue;
      this.records.splice(i, 1);
    }
  }
}

/** How long to wait on the registrar before deciding it is not answering. */
const PORKBUN_TIMEOUT_MS = 20_000;

interface PorkbunRecord {
  id?: string | number;
  name?: string;
  type?: string;
  content?: string;
  ttl?: string | number;
}

/**
 * Porkbun's v3 DNS API.
 *
 * Every call is a POST carrying both halves of the key in the body -- the
 * field is `secretapikey`, which the API itself names as the usual mistake --
 * and the subdomain is the host with the zone taken off: "server2.chovy" for
 * "server2.chovy.nixamp.com", and nothing at all for the apex.
 */
export class Porkbun implements DnsZone {
  constructor(
    readonly zone: string,
    private readonly apiKey: string,
    private readonly secretApiKey: string,
    private readonly send: typeof fetch = fetch,
    private readonly base = "https://api.porkbun.com/api/json/v3",
  ) {}

  /** The part before the zone, or "" for the zone itself. */
  private sub(host: string): string {
    const suffix = `.${this.zone}`;
    if (host === this.zone) return "";
    if (!host.endsWith(suffix)) throw new Error(`${host} is not in ${this.zone}`);
    return host.slice(0, -suffix.length);
  }

  private async call<T>(path: string, fields: Record<string, unknown> = {}): Promise<T> {
    let answer: Response;
    try {
      answer = await this.send(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apikey: this.apiKey, secretapikey: this.secretApiKey, ...fields }),
        signal: AbortSignal.timeout(PORKBUN_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Porkbun did not answer: ${(error as Error).message}`);
    }
    let body: { status?: string; message?: string } & T;
    try {
      body = (await answer.json()) as typeof body;
    } catch {
      throw new Error(`Porkbun answered ${answer.status} with something that is not JSON`);
    }
    if (!answer.ok || body.status !== "SUCCESS") {
      throw new Error(`Porkbun refused: ${body.message ?? `HTTP ${answer.status}`}`);
    }
    return body;
  }

  async list(host: string, type: RecordType): Promise<DnsRecord[]> {
    // A trailing slash with nothing after it is how the apex is asked for.
    const body = await this.call<{ records?: PorkbunRecord[] }>(
      `/dns/retrieveByNameType/${this.zone}/${type}/${this.sub(host)}`,
    );
    return (body.records ?? [])
      .filter((record) => (record.type ?? type) === type)
      .map((record) => ({
        id: String(record.id ?? ""),
        host: record.name ?? host,
        type,
        content: record.content ?? "",
        ttl: Number(record.ttl ?? MIN_TTL) || MIN_TTL,
      }));
  }

  async add(host: string, type: RecordType, content: string, ttl?: number): Promise<void> {
    await this.call(`/dns/create/${this.zone}`, {
      name: this.sub(host),
      type,
      content,
      ttl: String(ttlOf(ttl)),
    });
  }

  async set(host: string, type: RecordType, content: string, ttl?: number): Promise<void> {
    const existing = await this.list(host, type);
    const [first, ...extras] = existing;
    if (first === undefined) {
      await this.add(host, type, content, ttl);
      return;
    }
    // Edit rather than delete-and-create: the name never has a moment with no
    // record at all, which for an A record is a moment nobody can connect.
    // Unless nothing would change: Porkbun refuses an edit that edits nothing
    // ("We were unable to edit the DNS record"), and a server announcing the
    // address it already has is the ordinary case, not an error.
    if (first.content !== content || first.ttl !== ttlOf(ttl)) {
      await this.call(`/dns/edit/${this.zone}/${first.id}`, {
        name: this.sub(host),
        type,
        content,
        ttl: String(ttlOf(ttl)),
      });
    }
    for (const extra of extras) {
      await this.call(`/dns/delete/${this.zone}/${extra.id}`);
    }
  }

  async remove(host: string, type: RecordType, content?: string): Promise<void> {
    const existing = await this.list(host, type);
    for (const record of existing) {
      if (content !== undefined && record.content !== content) continue;
      await this.call(`/dns/delete/${this.zone}/${record.id}`);
    }
  }
}
