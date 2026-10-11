// Simulator steps for stay searches, so scenarios never touch SerpApi:
//   stays test/fixtures/serpapi/google_hotels_charleston.json | test/fixtures/serpapi/google_vacation_rentals_charleston.json
//   stays estimate        no live answer: find_stays falls back to labeled estimates
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setStayFixture } from "../trips/stays.ts";
import type { Extension } from "./extensions.ts";
import type { SimSession } from "./session.ts";

export function staysSimExtension(_session: SimSession): Record<string, Extension> {
  // A fresh session starts with no fixture (one scenario's never leaks into the next).
  setStayFixture(undefined);
  return {
    stays: async (args) => {
      if (args.trim() === "estimate") {
        setStayFixture({});
        return;
      }
      const [hotels, rentals] = args
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!hotels) throw new Error("usage: stays <hotels.json> [| <rentals.json>] | stays estimate");
      const load = async (f: string | undefined) => (f ? (JSON.parse(await readFile(resolve(f), "utf8")) as unknown) : undefined);
      setStayFixture({ hotels: await load(hotels), rentals: await load(rentals) });
    },
  };
}
