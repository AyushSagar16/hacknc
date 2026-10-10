// WMO weather code -> one of five planning categories, plus a short lowercase phrase for chat.

export type WeatherCategory = "clear" | "cloudy" | "rain" | "storm" | "snow";

/** Below this precipitation probability a wet code is treated as just cloudy. */
export const LOW_PRECIP_PCT = 35;

function category(code: number): WeatherCategory {
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3 || code === 45 || code === 48) return "cloudy";
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "cloudy"; // codes Open-Meteo doesn't emit for daily data: stay neutral
}

/**
 * Daily weather_code is the worst hour of the day, so a 10% shower chance still reports rain.
 * Any wet code with a known probability under 35% downgrades to "cloudy".
 */
export function classify(code: number, precipProbability: number | null): WeatherCategory {
  const base = category(code);
  if (isWet(base) && precipProbability !== null && precipProbability < LOW_PRECIP_PCT) return "cloudy";
  return base;
}

export function isWet(c: WeatherCategory): boolean {
  return c === "rain" || c === "storm" || c === "snow";
}

export function isDry(c: WeatherCategory): boolean {
  return c === "clear" || c === "cloudy";
}

/** "sunny, 78°", "cloudy, 64°", "rain", "thunderstorms", "snow". */
export function describe(c: WeatherCategory, tempMaxF: number | null): string {
  const temp = tempMaxF === null || !Number.isFinite(tempMaxF) ? "" : `, ${Math.round(tempMaxF)}°`;
  switch (c) {
    case "clear":
      return `sunny${temp}`;
    case "cloudy":
      return `cloudy${temp}`;
    case "rain":
      return "rain";
    case "storm":
      return "thunderstorms";
    case "snow":
      return "snow";
  }
}
