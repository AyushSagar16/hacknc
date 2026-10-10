// Automatic Nessie linking: the first time Atlas sees a person, it finds or creates a sandbox
// customer for them with checking, savings and a credit card, months of paychecks, recurring
// bills, autopay withdrawals and purchases across Atlas-created merchants. No manual step.
//
// The data is synthetic and the customer name is fictional ("<Name> Atlasdemo"); Nessie data
// is publicly visible, so real names and phone numbers never leave Atlas. Seeding is resumable:
// the profile is regenerated deterministically from the stored seed, and progress counters
// skip what was already created if a job retries.
import { config } from "../config.ts";
import { addDays, isoDate, now } from "../clock.ts";
import { childLog } from "../log.ts";
import { one, q } from "../db/pool.ts";
import { generateProfile, MERCHANTS, PERSONA_IDS, type AccountKey, type GeneratedProfile, type PersonaId } from "./personas.ts";
import { capabilities } from "./capabilities.ts";
import { NessieClient } from "./client.ts";

export interface LinkRow {
  person_id: number;
  persona: PersonaId;
  customer_id: string | null;
  checking_id: string | null;
  savings_id: string | null;
  credit_id: string | null;
  seed_status: "pending" | "seeding" | "ready" | "failed";
  seed_progress: SeedProgress;
  seeded_at: Date | null;
}

export interface SeedProgress {
  seedKey?: string;
  asOf?: string;
  months?: number;
  offline?: boolean;
  deposits?: number;
  withdrawals?: number;
  bills?: number;
  purchases?: number;
  error?: string;
}

let clientOverride: NessieClient | null | undefined;

/** The configured client, or null when no key is set (offline demo profiles). */
export function nessieClient(): NessieClient | null {
  if (clientOverride !== undefined) return clientOverride;
  const cfg = config();
  return cfg.NESSIE_API_KEY ? new NessieClient({ apiKey: cfg.NESSIE_API_KEY, baseUrl: cfg.NESSIE_BASE_URL }) : null;
}

let shared: NessieClient | null | undefined;
export function sharedNessie(): NessieClient | null {
  if (clientOverride !== undefined) return clientOverride;
  shared ??= nessieClient();
  return shared;
}

export function setNessieClient(client: NessieClient | null | undefined): void {
  clientOverride = client;
}

/** Personas are spread across people so a friend group's budgets differ. */
async function choosePersona(personId: number, pinned?: PersonaId): Promise<PersonaId> {
  if (pinned) return pinned;
  const rows = await q<{ persona: PersonaId; n: number }>(`SELECT persona, count(*)::int AS n FROM nessie_links GROUP BY persona`);
  const used = new Map(rows.map((r) => [r.persona, r.n]));
  const offset = personId % PERSONA_IDS.length;
  const ordered = [...PERSONA_IDS.slice(offset), ...PERSONA_IDS.slice(0, offset)];
  return ordered.reduce((best, p) => ((used.get(p) ?? 0) < (used.get(best) ?? 0) ? p : best), ordered[0]!);
}

export async function linkFor(personId: number): Promise<LinkRow | undefined> {
  return one<LinkRow>(`SELECT * FROM nessie_links WHERE person_id = $1`, [personId]);
}

export async function ensureLink(personId: number, opts: { persona?: PersonaId } = {}): Promise<LinkRow> {
  const existing = await linkFor(personId);
  if (existing) return existing;
  const persona = await choosePersona(personId, opts.persona);
  await q(`INSERT INTO nessie_links (person_id, persona, created_at) VALUES ($1, $2, $3) ON CONFLICT (person_id) DO NOTHING`, [personId, persona, now()]);
  return (await linkFor(personId))!;
}

export function profileFor(link: LinkRow): GeneratedProfile {
  const p = link.seed_progress;
  return generateProfile({ seedKey: p.seedKey ?? `atlas-${link.person_id}`, persona: link.persona, months: p.months ?? 6, asOf: p.asOf ?? isoDate(now()) });
}

