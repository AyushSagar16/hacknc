// Deterministic synthetic Nessie profiles. One seed key -> one obviously fictional customer
// (last name "Atlasdemo" + a letter) with months of paychecks, recurring bills, autopay
// withdrawals and card purchases, shaped like Nessie request bodies so a seeder can POST
// them as-is. Pure: no I/O, no clock; the same inputs always give the same profile.
import { addDays } from "../clock.ts";
import type { LedgerAccount, LedgerTxn, RecurringBill } from "../money/budget.ts";

export type PersonaId = "barista_student" | "new_grad_engineer" | "nurse_high_rent" | "freelancer" | "grad_ta" | "big_saver";
export type PayCadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "irregular";
export type MerchantCategory =
  | "food"
  | "groceries"
  | "transport"
  | "entertainment"
  | "shopping"
  | "health"
  | "travel"
  | "personal_care"
  | "education";
export type AccountKey = "checking" | "savings" | "credit";

export interface PersonaBill {
  payee: string;
  nickname: string;
  amountCents: number;
  /** Day of month, 1-28. */
  day: number;
}

export interface PersonaSpec {
  label: string;
  /** Shown as "Payroll: <employer>" on every paycheck. */
  employer: string;
  cadence: PayCadence;
  /** Net dollars per paycheck; for irregular pay, per month (split over 1-3 client payments). */
  paycheckDollars: readonly [number, number];
  bills: readonly PersonaBill[];
  purchasesPerMonth: readonly [number, number];
  /** Total purchase dollars per month (debit + credit); individual amounts are scaled to it. */
  spendDollars: readonly [number, number];
  categoryWeights: Partial<Record<MerchantCategory, number>>;
  /** Fraction of purchases on the credit card, paid off from checking on the 20th. */
  creditShare: number;
  /** Whole-dollar balances on the first day of the history. */
  openingBalances: { checking: number; savings: number; credit: number };
  /** On the 28th, checking above `above` dollars moves to savings or an outside brokerage. */
  sweep: { above: number; to: "savings" | "brokerage" } | null;
}

export interface GeneratedAccount {
  key: AccountKey;
  type: "Checking" | "Savings" | "Credit Card";
  nickname: string;
  rewards: number;
  /** Whole dollars at history start (the engine replays everything after it). */
  balance: number;
}

export interface GeneratedDeposit {
  accountKey: "checking" | "savings";
  medium: "balance";
  transaction_date: string;
  status: "completed";
  /** Whole dollars. Paychecks start with "Payroll:". */
  amount: number;
  description: string;
}

/** Same body as a deposit; POST to /accounts/{id}/withdrawals. */
export type GeneratedWithdrawal = GeneratedDeposit;

export interface GeneratedBill {
  accountKey: "checking";
  status: "recurring";
  payee: string;
  nickname: string;
  /** Most recent payment on or before asOf. */
  payment_date: string;
  recurring_date: number;
  /** Dollars, may have cents. */
  payment_amount: number;
}

export interface GeneratedPurchase {
  accountKey: "checking" | "credit";
  merchantName: string;
  category: string;
  medium: "balance";
  purchase_date: string;
  /** Whole dollars. */
  amount: number;
  status: "completed";
  description: string;
}

export interface GeneratedProfile {
  persona: PersonaId;
  label: string;
  historyStart: string;
  asOf: string;
  customer: {
    first_name: string;
    last_name: string;
    address: { street_number: string; street_name: string; city: string; state: string; zip: string };
  };
  accounts: GeneratedAccount[];
  deposits: GeneratedDeposit[];
  /** Bill autopay, credit card autopay and month-end sweeps. Without these, unpaid bills inflate the replayed balance. */
  withdrawals: GeneratedWithdrawal[];
  bills: GeneratedBill[];
  purchases: GeneratedPurchase[];
}

export interface GenerateOptions {
  seedKey: string;
  persona?: PersonaId;
  /** History length, clamped to 6..12 whole months before asOf's month (plus asOf's month to date). */
  months: number;
  asOf: string;
}

export const PERSONA_IDS: readonly PersonaId[] = [
  "barista_student",
  "new_grad_engineer",
  "nurse_high_rent",
  "freelancer",
  "grad_ta",
  "big_saver",
];

