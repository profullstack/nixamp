/**
 * What this server's Buy links call it on nixamp.com: an opaque store id
 * rather than its address (music-store.ts), so a checkout link names no
 * machine.
 *
 * The id is asked of nixamp.com once (POST /api/v1/store/servers, signed in
 * with this server's `nixamp login`) and kept in memory. Until it arrives, or
 * when nixamp.com cannot be asked, links carry the address as they always did
 * and still work.
 */

export interface StoreRefOptions {
  /** nixamp.com, where the store is. */
  site: string;
  /** This server's public https address, or "". */
  publicBase: () => string;
  /** The account session to ask with, or "". */
  token: () => string;
  fetcher?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

const RETRY_MS = 10 * 60_000;

export class StoreRef {
  private id = "";
  private forServer = "";
  private nextTry = 0;
  private asking: Promise<void> | null = null;

  constructor(private readonly options: StoreRefOptions) {}

  /** The store id when known, else the address (and the id is asked for). */
  ref(): string {
    const server = this.options.publicBase();
    if (this.id && this.forServer === server) return this.id;
    void this.refresh();
    return server;
  }

  /** Asks nixamp.com for the id, at most every ten minutes after a failure. */
  refresh(): Promise<void> {
    const server = this.options.publicBase();
    const token = this.options.token();
    const now = this.options.now?.() ?? Date.now();
    if (!/^https:\/\//.test(server) || !token || (this.id && this.forServer === server)) return Promise.resolve();
    if (this.asking) return this.asking;
    if (now < this.nextTry) return Promise.resolve();
    this.nextTry = now + RETRY_MS;
    this.asking = (async () => {
      try {
        const answer = await (this.options.fetcher ?? fetch)(`${this.options.site}/api/v1/store/servers`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ server }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await answer.json().catch(() => ({}))) as { id?: unknown };
        if (answer.ok && typeof body.id === "string" && /^[a-f0-9]{16}$/.test(body.id)) {
          this.id = body.id;
          this.forServer = server;
          this.options.log?.(`  store: Buy links name this server by its store id`);
        } else {
          this.options.log?.(`  store: nixamp.com gave no store id (${answer.status}); Buy links carry the address for now`);
        }
      } catch (error) {
        this.options.log?.(`  store: could not ask nixamp.com for a store id: ${(error as Error).message}`);
      } finally {
        this.asking = null;
      }
    })();
    return this.asking;
  }
}