async function saveProgress(personId: number, patch: Partial<LinkRow>): Promise<void> {
  const keys = Object.keys(patch) as (keyof LinkRow)[];
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE nessie_links SET ${sets} WHERE person_id = $1`, [personId, ...keys.map((k) => (k === "seed_progress" ? JSON.stringify(patch[k]) : patch[k]))]);
}

/** Merchants are shared by everyone's history; create each once and remember its id. */
export async function ensureMerchants(client: NessieClient): Promise<Map<string, string>> {
  const known = new Map((await q<{ name: string; merchant_id: string }>(`SELECT name, merchant_id FROM nessie_merchants`)).map((r) => [r.name, r.merchant_id]));
  const shape = capabilities().merchantCategory;
  for (const m of MERCHANTS) {
    if (known.has(m.name)) continue;
    const made = await client.createMerchant({ name: m.name, category: shape === "array" ? [m.category] : m.category, geocode: { lat: 35.9132, lng: -79.0558 } });
    await q(`INSERT INTO nessie_merchants (name, category, merchant_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING`, [m.name, m.category, made.id, now()]);
    known.set(m.name, made.id);
  }
  return known;
}

/** A merchant for trip expenses by category, e.g. "[atlas] trip food". */
export async function tripMerchant(client: NessieClient, category: string): Promise<string> {
  const name = `[atlas] trip ${category}`;
  const row = await one<{ merchant_id: string }>(`SELECT merchant_id FROM nessie_merchants WHERE name = $1`, [name]);
  if (row) return row.merchant_id;
  const made = await client.createMerchant({ name, category: capabilities().merchantCategory === "array" ? [category] : category });
  await q(`INSERT INTO nessie_merchants (name, category, merchant_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING`, [name, category, made.id, now()]);
  return made.id;
}

export async function seedPerson(personId: number, opts: { client?: NessieClient | null; months?: number; persona?: PersonaId } = {}): Promise<LinkRow> {
  const log = childLog({ component: "nessie.seed", personId });
  let link = await ensureLink(personId, { persona: opts.persona });
  if (link.seed_status === "ready") return link;
  const client = opts.client === undefined ? sharedNessie() : opts.client;
  const progress: SeedProgress = {
    seedKey: link.seed_progress.seedKey ?? `atlas-${personId}`,
    asOf: link.seed_progress.asOf ?? addDays(isoDate(now()), -1),
    months: link.seed_progress.months ?? opts.months ?? 6,
    ...link.seed_progress,
  };

  if (!client) {
    // No key: the same deterministic demo profile, computed locally and labeled as such.
    await saveProgress(personId, { seed_status: "ready", seed_progress: { ...progress, offline: true }, seeded_at: now() });
    return (await linkFor(personId))!;
  }

  await saveProgress(personId, { seed_status: "seeding", seed_progress: progress });
  link = (await linkFor(personId))!;
  const profile = profileFor(link);
  try {
    let customerId = link.customer_id;
    if (!customerId) {
      // Always the fictional persona name: Nessie data is public.
      customerId = (await client.createCustomer(profile.customer, personId)).id;
      await saveProgress(personId, { customer_id: customerId });
    }
    const ids: Record<AccountKey, string | null> = { checking: link.checking_id, savings: link.savings_id, credit: link.credit_id };
    for (const a of profile.accounts) {
      if (ids[a.key]) continue;
      ids[a.key] = (await client.createAccount(customerId, { type: a.type, nickname: a.nickname, rewards: a.rewards, balance: a.balance }, personId)).id;
      await saveProgress(personId, { [`${a.key}_id`]: ids[a.key] } as Partial<LinkRow>);
    }
    const merchants = await ensureMerchants(client);

    const post = async <T>(kind: "deposits" | "withdrawals" | "bills" | "purchases", items: T[], body: (item: T) => { account: string; body: Record<string, unknown> }) => {
      let done = progress[kind] ?? 0;
      for (let i = done; i < items.length; i += 4) {
        const chunk = items.slice(i, i + 4);
        await Promise.all(chunk.map((item) => {
          const b = body(item);
          return client.createOn(b.account, kind, b.body, personId);
        }));
        done = i + chunk.length;
        progress[kind] = done;
        await saveProgress(personId, { seed_progress: progress });
      }
    };
    const acct = (key: AccountKey) => ids[key]!;
    await post("deposits", profile.deposits, (d) => ({ account: acct(d.accountKey), body: { medium: d.medium, transaction_date: d.transaction_date, status: d.status, amount: d.amount, description: d.description } }));
    await post("withdrawals", profile.withdrawals, (w) => ({ account: acct(w.accountKey), body: { medium: w.medium, transaction_date: w.transaction_date, status: w.status, amount: w.amount, description: w.description } }));
    await post("bills", profile.bills, (b) => ({
      account: acct(b.accountKey),
      body: { status: b.status, payee: b.payee, nickname: b.nickname, payment_date: b.payment_date, recurring_date: b.recurring_date, payment_amount: b.payment_amount },
    }));
    await post("purchases", profile.purchases, (p) => ({
      account: acct(p.accountKey),
      body: { merchant_id: merchants.get(p.merchantName)!, medium: p.medium, purchase_date: p.purchase_date, amount: p.amount, status: p.status, description: p.description },
    }));
    await saveProgress(personId, { seed_status: "ready", seeded_at: now() });
    log.info({ persona: link.persona, customerId }, "nessie demo profile seeded");
  } catch (err) {
    await saveProgress(personId, { seed_status: "failed", seed_progress: { ...progress, error: (err as Error).message.slice(0, 300) } });
    throw err;
  }
  return (await linkFor(personId))!;
}
