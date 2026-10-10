// Probe the live Nessie API before trusting any payload shape. Creates one fictional probe
// customer, tries each documented shape, fails loudly with Nessie's error body, and writes:
//   docs/nessie-findings.md         what works, what doesn't, exact error bodies
//   data/nessie-capabilities.json   flags the app reads at runtime (src/nessie/capabilities.ts)
// Usage: npm run nessie:probe   (needs NESSIE_API_KEY; the key is never printed)
import { writeFile } from "node:fs/promises";
import { NessieClient, NessieError } from "../src/nessie/client.ts";
import { DEFAULT_CAPABILITIES, type NessieCapabilities } from "../src/nessie/capabilities.ts";

const key = process.env.NESSIE_API_KEY;
if (!key) {
  console.error("NESSIE_API_KEY is not set (put it in .env). Get one by signing in with GitHub at nessieisreal.com.");
  process.exit(1);
}
const client = new NessieClient({ apiKey: key, baseUrl: process.env.NESSIE_BASE_URL, persist: false, maxRetries: 1 });
const today = new Date().toISOString().slice(0, 10);
const log: string[] = [];
const caps: NessieCapabilities = { ...DEFAULT_CAPABILITIES, notes: [] };

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn();
    log.push(`- ✅ ${label}`);
    console.log(`✅ ${label}`);
    return value;
  } catch (err) {
    const detail = err instanceof NessieError ? `${err.status} ${err.body.slice(0, 300)}` : (err as Error).message;
    log.push(`- ❌ ${label}\n  \`${detail.replace(/`/g, "'")}\``);
    console.log(`❌ ${label}: ${detail}`);
    return undefined;
  }
}

// 1. Is the key real? Wrong keys return 200 [] on GETs, so prove it with a create.
const customer = await attempt("create customer (POST /customers)", () =>
  client.createCustomer({ first_name: "Probe", last_name: "Atlasdemo", address: { street_number: "1", street_name: "Probe St", city: "Chapel Hill", state: "NC", zip: "27514" } }),
);
if (!customer) {
  console.error("\nCould not create a customer: the key is probably wrong or Nessie is down. Nothing else to probe.");
  await writeFindings();
  process.exit(1);
}

// 2. Account types.
const accounts: Record<string, string> = {};
for (const type of ["Checking", "Savings", "Credit Card"]) {
  const made = await attempt(`create ${type} account`, () => client.createAccount(customer.id, { type, nickname: `probe ${type}`, rewards: 0, balance: 1000 }));
  if (made) accounts[type] = made.id;
}
const checking = accounts.Checking;
const savings = accounts.Savings;
if (!checking || !savings) {
  await writeFindings();
  process.exit(1);
}

// 3. Merchants: category as string vs array.
let merchantId: string | undefined;
const asString = await attempt("create merchant with category string", () => client.createMerchant({ name: "Atlas Probe Cafe", category: "food", address: { street_number: "1", street_name: "Probe St", city: "Chapel Hill", state: "NC", zip: "27514" }, geocode: { lat: 35.91, lng: -79.05 } }));
if (asString) {
  merchantId = asString.id;
  caps.merchantCategory = "string";
} else {
  const asArray = await attempt("create merchant with category array", () => client.createMerchant({ name: "Atlas Probe Cafe", category: ["food"], geocode: { lat: 35.91, lng: -79.05 } }));
  if (asArray) {
    merchantId = asArray.id;
    caps.merchantCategory = "array";
  }
}

// 4. Deposits keep cents?
const dep = await attempt("create deposit 12.34", () =>
  client.createOn(checking, "deposits", { medium: "balance", transaction_date: today, status: "completed", amount: 12.34, description: "probe deposit" }),
);
if (dep) {
  const back = await attempt("read deposits back", () => client.listOn<Record<string, unknown>[]>(checking, "deposits"));
  const amount = back?.value.find((d) => d._id === dep.id)?.amount;
  caps.amountsKeepCents = amount === 12.34;
  caps.notes.push(`deposit 12.34 read back as ${JSON.stringify(amount)}`);
}

