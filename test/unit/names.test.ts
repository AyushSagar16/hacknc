import { describe, expect, it } from "vitest";
import { isNameLine, laterNameAsk, NAME_QUESTION, parseNamedNumbers, parseOwnName } from "../../src/agent/features/names.ts";

describe("parseOwnName", () => {
  it.each([
    ["Ayush", "Ayush"],
    ["ayush sagar", "Ayush Sagar"],
    ["i'm ayush", "Ayush"],
    ["im maya!", "Maya"],
    ["it’s priya", "Priya"],
    ["hey, this is leo 👋", "Leo"],
    ["sam here!", "Sam"],
  ])("reads %s right after the ask", (text, name) => {
    expect(parseOwnName(text, true)).toBe(name);
  });

  it.each(["yes", "im down", "sounds good", "im so hungry", "asheville", "nov 12-14", "i paid 64 for dinner", "ok"])("%s isn't a name", (text) => {
    expect(parseOwnName(text, true)).toBeNull();
  });

  it("only takes a bare name while the ask is open", () => {
    expect(parseOwnName("ayush", false)).toBeNull();
    expect(parseOwnName("i'm ayush", false)).toBeNull();
    expect(parseOwnName("my name is ayush", false)).toBe("Ayush");
    expect(parseOwnName("call me jo", false)).toBe("Jo");
  });
});

describe("parseNamedNumbers", () => {
  const members = [
    { id: 1, handle: "+19195558005" },
    { id: 2, handle: "+19195559866" },
    { id: 3, handle: "+19195559938" },
  ];

  it("names people by the last four digits Atlas shows", () => {
    expect(parseNamedNumbers("8005 is maya, …9866 is leo and 9938 = priya", members).map((n) => [n.personId, n.name])).toEqual([
      [1, "Maya"],
      [2, "Leo"],
      [3, "Priya"],
    ]);
    expect(parseNamedNumbers("maya is ...8005", members).map((n) => n.name)).toEqual(["Maya"]);
    expect(parseNamedNumbers("+19195558005 is ayush", members).map((n) => n.name)).toEqual(["Ayush"]);
  });

  it("ignores numbers that aren't a member and words that aren't names", () => {
    expect(parseNamedNumbers("1200 is maya", members)).toEqual([]);
    expect(parseNamedNumbers("8005 is me", members)).toEqual([]);
    expect(parseNamedNumbers("my budget is 8005", members)).toEqual([]);
  });
});

describe("name lines", () => {
  it("are recognisable, so they don't close the connect question", () => {
    expect(isNameLine(NAME_QUESTION)).toBe(true);
    expect(isNameLine(laterNameAsk(["…8005", "…9866"]))).toBe(true);
    expect(laterNameAsk(["…8005", "…9866"])).toContain('like "8005 is maya"');
  });
});
