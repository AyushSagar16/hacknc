// Google Travel deep links (the natural-language q= form) so friends can check and book prices
// themselves. Atlas never books anything.

export function googleFlightsLink(origin: string, dest: string, start: string, end: string): string {
  const q = `Flights to ${dest.trim()} from ${origin.trim()} on ${start} through ${end}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

export function googleHotelsLink(destName: string, start: string, end: string, adults: number): string {
  const n = Math.max(1, Math.round(adults));
  const q = `${destName.trim()} hotels ${start} to ${end} for ${n} ${n === 1 ? "adult" : "adults"}`;
  return `https://www.google.com/travel/hotels?q=${encodeURIComponent(q)}`;
}
