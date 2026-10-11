// Atlas's iMessage number, for the homepage's "text Atlas" buttons. Set NEXT_PUBLIC_ATLAS_NUMBER
// (E.164) to point the site at a different line.
const FALLBACK = "+12055030484";

export const atlasNumber = (process.env.NEXT_PUBLIC_ATLAS_NUMBER || FALLBACK).replace(/[^\d+]/g, "");

// "?&body=" opens a prefilled message on both iOS (which reads "&body") and Android ("?body").
export const smsHref = `sms:${atlasNumber}?&body=${encodeURIComponent("hey atlas 👋")}`;

/** "+12055030484" → "(205) 503-0484"; other formats are shown as given. */
export function displayNumber(e164: string = atlasNumber): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