const bill = (payee: string, nickname: string, dollars: number, day: number): PersonaBill => ({
  payee,
  nickname,
  amountCents: Math.round(dollars * 100),
  day,
});

// Tuned so that, for a trip about a month out, budgets land roughly at: barista ~$150,
// grad TA ~$225, nurse ~$375, freelancer anywhere from ~$100 to ~$700 (lumpy income),
// big saver ~$1,400, engineer ~$1,500. The engineer sweeps checking into a brokerage
// each month, so the balance cap (not the free-cash formula) sets that budget.
export const PERSONAS: Record<PersonaId, PersonaSpec> = {
  barista_student: {
    label: "part-time barista + full-time student",
    employer: "Bean Counter Coffee Co",
    cadence: "weekly",
    paycheckDollars: [230, 310],
    bills: [
      bill("Maple Court Apartments", "Rent (my share)", 395, 1),
      bill("Sandbox Wireless", "Phone plan", 35, 9),
      bill("Fiberfox Internet", "Wi-fi (split 3 ways)", 22, 14),
      bill("Loopcast Music", "Music subscription", 10.99, 20),
    ],
    purchasesPerMonth: [14, 20],
    spendDollars: [260, 330],
    categoryWeights: { food: 35, groceries: 20, transport: 12, entertainment: 12, shopping: 8, personal_care: 5, education: 8 },
    creditShare: 0.2,
    openingBalances: { checking: 520, savings: 250, credit: 180 },
    sweep: null,
  },
  new_grad_engineer: {
    label: "new-grad software engineer, first year on the job",
    employer: "Lattice Labs Inc",
    cadence: "biweekly",
    paycheckDollars: [3300, 3400],
    bills: [
      bill("Skyline Lofts", "Rent", 1650, 1),
      bill("Ironleaf Fitness", "Gym membership", 40, 16),
      bill("Steadyhand Insurance", "Car insurance", 128, 18),
      bill("Sandbox Wireless", "Phone plan", 65, 22),
      bill("StreamNest", "Streaming bundle", 15.99, 24),
      bill("Mortarboard Loan Servicing", "Student loan", 380, 26),
    ],
    purchasesPerMonth: [22, 30],
    spendDollars: [850, 1050],
    categoryWeights: { food: 30, groceries: 15, transport: 12, entertainment: 15, shopping: 15, travel: 5, personal_care: 4, health: 4 },
    creditShare: 0.8,
    openingBalances: { checking: 2400, savings: 150, credit: 640 },
    sweep: { above: 2000, to: "brokerage" },
  },
  nurse_high_rent: {
    label: "night-shift nurse paying big-city rent",
    employer: "Riverbend General Hospital",
    cadence: "biweekly",
    paycheckDollars: [2180, 2420],
    bills: [
      bill("Harborview Towers", "Rent", 2450, 1),
      bill("Lakeside Auto Finance", "Car payment", 310, 6),
      bill("Citylight Power & Water", "Utilities", 95, 15),
      bill("Steadyhand Insurance", "Car insurance", 165, 18),
      bill("Sandbox Wireless", "Phone plan", 75, 22),
    ],
    purchasesPerMonth: [18, 24],
    spendDollars: [650, 780],
    categoryWeights: { food: 30, groceries: 25, transport: 15, health: 8, shopping: 10, entertainment: 7, personal_care: 5 },
    creditShare: 0.4,
    openingBalances: { checking: 3400, savings: 2200, credit: 900 },
    sweep: { above: 3400, to: "savings" },
  },
  freelancer: {
    label: "freelance designer with lumpy client payments",
    employer: "client payment",
    cadence: "irregular",
    paycheckDollars: [2600, 4600],
    bills: [
      bill("Cedar Row Flats", "Rent", 1250, 1),
      bill("Brightpath Health Plan", "Health insurance", 380, 5),
      bill("Canvas Cloud Suite", "Design software", 54.99, 11),
      bill("Fiberfox Internet", "Internet", 70, 14),
      bill("Sandbox Wireless", "Phone plan", 60, 22),
    ],
    purchasesPerMonth: [16, 24],
    spendDollars: [600, 760],
    categoryWeights: { food: 28, groceries: 20, transport: 10, entertainment: 10, shopping: 14, education: 8, personal_care: 5, travel: 5 },
    creditShare: 0.5,
    openingBalances: { checking: 5000, savings: 4500, credit: 400 },
    sweep: { above: 5000, to: "savings" },
  },
  grad_ta: {
    label: "grad student on a teaching stipend",
    employer: "State University TA stipend",
    cadence: "monthly",
    paycheckDollars: [2140, 2140],
    bills: [
      bill("Oakwood Commons", "Rent", 1150, 1),
      bill("Citywide Transit", "Transit pass", 25, 2),
      bill("Sandbox Wireless", "Phone plan", 40, 9),
      bill("Fiberfox Internet", "Internet (split)", 30, 14),
      bill("StreamNest", "Streaming", 7.99, 20),
    ],
    purchasesPerMonth: [12, 18],
    spendDollars: [380, 440],
    categoryWeights: { food: 30, groceries: 30, transport: 8, entertainment: 10, education: 14, personal_care: 4, health: 4 },
    creditShare: 0.15,
    openingBalances: { checking: 1900, savings: 900, credit: 250 },
    sweep: null,
  },
  big_saver: {
    label: "analyst who saves half of every paycheck",
    employer: "Meridian Analytics Group",
    cadence: "semimonthly",
    paycheckDollars: [2340, 2360],
    bills: [
      bill("Willow Park Residences", "Rent (split with partner)", 1100, 1),
      bill("StreamNest", "Streaming", 8.99, 8),
      bill("Citylight Power & Water", "Utilities", 70, 15),
      bill("Steadyhand Insurance", "Renter's + auto insurance", 92, 18),
      bill("Sandbox Wireless", "Phone plan", 35, 22),
    ],
    purchasesPerMonth: [12, 16],
    spendDollars: [520, 640],
    categoryWeights: { groceries: 35, food: 20, transport: 15, health: 8, shopping: 8, entertainment: 8, personal_care: 6 },
    creditShare: 0.75,
    openingBalances: { checking: 1500, savings: 16500, credit: 120 },
    sweep: { above: 2000, to: "savings" },
  },
};

