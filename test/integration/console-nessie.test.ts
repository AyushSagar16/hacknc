// The operator console's Nessie view: linked customers, live balances (with the offline
// fallback), trip fund tables when they exist, and the filtered call audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { q } from "../../src/db/pool.ts";
import { NessieClient } from "../../src/nessie/client.ts";
import { setNessieClient } from "../../src/nessie/seed.ts";
import { callFilter, nessieBalances, nessieData, startConsole } from "../../src/console/server.ts";
import { dbAvailable, freshDb } from "../helpers/db.ts";
import { fakeNessie } from "../helpers/fakeNessie.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describeDb("console nessie view", () => {
  let drop: () => Promise<void>;
  let checking = "";
  const fake = fakeNessie();

  beforeAll(async () => {
    ({ drop } = await freshDb());
    const client = new NessieClient({ apiKey: "k", fetch: fake.fetch, persist: false, maxRetries: 0 });
    const customer = await client.createCustomer({ first_name: "Maya" });
    checking = (await client.createAccount(customer.id, { type: "Checking", nickname: "Checking", rewards: 0, balance: 1234.5 })).id;
    const [maya] = await q<{ id: number }>(`INSERT INTO people (handle, display_name, created_at) VALUES ('+15550001111', 'Maya', now()) RETURNING id`);
    await q(
      `INSERT INTO nessie_links (person_id, persona, customer_id, checking_id, seed_status, seeded_at, created_at) VALUES ($1, 'student', $2, $3, 'ready', now(), now())`,
      [maya!.id, customer.id, checking],
    );
    await q(
      `INSERT INTO nessie_calls (method, path, status, ok, from_cache, object_id, error, latency_ms, person_id, created_at) VALUES
        ('GET', '/accounts/abc', 200, true, false, null, null, 120, $1, now()),
        ('POST', '/accounts/abc/transfers?key=SECRET', 400, false, false, null, 'extra fields', 80, $1, now()),
        ('GET', '/accounts/abc', null, true, true, null, null, 0, null, now())`,
      [maya!.id],
    );
    setNessieClient(client);
  });
  afterAll(async () => {
    setNessieClient(undefined);
    await drop();
  });

  it("lists links and filters calls without ever showing a key", async () => {
    const all = await nessieData();
    expect(all.links).toHaveLength(1);
    expect(all.links[0]).toMatchObject({ who: "Maya", persona: "student", checking_id: checking, seed_status: "ready" });
    expect(all.stats).toMatchObject({ total: 3, errors: 1, cached: 1 });
    expect(JSON.stringify(all.calls)).not.toContain("SECRET");
    expect(all.people.map((p) => p.who)).toEqual(["Maya"]);

    const errors = await nessieData(callFilter(new URLSearchParams("status=error")));
    expect(errors.calls.map((c) => c.method)).toEqual(["POST"]);
    const posts = await nessieData(callFilter(new URLSearchParams("method=get&path=accounts/abc")));
    expect(posts.calls).toHaveLength(2);
    const pct = await nessieData({ path: "%" });
    expect(pct.calls).toHaveLength(0);
  });

  it("finds trip fund tables when they exist and tolerates them missing", async () => {
    expect((await nessieData()).funds).toEqual([]);
    await q(`CREATE TABLE trip_funds_probe (id int PRIMARY KEY, nessie_account_id text, target_cents bigint)`);
    await q(`INSERT INTO trip_funds_probe VALUES (1, $1, 120000)`, [checking]);
    const { funds } = await nessieData();
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({ table: "trip_funds_probe", columns: ["id", "nessie_account_id", "target_cents"] });
    await q(`DROP TABLE trip_funds_probe`);
  });

  it("reads live balances, and falls back to cached ones offline", async () => {
    setNessieClient(new NessieClient({ apiKey: "k", fetch: fake.fetch, persist: false, maxRetries: 0 }));
    const live = await nessieBalances({ fresh: true });
    expect(live.mode).toBe("live");
    expect(live.accounts[checking]).toMatchObject({ balance: 1234.5, source: "live" });

    setNessieClient(null);
    const none = await nessieBalances({ fresh: true });
    expect(none).toMatchObject({ mode: "offline", accounts: { [checking]: { balance: null, note: "offline" } } });
    await q(`INSERT INTO nessie_cache (cache_key, body, fetched_at) VALUES ($1, $2, now())`, [`/accounts/${checking}`, JSON.stringify({ balance: 99 })]);
    const cached = await nessieBalances({ fresh: true });
    expect(cached.accounts[checking]).toMatchObject({ balance: 99, source: "cache" });
  });

  it("serves the view over HTTP", async () => {
    const server = await startConsole(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(page).toContain("tab-nessie");
      const body = (await (await fetch(`http://127.0.0.1:${port}/api/nessie?status=cache`)).json()) as { calls: unknown[] };
      expect(body.calls).toHaveLength(1);
      expect((await fetch(`http://127.0.0.1:${port}/api/nessie/balances`)).status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
