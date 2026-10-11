// The trip fund against a fake Nessie that behaves like the live one (transfers can't name a
// payee, amounts drop cents): a fund customer and account, contributions as transfers from
// connected people's checking (plus a deposit into the fund), the stay as a fund purchase at a
// merchant named after it, refunds back to checking, and people with no bank tracked in the
// ledger only. Also the page snapshot of it (first names, newest first).
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { FixedClock, setClock, systemClock } from "../../src/clock.ts";
import { activeMembers, findChat } from "../../src/db/repos/core.ts";
import { NessieClient } from "../../src/nessie/client.ts";
import { linkFor, seedPerson, setNessieClient } from "../../src/nessie/seed.ts";
import { siteFund, siteStay } from "../../src/site/fund.ts";
import { addFundItem, ensureFundAccount, executeContribution, fundTotals, fundTxns, payDueItems, planContributions, refundFromFund } from "../../src/trips/fund.ts";
import { tripFor, updateTrip } from "../../src/trips/state.ts";
import { dbAvailable } from "../helpers/db.ts";
import { testAtlas, type TestAtlas } from "../helpers/atlas.ts";
import { fakeNessie } from "../helpers/fakeNessie.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describeDb("trip fund through Nessie", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    setNessieClient(undefined);
    setClock(systemClock);
  });

  it("collects contributions, pays the stay, refunds the leftover; no bank = ledger only", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    const fake = fakeNessie();
    const client = new NessieClient({ apiKey: "test-key", fetch: fake.fetch, maxRetries: 0 });
    setNessieClient(client);
    t = await testAtlas();
    const chat = t.chat("fund1", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const chatRow = (await findChat("sim", chat.id))!;
    const members = await activeMembers(chatRow.id);
    const id = (name: string) => members.find((m) => m.display_name?.toLowerCase() === name)!.id;
    // maya and leo connected their bank; priya didn't.
    await seedPerson(id("maya"));
    await seedPerson(id("leo"));
    let trip = await tripFor(chatRow.id);
    trip = await updateTrip(trip.id, { destination_id: "charleston", destination_name: "Charleston", start_date: "2026-12-10", end_date: "2026-12-14", status: "locked" });
    trip = await updateTrip(trip.id, {
      stay: { name: "Harleston Village Townhouse", kind: "rental", check_in: "2026-12-10", check_out: "2026-12-14", total_cents: 124_000, per_person_night_cents: 10_333, rating: 4.8, link: "https://example.com/r/0", booked_at: "2026-10-10T18:00:00Z" },
    });

    await addFundItem({ tripId: trip.id, kind: "stay", description: "Harleston Village Townhouse", amountCents: 124_000, key: "stay:test" });
    const accountId = await ensureFundAccount(trip);
    expect(accountId).toBeTruthy();
    const customer = [...fake.state.customers.values()].at(-1)!;
    expect(customer).toMatchObject({ first_name: "Charleston", last_name: "Trip Fund" });
    expect(fake.state.accounts.get(accountId!)).toMatchObject({ type: "Checking", nickname: "Charleston Trip Fund" });
    // Idempotent: a second call reuses the account.
    expect(await ensureFundAccount(trip)).toBe(accountId);

    const plan = await planContributions(trip, members.map((m) => m.id), "2026-10-10");
    expect(plan.deadline).toBe("2026-11-26");
    expect(plan.people.reduce((a, p) => a + p.shareCents, 0)).toBe(124_000);
    expect(plan.people.find((p) => p.personId === id("priya"))).toMatchObject({ bank: false, connected: false });
    expect(plan.people.find((p) => p.personId === id("maya"))).toMatchObject({ bank: true, connected: true });
    expect(plan.people.every((p) => p.plan.every((i) => i.dueDate > "2026-10-10" && i.dueDate <= "2026-11-26"))).toBe(true);
    // Re-planning the same share keeps the same rows.
    const again = await planContributions(trip, members.map((m) => m.id), "2026-10-10");
    expect(again.people.every((p) => p.unchanged)).toBe(true);

    // Nothing's in yet: the stay can't be paid.
    expect(await payDueItems(trip)).toEqual([]);

    for (const txn of (await fundTxns(trip.id)).filter((x) => x.kind === "contribution")) await executeContribution(txn, trip);
    const done = await fundTxns(trip.id, ["done"]);
    const mayaLink = (await linkFor(id("maya")))!;
    const transfers = [...fake.state.objects.values()].filter((o) => o.kind === "transfers");
    const deposits = [...fake.state.objects.values()].filter((o) => o.kind === "deposits" && o.account === accountId);
    expect(transfers.filter((o) => o.account === mayaLink.checking_id).length).toBe(plan.people.find((p) => p.personId === id("maya"))!.plan.length);
    expect(deposits.length).toBe(done.filter((d) => d.via === "bank").length);
    expect(done.filter((d) => d.person_id === id("priya")).every((d) => d.via === "ledger" && d.nessie_transfer_id === null)).toBe(true);
    expect((await fundTotals(trip.id)).collectedCents).toBe(124_000);

    // Covered: the stay is a purchase from the fund account at a merchant named after it.
    const paid = await payDueItems(trip);
    expect(paid.map((p) => p.description)).toEqual(["Harleston Village Townhouse"]);
    const purchase = [...fake.state.objects.values()].find((o) => o.kind === "purchases" && o.account === accountId)!;
    expect(fake.state.merchants.get(String(purchase.merchant_id))).toMatchObject({ name: "Harleston Village Townhouse" });
    expect((await fundTotals(trip.id)).balanceCents).toBe(0);

    // Refunds: back to a connected person's checking; ledger only for priya.
    const refundMaya = await refundFromFund(trip, id("maya"), 1_000, "refund:test:maya");
    expect(refundMaya.via).toBe("bank");
    expect(fake.state.objects.get(refundMaya.nessie_transfer_id!)).toMatchObject({ kind: "transfers", account: accountId });
    expect((await refundFromFund(trip, id("priya"), 1_000, "refund:test:priya")).via).toBe("ledger");
    // Idempotent by key.
    expect((await refundFromFund(trip, id("maya"), 1_000, "refund:test:maya")).id).toBe(refundMaya.id);

    // Every money movement is audited.
    const calls = await q<{ path: string }>(`SELECT path FROM nessie_calls WHERE method = 'POST' AND path LIKE '/accounts/%' AND ok`);
    expect(calls.some((c) => c.path.endsWith("/transfers"))).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/purchases"))).toBe(true);

    // The page: first names, no budgets, newest first.
    const site = (await siteFund(trip))!;
    expect(site.accountLabel).toBe("Capital One · Charleston Trip Fund");
    expect(site.targetCents).toBe(124_000);
    expect(site.collectedCents).toBe(122_000);
    expect(site.members.map((m) => m.name).sort()).toEqual(["Leo", "Maya", "Priya"]);
    expect(site.members.every((m) => m.nextCents === null)).toBe(true);
    expect(site.transactions[0]).toMatchObject({ kind: "refund" });
    expect(site.transactions.some((x) => x.kind === "purchase" && x.label === "Harleston Village Townhouse")).toBe(true);
    expect(JSON.stringify(site)).not.toMatch(/budget|\+1555/i);
    expect(siteStay(trip)).toEqual({ name: "Harleston Village Townhouse", kind: "rental", checkIn: "2026-12-10", checkOut: "2026-12-14", totalCents: 124_000, link: "https://example.com/r/0", rating: 4.8 });
  });

  it("works with no key at all: everything in the ledger", async () => {
    setClock(new FixedClock(new Date("2026-10-10T18:00:00Z")));
    setNessieClient(null);
    t = await testAtlas();
    const chat = t.chat("fund2", ["maya", "leo"]);
    await chat.addAtlas();
    const chatRow = (await findChat("sim", chat.id))!;
    const members = await activeMembers(chatRow.id);
    let trip = await tripFor(chatRow.id);
    trip = await updateTrip(trip.id, { destination_id: "charleston", destination_name: "Charleston", start_date: "2026-12-10", end_date: "2026-12-14", status: "locked" });
    await addFundItem({ tripId: trip.id, kind: "stay", description: "A rental", amountCents: 50_000, key: "stay:offline" });
    expect(await ensureFundAccount(trip)).toBeNull();
    await planContributions(trip, members.map((m) => m.id), "2026-10-10");
    for (const txn of await fundTxns(trip.id)) await executeContribution(txn, trip);
    expect((await fundTxns(trip.id, ["done"])).every((d) => d.via === "ledger")).toBe(true);
    expect((await payDueItems(trip)).length).toBe(1);
    expect((await fundTotals(trip.id)).balanceCents).toBe(0);
  });
});
