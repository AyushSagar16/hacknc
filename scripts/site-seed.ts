// Publish a made-up Egypt trip (and a second trip in the same chat) to the trip-page store, so
// web/ can be built and checked without running Atlas. Uses SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY; prints the page URLs under SITE_BASE_URL (default localhost:3000).
//   npm run site:seed
import { randomUUID } from "node:crypto";
import { SupabaseSiteStore } from "../src/site/store.ts";
import type { SiteMessage, SiteResearch, SiteTrip } from "../src/site/types.ts";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const base = (process.env.SITE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const store = new SupabaseSiteStore(url, key);

const chatId = randomUUID();
const egyptId = randomUUID();
const japanId = randomUUID();

const egypt: SiteTrip = {
  id: egyptId,
  chatId,
  title: "Egypt",
  summary: "Cairo and Luxor are locked in for March 3–10. Flights from Raleigh are next: book by mid-January, then the Luxor balloon ride a few weeks out.",
  destination: "Cairo & Luxor",
  startDate: "2027-03-03",
  endDate: "2027-03-10",
  status: "locked",
  travelers: ["Maya", "Leo", "Priya", "Sam"],
  timezone: "America/New_York",
  overview: {
    stage: "Locked in: Cairo & Luxor.",
    options: [
      { name: "Cairo & Luxor", perPerson: "$1,240 (est.)", why: "history, food, warm in march", votes: 3 },
      { name: "Lisbon", perPerson: "$980 (est.)", why: "walkable, beaches nearby", votes: 1 },
      { name: "Marrakech", perPerson: "$1,060 (est.)", why: "markets, desert trips", votes: 0 },
    ],
    decision: "Cairo & Luxor won the vote (3 of 4).",
    booking: [
      { label: "flights from RDU", url: "https://www.google.com/travel/flights?q=Flights%20from%20RDU%20to%20CAI%20on%202027-03-03%20through%202027-03-10" },
      { label: "stays", url: "https://www.google.com/travel/hotels/Cairo?q=Cairo&dates=2027-03-03,2027-03-10" },
    ],
    stages: [
      { key: "location", label: "Location", status: "decided", detail: "Cairo & Luxor" },
      { key: "dates", label: "Dates", status: "decided", detail: "Mar 3–10" },
      { key: "travel", label: "Travel", status: "decided", detail: "all 4 fly from RDU" },
      { key: "stay", label: "Stay", status: "decided", detail: "Nile Garden Suites" },
      { key: "food_activities", label: "Food & activities", status: "in_progress" },
    ],
    fund: {
      accountLabel: "Capital One · Egypt Trip Fund",
      targetCents: 160_000,
      collectedCents: 112_000,
      deadline: "2027-02-17",
      members: [
        { name: "Maya", shareCents: 40_000, contributedCents: 40_000, nextCents: null, nextDate: null },
        { name: "Leo", shareCents: 40_000, contributedCents: 30_000, nextCents: 10_000, nextDate: "2027-01-15" },
        { name: "Priya", shareCents: 40_000, contributedCents: 24_000, nextCents: 8_000, nextDate: "2027-01-08" },
        { name: "Sam", shareCents: 40_000, contributedCents: 18_000, nextCents: 11_000, nextDate: "2027-01-15" },
      ],
      transactions: [
        { at: "2026-12-31T17:00:00Z", kind: "contribution", label: "Leo", amountCents: 10_000 },
        { at: "2026-12-24T17:00:00Z", kind: "contribution", label: "Priya", amountCents: 8_000 },
        { at: "2026-12-20T15:30:00Z", kind: "purchase", label: "Nile Garden Suites deposit", amountCents: 48_000 },
        { at: "2026-12-18T17:00:00Z", kind: "contribution", label: "Sam", amountCents: 9_000 },
        { at: "2026-12-15T17:00:00Z", kind: "contribution", label: "Maya", amountCents: 40_000 },
      ],
    },
  },
  itinerary: [
    { date: "2027-03-03", title: "Arrive", items: [{ name: "Dinner by the Nile in Zamalek", setting: "either", time: "8pm", notes: "Easy first night; the area is close to most hotels." }] },
    {
      date: "2027-03-04",
      title: "Pyramids day",
      items: [
        { name: "Giza pyramids & Sphinx", setting: "outdoor", cost: "~$25 pp", time: "7:30am", notes: "Go at opening before the heat and the tour buses." },
        { name: "Grand Egyptian Museum", setting: "indoor", cost: "~$30 pp", time: "1pm", notes: "Tutankhamun galleries; book timed entry online." },
      ],
    },
    {
      date: "2027-03-05",
      title: "Old Cairo + food",
      items: [
        { name: "Islamic Cairo & Khan el-Khalili", setting: "outdoor", time: "10am" },
        { name: "Koshary at Abou Tarek", setting: "indoor", cost: "~$3 pp", time: "lunch", notes: "Vegetarian, so it works for Leo." },
      ],
    },
    { date: "2027-03-06", title: "To Luxor", items: [{ name: "Sleeper train to Luxor", setting: "indoor", cost: "~$80 pp", time: "8pm", notes: "Book the 2-person cabins a few weeks ahead." }] },
    {
      date: "2027-03-07",
      title: "West Bank tombs",
      items: [
        { name: "Valley of the Kings", setting: "outdoor", cost: "~$30 pp", time: "7am" },
        { name: "Karnak at sunset", setting: "outdoor", time: "4pm" },
      ],
    },
    { date: "2027-03-08", title: "Balloon morning", items: [{ name: "Sunrise hot air balloon", setting: "outdoor", cost: "~$90 pp", time: "5am", notes: "Pickup is around 4:30; winds can cancel it, so it's early in the stay." }], note: "moved up a day for calmer winds" },
    { date: "2027-03-09", title: "Slow day", items: [{ name: "Felucca on the Nile", setting: "outdoor", cost: "~$15 pp", time: "4pm" }] },
    { date: "2027-03-10", items: [] },
  ],
  version: 3,
};

const japan: SiteTrip = {
  id: japanId,
  chatId,
  title: "Japan",
  summary: null,
  destination: null,
  startDate: null,
  endDate: null,
  status: "planning",
  travelers: egypt.travelers,
  timezone: egypt.timezone,
  overview: {
    stage: "Still gathering everyone's dates and home cities.",
    options: [],
    booking: [],
    stages: [
      { key: "location", label: "Location", status: "in_progress" },
      { key: "dates", label: "Dates", status: "open" },
      { key: "travel", label: "Travel", status: "open" },
      { key: "stay", label: "Stay", status: "open" },
      { key: "food_activities", label: "Food & activities", status: "open" },
    ],
  },
  itinerary: [],
  version: 1,
};

const now = Date.now();
const research: SiteResearch[] = [
  {
    topic: "Getting there & entry",
    summary: "US citizens can buy a $25 visa on arrival in Cairo or apply for an e-visa ahead of time.",
    bodyMd:
      "### Visa\nUS passport holders can get a **single-entry tourist visa** on arrival at Cairo airport (pay in USD cash at the bank counters before passport control), or apply for the e-visa online at least a week before.\n\n- Passport must be valid for 6+ months\n- Keep small USD bills for the visa and tips\n\n### Flights\nMost routes from the US connect through Europe or the Gulf. Book the Cairo–Luxor leg separately or take the sleeper train.",
    sources: [{ title: "visa2egypt.gov.eg", url: "https://visa2egypt.gov.eg" }, { title: "travel.state.gov", url: "https://travel.state.gov" }],
    createdAt: new Date(now - 60_000).toISOString(),
  },
  {
    topic: "Food",
    summary: "Koshary, ful and taameya are cheap, vegetarian-friendly staples; Zamalek has the best sit-down spots.",
    bodyMd:
      "Egyptian street food is mostly vegetarian by default.\n\n- **Koshary**: lentils, rice, pasta, tomato sauce, crispy onions\n- **Taameya**: fava-bean falafel, best in the morning\n- **Feteer**: flaky layered pastry, sweet or savory\n\nDrink bottled water and skip raw salads at street stalls.",
    sources: [{ title: "lonelyplanet.com", url: "https://www.lonelyplanet.com/egypt" }],
    createdAt: new Date(now - 30_000).toISOString(),
  },
];

const lines: [string, boolean, string][] = [
  ["Maya", false, "ok egypt in march?? i'm so in"],
  ["Leo", false, "only if we do the balloon thing in luxor"],
  ["Atlas", true, "cairo & luxor wins (3 of 4). locked in for mar 3–10 🎉"],
  ["Atlas", true, "wrote up the day-by-day plan, balloon ride included. it's on the trip page"],
  ["Priya", false, "do we need visas?"],
  ["Atlas", true, "did some digging on egypt:\ngetting there & entry: us citizens can buy a $25 visa on arrival or get the e-visa ahead"],
];
const messages: SiteMessage[] = lines.map(([sender, fromAtlas, text], i) => ({
  localId: i + 1,
  sender,
  fromAtlas,
  text,
  sentAt: new Date(now - (lines.length - i) * 5 * 60_000).toISOString(),
}));

await store.upsertTrip(egypt);
await store.upsertTrip(japan);
await store.upsertResearch(egyptId, research);
await store.upsertMessages(egyptId, messages);

console.log(`egypt:     ${base}/t/${egyptId}`);
console.log(`itinerary: ${base}/t/${egyptId}/itinerary`);
console.log(`research:  ${base}/t/${egyptId}/research`);
console.log(`chat:      ${base}/t/${egyptId}/chat`);
console.log(`japan:     ${base}/t/${japanId}`);
console.log(`hub:       ${base}/g/${chatId}`);
