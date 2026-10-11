import { afterEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { FixedClock, setClock, systemClock } from "../../src/clock.ts";
import { NessieClient } from "../../src/nessie/client.ts";
import { linkFor, seedPerson, setNessieClient } from "../../src/nessie/seed.ts";
import { readLedger } from "../../src/nessie/ledger.ts";
import { computeBudget } from "../../src/money/budget.ts";
import { profileFor } from "../../src/nessie/seed.ts";
import { profileToLedger } from "../../src/nessie/personas.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, testAtlas, type TestAtlas } from "../helpers/atlas.ts";
import { fakeNessie } from "../helpers/fakeNessie.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describeDb("budgets from Nessie profiles (connected accounts in chat)", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    setNessieClient(undefined);
    setClock(systemClock);
  });

  it("links everyone automatically and posts only the pooled budget by default (offline profile)", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    setNessieClient(null);
    t = await testAtlas();
    const chat = t.chat("b1", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    await t.app.jobs.runDue();
    const links = await q<{ persona: string; seed_status: string }>(`SELECT persona, seed_status FROM nessie_links ORDER BY person_id`);
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.persona)).size).toBe(3); // persona variety across the group
    expect(links.every((l) => l.seed_status === "ready")).toBe(true);

    const replies = await chat.say("leo", "what's our budget");
    expect(replies[0]!.text).toMatch(/^💰 budgets stay private, so here's just the pooled number:\neveryone's good up to \$[\d,]+ each\n\(based on everyone's last few months of spending, from your connected accounts\)$/);
    expect(replies[1]!.text).toMatch(/^how i got these/);
    expect(replies[1]!.text).toContain('"share my budget"');
    expect(replies.map((r) => r.text).join(" ")).not.toMatch(/(maya|leo|priya):? \$/);
    // Second time, no explanation bubble.
    const again = await chat.say("maya", "what's our budget?");
    expect(again).toHaveLength(1);
  });

  it("lists individual budgets once everyone chose to share", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    setNessieClient(null);
    t = await testAtlas();
    const chat = t.chat("b1s", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    await t.app.jobs.runDue();
    for (const who of ["maya", "leo", "priya"]) {
      const ack = await chat.say(who, "share my budget");
      expect(ack[0]!.text).toMatch(new RegExp(`^ok ${who}, i'll share your budget with the group`));
    }
    const replies = await chat.say("leo", "what's our budget");
    expect(replies[0]!.text).toMatch(/^💰 trip budgets\nmaya: \$[\d,]+\nleo: \$[\d,]+\npriya: \$[\d,]+$/);
    expect(replies[1]!.text).toMatch(/^so i'll plan around \$[\d,]+ each, which works for everyone\n\(based on everyone's last few months of spending, from your connected accounts\)$/);
    expect(replies[2]!.text).toMatch(/^how i got these/);
  });

  it("keeps a private budget out of the group message", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    setNessieClient(null);
    t = await testAtlas();
    const chat = t.chat("b2", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    await t.app.jobs.runDue();
    await chat.say("maya", "share my budget");
    await chat.say("leo", "share my budget");
    const ack = await chat.say("priya", "keep my budget private");
    expect(ack[0]!.text).toMatch(/your budget stays private/);
    const replies = await chat.say("leo", "what's our budget");
    expect(replies[0]!.text).toMatch(/here's just the pooled number/);
    expect(replies[0]!.text).not.toMatch(/(maya|leo|priya):? \$/);
    const row = await q<{ suggested_cents: number }>(`SELECT b.suggested_cents FROM budgets b JOIN people p ON p.id = b.person_id WHERE p.display_name = 'Priya'`);
    expect(replies.map((r) => r.text).join(" ")).not.toContain(`$${(row[0]!.suggested_cents / 100).toLocaleString("en-US")} `);
  });

  it("adjusts a budget by text", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    setNessieClient(null);
    t = await testAtlas();
    const chat = t.chat("b3", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    await t.app.jobs.runDue();
    const quiet = await chat.say("maya", "set my budget to 600");
    expect(quiet[0]!.text).toBe("updated your budget (kept private)");
    for (const who of ["maya", "leo", "priya"]) await chat.say(who, "share my budget");
    const r = await chat.say("maya", "set my budget to 650");
    expect(r[0]!.text).toBe("done, maya's budget is now $650 👍");
    const budgets = await chat.say("leo", "what's our budget");
    expect(budgets[0]!.text).toContain("maya: $650");
  });

  it("won't save a joke budget", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    setNessieClient(null);
    t = await testAtlas();
    const chat = t.chat("b3b", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    await t.app.jobs.runDue();
    const r = await chat.say("leo", "set my budget to $1");
    expect(r[0]!.text).toMatch(/^\$1 won't get anyone out of town/);
    const rows = await q<{ adjusted_cents: number | null }>(`SELECT b.adjusted_cents FROM budgets b JOIN people p ON p.id = b.person_id WHERE p.display_name = 'Leo'`);
    expect(rows.every((row) => row.adjusted_cents === null)).toBe(true);
  });

  it("seeds a real-shaped Nessie customer and reads the same budget back", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    const fake = fakeNessie();
    setNessieClient(new NessieClient({ apiKey: "test-key", fetch: fake.fetch, maxRetries: 0 }));
    t = await testAtlas();
    const chat = t.chat("b4", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const personId = (await q<{ id: number }>(`SELECT id FROM people ORDER BY id LIMIT 1`))[0]!.id;
    const link = await seedPerson(personId);
    expect(link.seed_status).toBe("ready");
    expect(link.customer_id).toMatch(/^[0-9a-f-]{36}$/);
    const customer = fake.state.customers.get(link.customer_id!)!;
    // Their real first name, a generated last name: nothing else about the person reaches Nessie.
    expect(customer.first_name).toBe("Maya");
    expect(customer.last_name).toMatch(/^[A-Z][a-z]+$/);
    expect(JSON.stringify(customer)).not.toMatch(/demo|sandbox|synthetic|\+1555/i);
    const kinds = [...fake.state.objects.values()].map((o) => o.kind);
    expect(kinds.filter((k) => k === "deposits").length).toBeGreaterThan(10);
    expect(kinds).toContain("purchases");
    expect(kinds).toContain("bills");
    expect(kinds).toContain("withdrawals");

    // Round trip: what we read back from Nessie gives the same budget as the generated profile.
    const fresh = (await linkFor(personId))!;
    const ledger = await readLedger(fresh, new NessieClient({ apiKey: "test-key", fetch: fake.fetch, maxRetries: 0 }));
    expect(ledger.source).toBe("nessie");
    const fromNessie = computeBudget({ asOf: "2026-10-10", tripStart: "2026-11-12", ...ledger });
    const fromProfile = computeBudget({ asOf: "2026-10-10", tripStart: "2026-11-12", ...profileToLedger(profileFor(fresh)) });
    expect(fromNessie.budgetCents).toBe(fromProfile.budgetCents);
    expect(fromNessie.monthlyIncomeCents).toBe(fromProfile.monthlyIncomeCents);

    // Re-running the seed is a no-op (ready).
    const before = fake.state.objects.size;
    await seedPerson(personId);
    expect(fake.state.objects.size).toBe(before);
    const audited = await q<{ n: number }>(`SELECT count(*)::int AS n FROM nessie_calls WHERE ok`);
    expect(audited[0]!.n).toBeGreaterThan(50);
  });

  it("serves cached reads when Nessie goes down, and says so", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    const fake = fakeNessie();
    const client = new NessieClient({ apiKey: "test-key", fetch: fake.fetch, maxRetries: 0 });
    setNessieClient(client);
    t = await testAtlas();
    const chat = t.chat("b5", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const personId = (await q<{ id: number }>(`SELECT id FROM people ORDER BY id LIMIT 1`))[0]!.id;
    await seedPerson(personId);
    const link = (await linkFor(personId))!;
    await readLedger(link, client); // warm the cache
    fake.state.down = true;
    const cached = await readLedger(link, client);
    expect(cached.source).toBe("nessie-cache");
    const fromCache = await q<{ n: number }>(`SELECT count(*)::int AS n FROM nessie_calls WHERE from_cache`);
    expect(fromCache[0]!.n).toBeGreaterThan(0);
  });
});
