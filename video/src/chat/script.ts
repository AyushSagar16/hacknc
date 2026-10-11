// The group chat the whole middle of the video plays out in. Wording follows what Atlas actually
// says (src/agent/brain.ts, features/*, test/scenarios/*.chat); names, places and figures are mocked.
import { Msg } from "./types";

// Chapters of the chat act, in frames at 30 fps. Each one's start is the sum of those before it.
export const CHAPTERS = {
  join: 180,
  connect: 390,
  reads: 300,
  options: 300,
  stay: 210,
  fund: 270,
  food: 210,
  split: 330,
} as const;

export type Chapter = keyof typeof CHAPTERS;

export const START = (() => {
  const out = {} as Record<Chapter, number>;
  let t = 0;
  for (const k of Object.keys(CHAPTERS) as Chapter[]) {
    out[k] = t;
    t += CHAPTERS[k];
  }
  return out;
})();

export const CHAT_ACT_DURATION = Object.values(CHAPTERS).reduce(
  (a, b) => a + b,
  0,
);

// Phone side per chapter; the canvas content takes the other side.
export const SIDE: Record<Chapter, "left" | "right"> = {
  join: "right",
  connect: "left",
  reads: "right",
  options: "left",
  stay: "right",
  fund: "left",
  food: "right",
  split: "left",
};

const J = START.join;
const C = START.connect;
const R = START.reads;
const O = START.options;
const S = START.stay;
const F = START.fund;
const D = START.food;
const X = START.split;

// Consent sheet timing (connect chapter).
export const CONNECT_SHEET = { open: C + 112, tap: C + 186, close: C + 222 };