export const MERCHANTS: readonly { name: string; category: MerchantCategory }[] = [
  { name: "Bean Counter Coffee", category: "food" },
  { name: "Noodle Theory", category: "food" },
  { name: "Late Night Slice", category: "food" },
  { name: "Sunny Side Diner", category: "food" },
  { name: "Greenleaf Grocers", category: "groceries" },
  { name: "Corner Basket Market", category: "groceries" },
  { name: "Harvest Bin Co-op", category: "groceries" },
  { name: "Metro Ride Share", category: "transport" },
  { name: "Fill-Up Fuel Stop", category: "transport" },
  { name: "Citywide Transit Kiosk", category: "transport" },
  { name: "ParkPal Garage", category: "transport" },
  { name: "Starlight Cinemas", category: "entertainment" },
  { name: "Pixel Arcade Bar", category: "entertainment" },
  { name: "Encore Ticket Hub", category: "entertainment" },
  { name: "Loopcast Live", category: "entertainment" },
  { name: "Thread & Needle Outfitters", category: "shopping" },
  { name: "Gadget Grove", category: "shopping" },
  { name: "Hometown Goods", category: "shopping" },
  { name: "Wellspring Pharmacy", category: "health" },
  { name: "Clearview Optical", category: "health" },
  { name: "Skyhop Air", category: "travel" },
  { name: "Roadside Inn & Suites", category: "travel" },
  { name: "Clip Joint Barbers", category: "personal_care" },
  { name: "Lather & Leaf Spa", category: "personal_care" },
  { name: "Page Turner Books", category: "education" },
  { name: "Quill Online Courses", category: "education" },
];

// Raw per-purchase dollar ranges; a month's purchases are then scaled to its spend total.
const CATEGORY_DOLLARS: Record<MerchantCategory, readonly [number, number]> = {
  food: [6, 24],
  groceries: [28, 95],
  transport: [6, 38],
  entertainment: [12, 55],
  shopping: [18, 110],
  health: [10, 45],
  travel: [45, 220],
  personal_care: [12, 48],
  education: [15, 85],
};