// 5. Withdrawals, purchases, bills.
await attempt("create withdrawal", () => client.createOn(checking, "withdrawals", { medium: "balance", transaction_date: today, status: "completed", amount: 5, description: "probe withdrawal" }));
const purchase = merchantId
  ? await attempt("create purchase (completed)", () => client.createOn(checking, "purchases", { merchant_id: merchantId, medium: "balance", purchase_date: today, amount: 7, status: "completed", description: "probe purchase" }))
  : undefined;
await attempt("list purchases", () => client.listOn(checking, "purchases"));
await attempt("create bill (pending, one-off)", () => client.createOn(checking, "bills", { status: "pending", payee: "Probe Payee", nickname: "probe bill", payment_date: today, recurring_date: 1, payment_amount: 9.5 }));
await attempt("create bill (recurring)", () => client.createOn(checking, "bills", { status: "recurring", payee: "Probe Rent", nickname: "probe rent", payment_date: today, recurring_date: 1, payment_amount: 1200 }));
await attempt("list bills", () => client.listOn(checking, "bills"));

// 6. Transfers: the documented P2P shape first, then the stripped shape.
const p2p = await attempt("create transfer with medium + payee_id (P2P)", () =>
  client.createOn(checking, "transfers", { medium: "balance", payee_id: savings, amount: 3, transaction_date: today, status: "completed", description: "probe p2p transfer" }),
);
caps.transferWithPayee = Boolean(p2p);
if (!p2p) await attempt("create transfer without payee (payer side only)", () => client.createOn(checking, "transfers", { transaction_date: today, status: "completed", amount: 3, description: "probe transfer" }));
await attempt("list transfers (may 404 when empty)", () => client.listOn(checking, "transfers"));

// 7. Does the balance move?
const acct = await attempt("read checking account", () => client.account(checking));
caps.balanceUpdates = acct?.value.balance !== 1000;
caps.notes.push(`checking balance after transactions: ${JSON.stringify(acct?.value.balance)} (opened at 1000)`);

// 8. Can a purchase be removed (for disputed expenses)?
if (purchase) caps.purchaseDelete = Boolean(await attempt("DELETE /purchases/{id}", async () => {
  const ok = await client.remove(`/purchases/${purchase.id}`);
  if (!ok) throw new Error("delete returned non-2xx");
  return ok;
}));

caps.probedAt = new Date().toISOString();
await writeFindings();
console.log("\nwrote docs/nessie-findings.md and data/nessie-capabilities.json");

async function writeFindings(): Promise<void> {
  const md = [
    "# Nessie findings",
    "",
    `Probed ${new Date().toISOString()} against ${process.env.NESSIE_BASE_URL ?? "https://api.nessieisreal.com"} by \`npm run nessie:probe\`.`,
    "All objects created are fictional (customer \"Probe Atlasdemo\"). Nessie data is publicly visible, so Atlas never sends real names or phone numbers.",
    "",
    "## Results",
    ...log,
    "",
    "## Capabilities the app uses",
    "```json",
    JSON.stringify(caps, null, 2),
    "```",
    "",
    "## How Atlas adapts",
    `- Transfers: ${caps.transferWithPayee ? "native P2P (payer account → payee account)." : "payer-side transfer plus a matching payee-side deposit, linked by the settlement's idempotency key."}`,
    `- Amounts: ${caps.amountsKeepCents ? "sent with cents." : "sent as whole dollars; exact cents live in Atlas's ledger and the Nessie description."}`,
    `- Balances: ${caps.balanceUpdates ? "read from Nessie." : "replayed from transactions (Nessie never updates balance)."}`,
    `- Disputed expenses: ${caps.purchaseDelete ? "the Nessie purchase is deleted and re-created." : "a correcting deposit offsets the original purchase."}`,
  ].join("\n");
  await writeFile("docs/nessie-findings.md", `${md}\n`);
  await writeFile("data/nessie-capabilities.json", `${JSON.stringify(caps, null, 2)}\n`);
}
