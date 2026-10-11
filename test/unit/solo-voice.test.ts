import { describe, expect, it } from "vitest";
import { soloText } from "../../src/transport/soloVoice.ts";

// Lines Atlas really sent in a private chat, built for a group.
describe("solo voice", () => {
  const solo = (t: string) => soloText(t, ["ayush"]);
  it("drops per-person and each from prices", () => {
    expect(solo("ok, three adventure options for 3 nights, dates tbd 👇\nper person, prices are estimates")).toBe("ok, three adventure options for 3 nights, dates tbd 👇\nprices are estimates");
    expect(solo("1. orlando — ~$765 each\n✈️ $160 · 🏠 $105 · 🍽 $500\nadventure for ayush")).toBe("1. orlando — ~$765\n✈️ $160 · 🏠 $105 · 🍽 $500\nadventure");
  });
  it("asks one person to pick, not a group to vote", () => {
    expect(solo("where are we going? tap to vote 🗳️")).toBe("which one sounds best? tap to pick 🗳️");
    expect(solo("🎉 orlando it is! 1 of 1 votes\nlocked in. now we just need dates")).toBe("🎉 orlando it is!\nlocked in. now just your dates");
  });
  it("talks about your travel, not everyone's", () => {
    expect(solo(`how everyone gets to orlando ✈️\n- ayush: need to know where you're leaving from\ntravel's on each of you, separate from the shared costs. say "i'll drive" or "i'll fly" to switch`)).toBe(
      `getting you to orlando ✈️\n- need to know where you're leaving from\nsay "i'll drive" or "i'll fly" to switch`,
    );
  });
  it("leaves one-on-one lines alone", () => {
    for (const t of ["you're connected ✓", "here's yours ayush 🔒", "where are you thinking of heading, and when?", "a table for 2 at 7pm"]) expect(solo(t)).toBe(t);
  });
});