export const MESSAGES: Msg[] = [
  // Already in the thread when we arrive.
  {
    kind: "text",
    at: -60,
    from: "leo",
    text: "ok we're actually doing a trip this fall",
  },
  { kind: "text", at: -40, from: "priya", text: "famous last words 💀" },
  {
    kind: "text",
    at: -20,
    from: "maya",
    text: "not this time. adding someone 👀",
  },

  // join
  { kind: "system", at: J + 26, text: "Maya added Atlas to the conversation." },
  {
    kind: "text",
    at: J + 62,
    from: "atlas",
    typing: 22,
    text: "hi, i'm atlas, your trip and financial planner 👋 i'll keep track of what everyone wants and can spend, and help you all actually book this thing",
  },
  {
    kind: "text",
    at: J + 118,
    from: "atlas",
    typing: 16,
    text: "so where are we thinking, and when?\nalso, want to connect your capital one so i can plan around real budgets?",
  },

  // connect
  { kind: "text", at: C + 28, from: "maya", typing: 16, text: "yes" },
  {
    kind: "text",
    at: C + 62,
    from: "atlas",
    typing: 16,
    text: "here's yours maya 🔒",
  },
  {
    kind: "link",
    at: C + 80,
    from: "atlas",
    title: "Connect your Capital One to Atlas",
    art: "connect",
  },
  {
    kind: "text",
    at: C + 256,
    from: "atlas",
    typing: 14,
    text: "maya's connected ✓",
  },
  {
    kind: "text",
    at: C + 292,
    from: "leo",
    typing: 12,
    text: "wait what's our budget?",
  },
  {
    kind: "text",
    at: C + 334,
    from: "atlas",
    typing: 16,
    text: "💰 budgets stay private, so here's just the pooled number: everyone's good up to $600 each",
  },

  // reads
  {
    kind: "text",
    at: R + 52,
    from: "maya",
    typing: 32,
    text: "ok real talk, i'm free nov 12–16, leaving from raleigh, and i want a beach",
  },
  {
    kind: "text",
    at: R + 104,
    from: "leo",
    typing: 18,
    text: "cancun is too pricey for me and i'm vegetarian. same dates, i'd leave from durham",
  },
  {
    kind: "text",
    at: R + 156,
    from: "priya",
    typing: 18,
    text: "12–16 works but i can only do driving distance. i'm all about food",
  },
  {
    kind: "text",
    at: R + 206,
    from: "atlas",
    typing: 18,
    text: "maya wants a beach and priya's more of a food person, and priya can only drive. a beach town with a real food scene covers both",
  },
  {
    kind: "text",
    at: R + 244,
    from: "leo",
    typing: 10,
    text: "lol did anyone see the game last night",
  },
  { kind: "text", at: R + 266, from: "priya", typing: 8, text: "insane 😭" },

  // options
  {
    kind: "text",
    at: O + 30,
    from: "maya",
    typing: 20,
    text: "atlas give us some options",
  },
  {
    kind: "text",
    at: O + 66,
    from: "atlas",
    typing: 18,
    text: "three options for nov 12–16, per person (estimates):\n1. Charleston · ~$520 · beach + big food scene\n2. Savannah · ~$555 · walkable, veg friendly\n3. Wilmington · ~$470 · beach, short drive",
  },
  {
    kind: "poll",
    at: O + 100,
    from: "atlas",
    title: "where are we going? 🗳️",
    options: [
      {
        label: "Charleston",
        votes: [
          { who: "maya", at: O + 130 },
          { who: "leo", at: O + 158 },
        ],
      },
      { label: "Savannah", votes: [{ who: "priya", at: O + 178 }] },
      { label: "Wilmington", votes: [] },
    ],
  },
  {
    kind: "text",
    at: O + 222,
    from: "atlas",
    typing: 16,
    text: "🎉 charleston it is! 2 of 3 votes. locked in for nov 12–16",
  },

  // stay
  {
    kind: "text",
    at: S + 20,
    from: "priya",
    typing: 14,
    text: "atlas how's everyone getting there?",
  },
  {
    kind: "text",
    at: S + 50,
    from: "atlas",
    typing: 14,
    text: "how everyone gets to charleston 🚗\n- maya and leo: carpool from raleigh/durham, ~4h, ~$31 each for gas\n- priya: drive from charlotte, ~3h, ~$38 for gas",
  },
  {
    kind: "text",
    at: S + 96,
    from: "atlas",
    typing: 12,
    text: "🏠 places to stay in charleston, nov 12–16 (4 nights for 3)\n1. Wagener Terrace Bungalow · sleeps 4 · $55/person/night · ★4.6\n2. King St Loft · sleeps 4 · $71/person/night · ★4.7\n3. Harleston Village Townhouse · sleeps 6 · $103/person/night · ★4.8",
  },
  {
    kind: "text",
    at: S + 140,
    from: "maya",
    typing: 16,
    text: "3!! that porch 😍",
    react: { emoji: "👍", at: S + 152 },
  },
  {
    kind: "text",
    at: S + 178,
    from: "atlas",
    typing: 12,
    text: "🏠 booked ✓ Harleston Village Townhouse\nnov 12–16 · $1,240 total, $413.33 each\nthe stay's on the trip fund",
  },

  // fund
  {
    kind: "text",
    at: F + 24,
    from: "atlas",
    typing: 14,
    text: "🏦 charleston trip fund: $1,240 ($1,240 for the stay)\neveryone puts in $413.33, in small payments on your paydays. all in by oct 29",
  },
  { kind: "system", at: F + 96, text: "Friday 9:00 AM" },
  {
    kind: "text",
    at: F + 112,
    from: "atlas",
    typing: 12,
    text: "💸 trip fund: maya $137.78, leo $137.78 and priya $137.78 went in ✓ fund's at $413.34 / $1,240",
  },
  { kind: "system", at: F + 170, text: "Thursday, Oct 29 9:00 AM" },
  {
    kind: "text",
    at: F + 186,
    from: "atlas",
    typing: 12,
    text: "🏦 fund's at $1,240 / $1,240, fully funded ✓\nHarleston Village Townhouse is paid in full from the fund ✓",
  },
  {
    kind: "text",
    at: F + 232,
    from: "priya",
    typing: 10,
    text: "wait that was painless??",
    react: { emoji: "‼️", at: F + 250 },
  },

  // food
  {
    kind: "text",
    at: D + 16,
    from: "atlas",
    typing: 14,
    text: "🍽️ places to eat near the townhouse (vegetarian-friendly for leo)\n1. Basic Kitchen: veggie-forward, 4.6★, 6 min walk\n2. Xiao Bao Biscuit: asian comfort, 4.5★, 9 min walk\n3. Babas on Cannon: café, 4.7★, 7 min walk",
  },
  {
    kind: "text",
    at: D + 54,
    from: "atlas",
    typing: 10,
    text: "🎟️ things to do near the townhouse\n4. Folly Beach day: 25 min drive\n5. Fort Sumter ferry: 12 min drive\n6. Music Farm: live music, 8 min walk",
  },
  { kind: "text", at: D + 94, from: "leo", typing: 12, text: "add 1 and 6" },
  {
    kind: "text",
    at: D + 124,
    from: "atlas",
    typing: 10,
    text: "✓ added basic kitchen (thu 11/12, dinner) and music farm (fri 11/13, night) to the plan",
  },
  {
    kind: "link",
    at: D + 156,
    from: "atlas",
    title: "Charleston itinerary",
    caption: "Nov 12–16 · 4 days, 3 picks on the plan",
    art: "trip",
  },

  // split
  { kind: "system", at: X + 6, text: "Friday, Nov 13 9:42 PM" },
  {
    kind: "text",
    at: X + 34,
    from: "maya",
    typing: 20,
    text: "i paid 90 for dinner",
  },
  {
    kind: "text",
    at: X + 64,
    from: "atlas",
    typing: 12,
    text: "logged #1: dinner $90.00, paid by maya. split 3 ways: leo and priya owe maya $30.00 each",
  },
  {
    kind: "text",
    at: X + 104,
    from: "priya",
    typing: 12,
    text: "i got leo's ticket, $40",
  },
  {
    kind: "text",
    at: X + 132,
    from: "atlas",
    typing: 10,
    text: "logged #2: ticket $40.00, paid by priya. leo owes $40.00",
  },
  {
    kind: "text",
    at: X + 172,
    from: "leo",
    typing: 12,
    text: "atlas let's settle up",
  },
  {
    kind: "text",
    at: X + 204,
    from: "atlas",
    typing: 12,
    text: 'settle-up, the fewest transfers that square everything (2):\nleo → maya $60.00\nleo → priya $10.00\nleo, reply "confirm" and i\'ll send them',
  },
  { kind: "text", at: X + 248, from: "leo", typing: 10, text: "confirm" },
  {
    kind: "text",
    at: X + 276,
    from: "atlas",
    typing: 10,
    text: "✓ sent: leo → maya $60.00, leo → priya $10.00\nall settled up 🎉",
  },
];

// Moments that get the confirmation chime.
export const DINGS = [C + 256, O + 222, S + 178, F + 186, X + 276];
