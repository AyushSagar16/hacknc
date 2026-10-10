// Capital One Nessie sandbox client (https://api.nessieisreal.com, API key as ?key=).
// - The key stays server-side and never appears in logs or the audit table (URLs are redacted).
// - Every call is audited in nessie_calls (shown in the judge console).
// - GETs cache their last good response in nessie_cache; when Nessie is down (or the circuit
//   breaker is open after repeated failures) reads are served from that cache and marked.
// - Creates read the new object's id from Nessie's {code, message, objectCreated} envelope.
import { now } from "../clock.ts";
import { childLog, redactUrl } from "../log.ts";
import { one, q } from "../db/pool.ts";

export class NessieError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Nessie ${path} returned ${status}: ${body.slice(0, 400)}`);
  }
}

export class NessieUnavailable extends Error {}

export interface NessieOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Audit and cache in Postgres (off in pure unit tests). */
  persist?: boolean;
}

export interface Read<T> {
  value: T;
  fromCache: boolean;
  fetchedAt: Date;
}

type Obj = Record<string, unknown>;

export class NessieClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly persist: boolean;
  private failures = 0;
  private openUntil = 0;
  private readonly log = childLog({ component: "nessie" });

  constructor(private readonly opts: NessieOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.nessieisreal.com").replace(/^http:\/\//, "https://").replace(/\/$/, "");
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.persist = opts.persist ?? true;
  }

  get circuitOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(this.opts.apiKey)}`;
  }

  private async request(method: string, path: string, body?: Obj, personId?: number | null): Promise<{ status: number; text: string }> {
    if (this.circuitOpen) throw new NessieUnavailable("nessie circuit breaker is open");
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const t0 = Date.now();
      try {
        const res = await this.doFetch(this.url(path), {
          method,
          headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        await this.audit(method, path, res.status, res.ok, false, res.ok ? createdId(text) : null, res.ok ? null : text.slice(0, 500), Date.now() - t0, personId);
        // Retry only server-side trouble; 4xx are our bug or Nessie's validation (fail loudly).
        if (res.status >= 500 && attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (res.status >= 500) this.trip();
        else this.failures = 0;
        return { status: res.status, text };
      } catch (err) {
        lastErr = err;
        await this.audit(method, path, null, false, false, null, (err as Error).message, Date.now() - t0, personId);
        if (attempt < this.maxRetries) await sleep(500 * 2 ** attempt);
      }
    }
    this.trip();
    throw new NessieUnavailable(`nessie unreachable: ${(lastErr as Error)?.message ?? "unknown"}`);
  }

  private trip(): void {
    this.failures += 1;
    if (this.failures >= 3) {
      this.openUntil = Date.now() + 60_000;
      this.log.error("nessie failing repeatedly; serving cached reads for 60s");
    }
  }

  private async audit(method: string, path: string, status: number | null, ok: boolean, fromCache: boolean, objectId: string | null, error: string | null, latency: number, personId?: number | null): Promise<void> {
    if (!this.persist) return;
    try {
      await q(
        `INSERT INTO nessie_calls (method, path, status, ok, from_cache, object_id, error, latency_ms, person_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [method, redactUrl(path).split("?")[0], status, ok, fromCache, objectId, error, latency, personId ?? null, now()],
      );
    } catch {
      // auditing must never break a money flow
    }
  }

  /** GET with last-good caching. Empty lists come back from Nessie as 404 on some routes. */
  async get<T = unknown>(path: string, opts: { personId?: number | null; list?: boolean } = {}): Promise<Read<T>> {
    try {
      const response = await this.request("GET", path, undefined, opts.personId);
      const status = response.status;
      // Some list routes answer 404 when empty; that's a real (cacheable) empty list.
      const text = status === 404 && opts.list ? "[]" : response.text;
      if (status >= 400 && !(status === 404 && opts.list)) throw new NessieError(path, status, text);
      const value = JSON.parse(text) as T;
      if (this.persist) {
        await q(`INSERT INTO nessie_cache (cache_key, body, fetched_at) VALUES ($1,$2,$3) ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at`, [
          path,
          text,
          now(),
        ]).catch(() => {});
      }
      return { value, fromCache: false, fetchedAt: now() };
    } catch (err) {
      if (err instanceof NessieError && err.status < 500) throw err;
      const cached = this.persist ? await one<{ body: T; fetched_at: Date }>(`SELECT body, fetched_at FROM nessie_cache WHERE cache_key = $1`, [path]).catch(() => undefined) : undefined;
      if (!cached) throw err;
      await this.audit("GET", path, null, true, true, null, null, 0, opts.personId);
      return { value: cached.body, fromCache: true, fetchedAt: cached.fetched_at };
    }
  }

  /** POST a new object; returns its id. Throws NessieError with the API's body on rejection. */
  async create(path: string, body: Obj, personId?: number | null): Promise<{ id: string; object: Obj }> {
    const { status, text } = await this.request("POST", path, body, personId);
    if (status >= 400) throw new NessieError(path, status, text);
    const parsed = safeJson(text);
    const object = ((parsed as Obj)?.objectCreated ?? parsed) as Obj;
    const id = (object?._id ?? object?.id) as string | undefined;
    if (!id) throw new NessieError(path, status, `created but no id in response: ${text.slice(0, 200)}`);
    return { id, object };
  }

  async remove(path: string, personId?: number | null): Promise<boolean> {
    const { status } = await this.request("DELETE", path, undefined, personId);
    return status < 300;
  }

  // ---- typed helpers ----
  createCustomer(body: Obj, personId?: number) {
    return this.create("/customers", body, personId);
  }
  createAccount(customerId: string, body: Obj, personId?: number) {
    return this.create(`/customers/${customerId}/accounts`, body, personId);
  }
  createMerchant(body: Obj) {
    return this.create("/merchants", body);
  }
  createOn(accountId: string, kind: "deposits" | "withdrawals" | "purchases" | "bills" | "transfers", body: Obj, personId?: number) {
    return this.create(`/accounts/${accountId}/${kind}`, body, personId);
  }
  listOn<T = Obj[]>(accountId: string, kind: "deposits" | "withdrawals" | "purchases" | "bills" | "transfers", personId?: number) {
    return this.get<T>(`/accounts/${accountId}/${kind}`, { personId, list: true });
  }
  account(accountId: string, personId?: number) {
    return this.get<Obj>(`/accounts/${accountId}`, { personId });
  }
}

function createdId(text: string): string | null {
  const parsed = safeJson(text) as Obj | null;
  const object = (parsed?.objectCreated ?? parsed) as Obj | null;
  const id = object && !Array.isArray(object) ? (object._id ?? object.id) : null;
  return typeof id === "string" ? id : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
