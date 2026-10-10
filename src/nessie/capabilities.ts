// What the live Nessie API actually accepts, as recorded by `npm run nessie:probe` in
// data/nessie-capabilities.json. Defaults follow the most recent third-party reports (2026)
// until a probe has run: transfers can't name a payee, purchase/deposit amounts drop cents.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface NessieCapabilities {
  probedAt: string | null;
  /** POST /accounts/{id}/transfers accepts medium + payee_id (true P2P). */
  transferWithPayee: boolean;
  /** Deposit/purchase amounts keep cents (11.20 stays 11.20). */
  amountsKeepCents: boolean;
  /** DELETE /purchases/{id} works (for voiding a disputed expense). */
  purchaseDelete: boolean;
  /** Merchant category as a plain string ("food") vs an array (["food"]). */
  merchantCategory: "string" | "array";
  /** Account balance changes after transactions (it never has). */
  balanceUpdates: boolean;
  notes: string[];
}

export const DEFAULT_CAPABILITIES: NessieCapabilities = {
  probedAt: null,
  transferWithPayee: false,
  amountsKeepCents: false,
  purchaseDelete: false,
  merchantCategory: "string",
  balanceUpdates: false,
  notes: ["not probed yet — defaults from 2026 hackathon reports"],
};

let cached: NessieCapabilities | undefined;

export function capabilities(): NessieCapabilities {
  if (cached) return cached;
  try {
    const path = fileURLToPath(new URL("../../data/nessie-capabilities.json", import.meta.url));
    cached = { ...DEFAULT_CAPABILITIES, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<NessieCapabilities>) };
  } catch {
    cached = DEFAULT_CAPABILITIES;
  }
  return cached;
}

/** Nessie amount for a cents value: exact when the API keeps cents, else whole dollars (exact cents live in our ledger). */
export function nessieAmount(cents: number): number {
  return capabilities().amountsKeepCents ? Math.round(cents) / 100 : Math.round(cents / 100);
}