const FIRST_NAMES = ["Avery", "Jordan", "Riley", "Quinn", "Morgan", "Casey", "Rowan", "Emerson", "Harper", "Parker", "Reese", "Sage", "Tatum", "Wren", "Ellis", "Marlo"];
const STREETS = ["Sandbox Ave", "Synthetic St", "Placeholder Pl", "Fixture Way", "Demo Loop", "Mock Orchard Rd", "Testbed Ln", "Seed Data Ct"];
const CITIES = [
  { city: "Chapel Hill", zip: "27514" },
  { city: "Durham", zip: "27701" },
  { city: "Raleigh", zip: "27601" },
  { city: "Carrboro", zip: "27510" },
  { city: "Greensboro", zip: "27401" },
];
const CLIENTS = ["Pinecone Creative", "Bluebird Media Co", "Copperleaf Brands", "Harborlight Agency", "Fernway Events"];
const SAVINGS_APY = 0.04;

/** Stable persona for a seed key (FNV-1a). */
export function pickPersona(seedKey: string): PersonaId {
  return PERSONA_IDS[fnv1a(seedKey) % PERSONA_IDS.length]!;
}

export function generateProfile(opts: GenerateOptions): GeneratedProfile {
  const { seedKey, asOf } = opts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got "${asOf}"`);
  const months = Math.min(12, Math.max(6, Math.round(opts.months)));
  const persona = opts.persona ?? pickPersona(seedKey);
  const spec = PERSONAS[persona];
  const rng = mulberry32(fnv1a(`profile|${seedKey}|${persona}`));

  const startMonth = shiftMonth(asOf.slice(0, 7), -months);
  const historyStart = `${startMonth}-01`;
  const monthList: string[] = [];
  for (let m = startMonth; m <= asOf.slice(0, 7); m = shiftMonth(m, 1)) monthList.push(m);

  const deposits: GeneratedDeposit[] = paychecks(spec, rng, monthList, historyStart, asOf).map(([date, amount, description]) =>
    entry("checking", date, amount, description),
  );
  const purchases = monthList.flatMap((ym) => monthPurchases(spec, rng, ym, asOf));
  const withdrawals: GeneratedWithdrawal[] = [];

  for (const ym of monthList) {
    for (const b of spec.bills) {
      const date = `${ym}-${pad(b.day)}`;
      if (date <= asOf) withdrawals.push(entry("checking", date, Math.round(b.amountCents / 100), `Autopay: ${b.payee} (${b.nickname.toLowerCase()})`));
    }
  }
  // Card autopay on the 20th settles the previous month's credit purchases.
  monthList.slice(1).forEach((ym, i) => {
    const date = `${ym}-20`;
    const prev = monthList[i]!;
    const owed = purchases.filter((p) => p.accountKey === "credit" && p.purchase_date.startsWith(prev)).reduce((s, p) => s + p.amount, 0);
    if (date <= asOf && owed > 0) withdrawals.push(entry("checking", date, owed, "Credit card autopay: Atlas demo card"));
  });

  const balanceOn = (key: "checking" | "savings", date: string): number => {
    let balance = spec.openingBalances[key];
    for (const d of deposits) if (d.accountKey === key && d.transaction_date <= date) balance += d.amount;
    for (const w of withdrawals) if (w.accountKey === key && w.transaction_date <= date) balance -= w.amount;
    if (key === "checking") for (const p of purchases) if (p.accountKey === "checking" && p.purchase_date <= date) balance -= p.amount;
    return balance;
  };
  for (const ym of monthList) {
    const sweepDate = `${ym}-28`;
    if (spec.sweep && sweepDate <= asOf) {
      const excess = Math.floor((balanceOn("checking", sweepDate) - spec.sweep.above) / 50) * 50;
      if (excess >= 50) {
        const toSavings = spec.sweep.to === "savings";
        withdrawals.push(entry("checking", sweepDate, excess, toSavings ? "Transfer to savings" : "Transfer to brokerage: Atlas demo index account"));
        if (toSavings) deposits.push(entry("savings", sweepDate, excess, "Transfer from checking"));
      }
    }
    const end = monthEnd(ym);
    if (end <= asOf) {
      const interest = Math.floor((balanceOn("savings", end) * SAVINGS_APY) / 12);
      if (interest >= 1) deposits.push(entry("savings", end, interest, "Interest payment"));
    }
  }

  const bills: GeneratedBill[] = spec.bills.map((b) => {
    const thisMonth = `${asOf.slice(0, 7)}-${pad(b.day)}`;
    return {
      accountKey: "checking",
      status: "recurring",
      payee: b.payee,
      nickname: b.nickname,
      payment_date: thisMonth <= asOf ? thisMonth : `${shiftMonth(asOf.slice(0, 7), -1)}-${pad(b.day)}`,
      recurring_date: b.day,
      payment_amount: b.amountCents / 100,
    };
  });

  const byDate = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    persona,
    label: spec.label,
    historyStart,
    asOf,
    customer: syntheticCustomer(seedKey),
    accounts: [
      { key: "checking", type: "Checking", nickname: "Atlas demo checking", rewards: 0, balance: spec.openingBalances.checking },
      { key: "savings", type: "Savings", nickname: "Atlas demo savings", rewards: 0, balance: spec.openingBalances.savings },
      { key: "credit", type: "Credit Card", nickname: "Atlas demo card", rewards: 100 + (fnv1a(`rewards|${seedKey}`) % 4900), balance: spec.openingBalances.credit },
    ],
    deposits: deposits.sort(byDate((d) => d.transaction_date)),
    withdrawals: withdrawals.sort(byDate((w) => w.transaction_date)),
    bills,
    purchases: purchases.sort(byDate((p) => p.purchase_date)),
  };
}

/** The budget engine's input for a generated profile, so budgets can be computed without Nessie. */
export function profileToLedger(
  profile: GeneratedProfile,
  ids: Record<AccountKey, string> = { checking: "checking", savings: "savings", credit: "credit" },
): { accounts: LedgerAccount[]; txns: LedgerTxn[]; bills: RecurringBill[] } {
  const cents = (dollars: number) => Math.round(dollars * 100);
  const txns: LedgerTxn[] = [
    ...profile.deposits.map((d): LedgerTxn => ({ accountId: ids[d.accountKey], kind: "deposit", date: d.transaction_date, amountCents: cents(d.amount), description: d.description })),
    ...profile.withdrawals.map((w): LedgerTxn => ({ accountId: ids[w.accountKey], kind: "withdrawal", date: w.transaction_date, amountCents: cents(w.amount), description: w.description })),
    ...profile.purchases.map((p): LedgerTxn => ({
      accountId: ids[p.accountKey],
      kind: "purchase",
      date: p.purchase_date,
      amountCents: cents(p.amount),
      description: p.description,
      category: p.category,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    accounts: profile.accounts.map((a) => ({ id: ids[a.key], type: a.type, openingBalanceCents: cents(a.balance) })),
    txns,
    bills: profile.bills.map((b) => ({
      accountId: ids[b.accountKey],
      payee: b.payee,
      amountCents: cents(b.payment_amount),
      recurringDay: b.recurring_date,
      status: b.status,
      description: b.nickname,
    })),
  };
}

type Rng = () => number;

function paychecks(spec: PersonaSpec, rng: Rng, monthList: string[], start: string, asOf: string): [string, number, string][] {
  const [lo, hi] = spec.paycheckDollars;
  const description = `Payroll: ${spec.employer}`;
  const out: [string, number, string][] = [];
  // Calendar-day pay moves back to Friday on weekends, so next month's 1st can land in this one.
  const calendarMonths = [...monthList, shiftMonth(monthList.at(-1)!, 1)];
  const keep = (date: string) => date >= start && date <= asOf;

  switch (spec.cadence) {
    case "weekly":
    case "biweekly": {
      const step = spec.cadence === "weekly" ? 7 : 14;
      let date = nextFriday(start);
      if (step === 14 && rng() < 0.5) date = addDays(date, 7);
      for (; date <= asOf; date = addDays(date, step)) out.push([date, randInt(rng, lo, hi), description]);
      break;
    }
    case "semimonthly":
    case "monthly": {
      const doms = spec.cadence === "semimonthly" ? [1, 15] : [25];
      for (const ym of calendarMonths) {
        for (const dom of doms) {
          const date = previousBusinessDay(`${ym}-${pad(dom)}`);
          if (keep(date)) out.push([date, randInt(rng, lo, hi), description]);
        }
      }
      break;
    }
    case "irregular": {
      let invoice = 1000 + randInt(rng, 0, 400);
      for (const ym of monthList) {
        const count = randInt(rng, 1, 3);
        let total = randInt(rng, lo, hi);
        if (rng() < 0.1) total = Math.round(total * 0.55); // a dry month
        const weights = Array.from({ length: count }, () => 0.4 + rng());
        const sum = weights.reduce((s, w) => s + w, 0);
        const days = new Set<number>();
        while (days.size < count) {
          const day = randInt(rng, 1, daysInMonth(ym));
          if (!isWeekend(`${ym}-${pad(day)}`)) days.add(day);
        }
        const sortedDays = [...days].sort((a, b) => a - b);
        let paid = 0;
        sortedDays.forEach((day, i) => {
          const amount = i === count - 1 ? total - paid : Math.floor((total * weights[i]!) / sum);
          paid += amount;
          const client = CLIENTS[randInt(rng, 0, CLIENTS.length - 1)]!;
          const date = `${ym}-${pad(day)}`;
          if (keep(date)) out.push([date, amount, `Payroll: ${client} invoice ${invoice++}`]);
        });
      }
      break;
    }
  }
  return out;
}

function monthPurchases(spec: PersonaSpec, rng: Rng, ym: string, asOf: string): GeneratedPurchase[] {
  const count = randInt(rng, ...spec.purchasesPerMonth);
  const target = randInt(rng, ...spec.spendDollars);
  const weights = Object.entries(spec.categoryWeights) as [MerchantCategory, number][];
  const drafts = Array.from({ length: count }, () => {
    const category = weighted(rng, weights);
    const options = MERCHANTS.filter((m) => m.category === category);
    const merchant = options[randInt(rng, 0, options.length - 1)]!;
    const [lo, hi] = CATEGORY_DOLLARS[category];
    return {
      merchant,
      raw: lo + rng() * (hi - lo),
      date: `${ym}-${pad(randInt(rng, 1, daysInMonth(ym)))}`,
      onCredit: rng() < spec.creditShare,
    };
  });
  const scale = target / drafts.reduce((s, d) => s + d.raw, 0);
  return drafts
    .filter((d) => d.date <= asOf)
    .map((d) => ({
      accountKey: d.onCredit ? "credit" : "checking",
      merchantName: d.merchant.name,
      category: d.merchant.category,
      medium: "balance",
      purchase_date: d.date,
      amount: Math.max(2, Math.round(d.raw * scale)),
      status: "completed",
      description: `${d.onCredit ? "Card" : "Debit"} purchase at ${d.merchant.name}`,
    }));
}

function syntheticCustomer(seedKey: string): GeneratedProfile["customer"] {
  const rng = mulberry32(fnv1a(`customer|${seedKey}`));
  const place = CITIES[randInt(rng, 0, CITIES.length - 1)]!;
  return {
    first_name: FIRST_NAMES[randInt(rng, 0, FIRST_NAMES.length - 1)]!,
    last_name: `Atlasdemo${String.fromCharCode(65 + randInt(rng, 0, 25))}`,
    address: {
      street_number: String(randInt(rng, 100, 9899)),
      street_name: STREETS[randInt(rng, 0, STREETS.length - 1)]!,
      city: place.city,
      state: "NC",
      zip: place.zip,
    },
  };
}

function entry(accountKey: "checking" | "savings", date: string, amount: number, description: string): GeneratedDeposit {
  return { accountKey, medium: "balance", transaction_date: date, status: "completed", amount, description };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function weighted<T>(rng: Rng, options: [T, number][]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [value, w] of options) {
    roll -= w;
    if (roll < 0) return value;
  }
  return options.at(-1)![0];
}

function nextFriday(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, (5 - dow + 7) % 7);
}

function isWeekend(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function previousBusinessDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 6 ? addDays(day, -1) : dow === 0 ? addDays(day, -2) : day;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(ym: string): number {
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
}

function monthEnd(ym: string): string {
  return `${ym}-${pad(daysInMonth(ym))}`;
}

function shiftMonth(ym: string, delta: number): string {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
