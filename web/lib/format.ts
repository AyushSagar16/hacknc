// Date and text formatting shared by pages and OG images. Dates are plain YYYY-MM-DD strings
// (no timezone), so they're read at noon UTC and printed in UTC.

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  return day(iso).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

/** "Mar 3–10", "Mar 28 – Apr 2", or "" when dates aren't set. */
export function formatRange(start: string | null, end: string | null): string {
  if (!start || !end) return start ? formatDate(start) : "";
  const a = day(start);
  const b = day(end);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const yearSuffix = sameYear && a.getUTCFullYear() !== new Date().getUTCFullYear() ? `, ${a.getUTCFullYear()}` : "";
  if (sameYear && a.getUTCMonth() === b.getUTCMonth()) return `${formatDate(start)}–${b.getUTCDate()}${yearSuffix}`;
  return `${formatDate(start)} – ${formatDate(end)}${yearSuffix}`;
}

export function weekday(iso: string): string {
  return formatDate(iso, { weekday: "short", month: "short", day: "numeric" });
}

export function nights(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  return Math.round((day(end).getTime() - day(start).getTime()) / 86_400_000);
}

const STATUS: Record<string, string> = {
  planning: "planning",
  voting: "voting",
  locked: "locked in",
  ongoing: "happening now",
  settling: "settling up",
  done: "done",
};
export const statusLabel = (s: string) => STATUS[s] ?? s;

/** "4 travelers · locked in · 7 nights" */
export function tripFacts(t: { travelers: string[]; status: string; startDate: string | null; endDate: string | null }): string {
  const n = nights(t.startDate, t.endDate);
  return [t.travelers.length ? `${t.travelers.length} traveler${t.travelers.length === 1 ? "" : "s"}` : "", statusLabel(t.status), n ? `${n} night${n === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** "$1,200" or "$12.50" from cents. */
export function money(cents: number): string {
  const abs = Math.abs(cents);
  const s = (abs / 100).toLocaleString("en-US", { minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `${cents < 0 ? "−" : ""}$${s}`;
}

export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Turn an itinerary into a one-line description for previews. */
export function itineraryLine(days: { date: string; items: { name: string }[] }[], max = 160): string {
  const parts = days.map((d) => `${formatDate(d.date, { weekday: "short" })}: ${d.items.map((i) => i.name).join(", ") || "free day"}`);
  return clip(parts.join(" · "), max);
}
