// Simulator steps for off-catalog places, so scenarios never touch the network:
//   geocode boone, nc | 36.2168 -81.6746 | United States | North Carolina    answer a lookup
//   geocode miss atlantis                                                    "no such place"
// Lookups that aren't stubbed go to the real Open-Meteo geocoder.
import { stubGeocode } from "../trips/geocode.ts";
import type { Extension } from "./extensions.ts";
import type { SimSession } from "./session.ts";

export function placesSimExtension(_session: SimSession): Record<string, Extension> {
  return {
    "geocode miss": async (args) => {
      if (!args.trim()) throw new Error("usage: geocode miss <place>");
      stubGeocode(args.trim(), null);
    },
    geocode: async (args) => {
      const [query, coords, country, admin1] = args.split("|").map((s) => s.trim());
      const m = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(coords ?? "");
      if (!query || !m) throw new Error("usage: geocode <place> | <lat> <lon> | <country> [| <state>]");
      const name = query.split(",")[0]!.trim().replace(/\b\w/g, (c) => c.toUpperCase());
      stubGeocode(query, {
        name,
        lat: Number(m[1]),
        lon: Number(m[2]),
        ...(country ? { country, ...(country === "United States" ? { countryCode: "US" } : {}) } : {}),
        ...(admin1 ? { admin1 } : {}),
      });
    },
  };
}
