import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.ts";
import { FakeLlm, jsonResult, LlmError, type GenerateRequest } from "../../src/agent/llm.ts";
import type { ToolCtx } from "../../src/agent/tools.ts";
import type { Action } from "../../src/transport/outbound.ts";
import { academicYear, BUSY, cacheKey, resetSearchRest, clearSearchCache, lookup, parseLookup, searchQueryFor, setSearchFetch, webSearch } from "../../src/agent/features/search.ts";
import { clip, dietLabel, formatItem, formatList, MAX_ITEM_CHARS, rangeLabel, stripArtifacts } from "../../src/search/format.ts";
import { appearsIn, groundItems, norm } from "../../src/search/verify.ts";
import { excerpt, linkable, pageText, parseDdgHtml, resolveRedirect, unwrapDdg } from "../../src/search/web.ts";

// A unit test has no database: what web_search finds would otherwise be saved to the trip page.
vi.mock("../../src/agent/features/research.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agent/features/research.ts")>()),
  saveLookupToTrip: async () => {},
}));

const cfg = { GEMINI_MODEL_AGENT: "gemini-test", GEMINI_MODEL_GATE: "gemini-cheap", AGENT_NAME: "atlas" } as unknown as Config;

const ddgResult = (url: string, title: string, snippet: string, ad = false) =>
  `<div class="result results_links results_links_deep web-result${ad ? " result--ad" : ""}"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${title}</a></h2><a class="result__snippet" href="x">${snippet}</a></div>`;

const DDG_PAGE = [
  ddgResult("https://ads.example.com/x", "Ad", "buy", true),
  ddgResult("https://www.gatlinburg.com/winter/", "Winter in <b>Gatlinburg</b>", "Winterfest lights &amp; more"),
  ddgResult("https://www.nps.gov/grsm/index.htm", "Great Smoky Mountains", "hiking"),
].join("\n");

const filler = "<p>" + "plan your visit to the smokies with our guide to lodging, parking and seasonal hours. ".repeat(8) + "</p>";
/** Pages the fake web serves (anything else 404s, like a blocked site). */
const PAGES: Record<string, string> = {
  "https://www.gatlinburg.com/winter/": `<html><body><nav>menu</nav>${filler}<h2>Winter fun</h2><p>Great Smoky Mountains National Park trails stay open. Gatlinburg Winterfest Lights glow through February. Ober Mountain has skiing and tubing.</p><p>Dollywood Smoky Mountain Christmas runs Nov 7 - Jan 3.</p><script>var x = "Mountain Medley Bistro";</script></body></html>`,
  "https://www.nps.gov/grsm/index.htm": `<html><body>${filler}<p>Hike to Laurel Falls or watch sunrise at Clingmans Dome.</p></body></html>`,
  "https://en.wikivoyage.org/wiki/Gatlinburg": `<html><body>${filler}<h2>Eat</h2><p>The Wild Plum Tea Room has vegetarian plates. Crockett's Breakfast Camp serves big breakfasts. Bistro 109 has a veggie menu.</p></body></html>`,
};

function fakeFetch(html = DDG_PAGE, calls: string[] = [], pages: Record<string, string> = PAGES): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("vertexaisearch")) return new Response(null, { status: 302, headers: { location: "https://www.visitmysmokies.com/winter" } });
    if (url.includes("duckduckgo")) return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const page = pages[url];
    return page ? new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
}

function ctx(llm: FakeLlm, extra: Partial<ToolCtx> = {}): ToolCtx & { out: Action[] } {
  const out: Action[] = [];
  return {
    cfg,
    llm,
    chat: { id: 7, is_group: true, timezone: "America/New_York" },
    trip: { id: 1, chat_id: 7, destination_name: "Gatlinburg, TN", start_date: "2026-12-14", end_date: "2026-12-17" },
    turnId: 3,
    senderId: 1,
    sourceMessageId: 1,
    members: [{ id: 1 }, { id: 2 }, { id: 3 }],
    out,
    today: "2026-10-10",
    now: new Date("2026-10-10T12:00:00Z"),
    notes: new Map(),
    view: async () => ({
      dates: null,
      wants: new Map([["mountains", { name: "mountains", people: ["sai"] }]]),
      likes: new Map(),
      dislikes: new Map(),
      dietary: new Map([["vegetarian", ["leo"]]]),
      vetoes: new Map(),
      limits: [],
    }),
    ...extra,
  } as unknown as ToolCtx & { out: Action[] };
}

const LIST = {
  heading: "**Top things to do in Gatlinburg in December**",
  items: [
    { name: "**Great Smoky Mountains**", detail: "Sunrise at Clingmans Dome or an easy hike to Laurel Falls [1]" },
    { name: "Gatlinburg Winterfest Lights", detail: "the whole town is lit up through february [cite: 2] (https://gatlinburg.com)" },
    { name: "Ober Mountain", detail: "skiing + tubing, 10 min up the tramway, tickets from $45 per person" },
    { name: "Dollywood Smoky Mountain Christmas", detail: "20 min away in pigeon forge" },
  ],
  source: 1,
};

describe("format", () => {
  it("strips citations, markdown, urls and prices", () => {
    expect(stripArtifacts("**Ober** [1] is fun [cite: 2, 3] see https://x.com/a 【4†source】")).toBe("Ober is fun see");
    expect(stripArtifacts("lift tickets ($45-$60) are worth it")).toBe("lift tickets are worth it");
    expect(stripArtifacts("skiing, from $45 per person")).toBe("skiing");
    expect(stripArtifacts("north america's longest bridge")).toBe("north america's longest bridge");
    expect(stripArtifacts("[the park](https://nps.gov) is open")).toBe("the park is open");
  });

  it("formats a numbered lowercase list within the item limit", () => {
    const text = formatList(LIST.heading, LIST.items)!;
    expect(text).toBe(
      [
        "top things to do in gatlinburg in december:",
        "1. great smoky mountains — sunrise at clingmans dome or an easy hike to laurel falls",
        "2. gatlinburg winterfest lights — the whole town is lit up through february",
        "3. ober mountain — skiing + tubing, 10 min up the tramway",
        "4. dollywood smoky mountain christmas — 20 min away in pigeon forge",
      ].join("\n"),
    );
    for (const line of text.split("\n").slice(1)) expect(line.length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect(text).not.toMatch(/[*$[\]]|https?:/);
  });

  it("shortens long details at a clause instead of mid-thought", () => {
    const line = formatItem({ name: "great smoky mountains national park", detail: "great for hiking snow dusted trails to waterfalls, and catching sunrise over the ridges at clingmans dome" }, 1)!;
    expect(line.length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect(line).toBe("1. great smoky mountains national park — great for hiking snow dusted trails to waterfalls");
    expect(clip("walk across the longest bridge for high", 38)).toBe("walk across the longest bridge");
  });

  it("needs at least two items and drops duplicates", () => {
    expect(formatList("x", [{ name: "a" }, { name: "A" }])).toBeNull();
    expect(formatList("", [{ name: "a" }, { name: "b" }, { name: "c" }])).toBe("here's what i found:\n1. a\n2. b\n3. c");
    expect(formatList("x", [{ name: "a" }, { name: "b" }])).toBe("x:\n1. a\n2. b");
  });

  it("labels dates and dietary asks", () => {
    expect(rangeLabel("2026-12-16", "2026-12-23")).toBe("dec 16–23");
    expect(rangeLabel("2026-12-30", "2027-01-02")).toBe("dec 30 – jan 2");
    expect(dietLabel("vegetarian food in gatlinburg")).toBe("veggie-friendly");
    expect(dietLabel("bbq in austin")).toBeNull();
  });
});

describe("web helpers", () => {
  it("parses duckduckgo results, unwrapping links and skipping ads", () => {
    const r = parseDdgHtml(DDG_PAGE);
    expect(r).toEqual([
      { title: "Winter in Gatlinburg", url: "https://www.gatlinburg.com/winter/", snippet: "Winterfest lights & more" },
      { title: "Great Smoky Mountains", url: "https://www.nps.gov/grsm/index.htm", snippet: "hiking" },
    ]);
    expect(unwrapDdg("//duckduckgo.com/y.js?ad=1")).toBeNull();
  });

  it("resolves grounding redirects or omits them", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    expect(await resolveRedirect(redirect, { fetch: fakeFetch() })).toBe("https://www.visitmysmokies.com/winter");
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await resolveRedirect(redirect, { fetch: failing })).toBeNull();
    expect(linkable(redirect)).toBe(false);
    expect(linkable("https://www.facebook.com/x")).toBe(false);
    expect(linkable("https://catalog.unc.edu/calendar.pdf")).toBe(false);
    expect(linkable("https://www.gatlinburg.com/winter/")).toBe(true);
  });
});

describe("dates", () => {
  it("asks about the current academic year", () => {
    expect(academicYear("2026-10-10")).toBe("2026-27");
    expect(academicYear("2027-02-01")).toBe("2026-27");
    expect(searchQueryFor({ query: "nc state winter break", purpose: "dates", today: "2026-10-10" })).toBe("nc state winter break 2026-27 academic calendar");
    expect(searchQueryFor({ query: "unc winter break 2026", purpose: "dates", today: "2026-10-10" })).toBe("unc winter break 2026");
  });

  it("validates ranges and marks stale or broken ones low", () => {
    expect(parseLookup("dates", JSON.stringify({ start: "2026-12-12", end: "2027-01-05", confidence: "high", note: "last exam dec 11 [1]" }), "2026-10-10")).toEqual({
      kind: "dates",
      start: "2026-12-12",
      end: "2027-01-05",
      confidence: "high",
      note: "last exam dec 11",
    });
    expect(parseLookup("dates", JSON.stringify({ start: "2025-12-12", end: "2026-01-05", confidence: "high", note: "" }), "2026-10-10")).toMatchObject({ confidence: "low" });
    expect(parseLookup("dates", JSON.stringify({ start: "dec 12", end: "", confidence: "high", note: "" }), "2026-10-10")).toMatchObject({ start: null, end: null, confidence: "low" });
  });
});

describe("web_search tool", () => {
  beforeEach(() => {
    clearSearchCache();
    resetSearchRest();
    setSearchFetch(fakeFetch(DDG_PAGE));
    process.env.GEMINI_SEARCH_GROUNDING = "0"; // these answer from gemini's own knowledge
  });
  afterEach(() => {
    resetSearchRest();
    setSearchFetch(undefined);
    delete process.env.GEMINI_SEARCH_GROUNDING;
  });

  it("without grounding, gemini answers from what it knows: a list fitted to the group, no link", async () => {
    const llm = new FakeLlm({ search: () => jsonResult(LIST) });
    const c = ctx(llm);
    const r = await webSearch.run({ query: "things to do in gatlinburg in december", purpose: "things_to_do" }, c);
    expect(r.ok).toBe(true);
    expect(c.out).toHaveLength(1);
    expect((c.out[0] as { text: string }).text).toMatch(/^things to do in gatlinburg in december:\n1\. great smoky mountains — /);
    const req = llm.calls[0]!;
    expect(req.builtinTools).toBeUndefined();
    expect(req.system).toContain("answer from what you know");
    const prompt = JSON.stringify(req.contents);
    expect(prompt).toContain("sai wants mountains");
    expect(prompt).toContain("leo: vegetarian");
    expect(prompt).toContain("trip dates: 2026-12-14 to 2026-12-17 (december)");
    expect(webSearch.soloPost).toBe(true);
  });

  it("leads food lists with the ask", async () => {
    const real = { heading: "top places to eat in gatlinburg in december", items: [{ name: "Wild Plum Tea Room", detail: "vegetarian plates" }, { name: "Bistro 109", detail: "veggie menu" }] };
    const d = ctx(new FakeLlm({ search: () => jsonResult(real) }));
    expect((await webSearch.run({ query: "vegetarian food in gatlinburg", purpose: "food" }, d)).ok).toBe(true);
    expect((d.out[0] as { text: string }).text).toBe("veggie-friendly spots in gatlinburg:\n1. wild plum tea room — vegetarian plates\n2. bistro 109 — veggie menu");
  });

  it("events: keeps dated ones inside the trip, else says nothing big is on", async () => {
    const events = {
      heading: "events",
      items: [
        { name: "Dollywood Smoky Mountain Christmas", detail: "lights and shows", start: "2026-11-07", end: "2027-01-03", dated: true },
        { name: "Gatlinburg Winterfest Lights", detail: "the whole town lit up", start: "2026-11-10", end: "2027-02-28", dated: true },
        { name: "Ober Mountain", detail: "skiing and tubing", dated: false },
      ],
    };
    const c = ctx(new FakeLlm({ search: () => jsonResult(events) }));
    expect((await webSearch.run({ query: "events in gatlinburg that week", purpose: "events" }, c)).ok).toBe(true);
    expect((c.out[0] as { text: string }).text).toBe(
      "what's on in gatlinburg dec 14–17:\n1. dollywood smoky mountain christmas — nov 7 – jan 3: lights and shows\n2. gatlinburg winterfest lights — nov 10 – feb 28: the whole town lit up",
    );

    clearSearchCache();
    const undated = { heading: "x", items: [{ name: "Ober Mountain", detail: "skiing and tubing", dated: false }, { name: "Laurel Falls", detail: "easy waterfall hike", dated: false }, { name: "Dollywood Smoky Mountain Christmas", detail: "shows", start: "2026-06-01", end: "2026-06-05", dated: true }] };
    const d = ctx(new FakeLlm({ search: () => jsonResult(undated) }));
    await webSearch.run({ query: "events in gatlinburg that week", purpose: "events" }, d);
    expect((d.out[0] as { text: string }).text).toMatch(/^nothing big that i can find that week — here's what's always good:\n1\. ober mountain/);
  });

  it("caches repeated questions (normalized) instead of calling again", async () => {
    const llm = new FakeLlm({ search: () => jsonResult(LIST) });
    await webSearch.run({ query: "Things to do in Gatlinburg in December?", purpose: "things_to_do" }, ctx(llm));
    const again = ctx(llm);
    await webSearch.run({ query: "things to do in gatlinburg in december", purpose: "things_to_do" }, again);
    expect(llm.calls).toHaveLength(1);
    expect(again.out[0]).toMatchObject({ type: "say" });
    expect(cacheKey({ query: "A b?", purpose: "food", context: [] })).toBe(cacheKey({ query: "a  b", purpose: "food", context: [] }));
  });

  it("returns dates as data without posting; from memory they're never high confidence", async () => {
    const llm = new FakeLlm({ search: () => jsonResult({ start: "2026-12-12", end: "2027-01-05", confidence: "high", note: "last fall exam dec 11, spring starts jan 6" }) });
    const c = ctx(llm);
    const r = await webSearch.run({ query: "unc chapel hill winter break", purpose: "dates" }, c);
    expect(c.out).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, data: { start: "2026-12-12", end: "2027-01-05", confidence: "medium", source: null } });
    expect(llm.calls[0]!.system).toContain("2026-27 academic year");
  });

  it("fails softly with a human reply on model errors and timeouts", async () => {
    const broken = new FakeLlm({
      search: () => {
        throw new LlmError("429 RESOURCE_EXHAUSTED", "api");
      },
    });
    const c = ctx(broken);
    expect(await webSearch.run({ query: "food in asheville", purpose: "food" }, c)).toEqual({ ok: false, error: BUSY });
    expect(BUSY).toContain("try me again in a minute");
    expect(c.out).toHaveLength(0);

    const slow = new FakeLlm({ search: () => new Promise<never>(() => {}) });
    await expect(lookup(slow, cfg, { query: "slow", purpose: "facts", context: [], today: "2026-10-10" }, 50)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("tries grounding first; a quota error falls back to gemini's knowledge and rests grounding", async () => {
    delete process.env.GEMINI_SEARCH_GROUNDING;
    const llm = new FakeLlm({
      search: (req) => {
        if (req.builtinTools?.includes("googleSearch")) throw new LlmError("429 RESOURCE_EXHAUSTED quota", "api");
        return jsonResult({ answer: "tickets are sold on universal's own site", source: 0 });
      },
    });
    const r = await webSearch.run({ query: "universal orlando tickets", purpose: "facts" }, ctx(llm));
    expect(r).toMatchObject({ ok: true, data: { answer: "tickets are sold on universal's own site" } });
    expect(llm.calls.map((c) => c.builtinTools?.[0] ?? "none")).toEqual(["googleSearch", "none"]);
    clearSearchCache();
    await webSearch.run({ query: "universal orlando hours", purpose: "facts" }, ctx(llm));
    expect(llm.calls.map((c) => c.builtinTools?.[0] ?? "none")).toEqual(["googleSearch", "none", "none"]); // resting
  });

  it("grounding check: names must appear (near-verbatim) in the text", () => {
    const corpus = norm("Crockett's Breakfast Camp serves big breakfasts. Ole Smoky Moonshine distillery tours. A deli nearby has vegan options.");
    expect(appearsIn("crocketts breakfast camp", corpus)).toBe(true);
    expect(appearsIn("The Crockett's Breakfast Camp", corpus)).toBe(true);
    expect(appearsIn("ole smoky vegan deli", corpus)).toBe(false);
    expect(appearsIn("ole smoky", corpus)).toBe(true);
    const g = groundItems([{ name: "ole smoky" }, { name: "crockett's breakfast camp" }, { name: "nope cafe" }], [{ url: "a", text: "Ole Smoky. Crockett's Breakfast Camp" }, { url: "b", text: "Ole Smoky" }]);
    expect(g.kept.map((k) => k.name)).toEqual(["ole smoky", "crockett's breakfast camp"]);
    expect(g.bestUrl).toBe("a");
    expect(pageText("<p>a &amp; b</p><script>x</script><li>c</li>")).toBe("a & b\nc");
    expect(excerpt(`${"intro text. ".repeat(400)}\neat: wild plum tea room`, ["wild", "plum"], 200)).toContain("wild plum tea room");
  });

  it("with grounding on, never posts a raw redirect url", async () => {
    delete process.env.GEMINI_SEARCH_GROUNDING;
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/xyz";
    const seen: GenerateRequest[] = [];
    const llm = new FakeLlm({
      search: (req) => {
        seen.push(req);
        return { ...jsonResult(LIST), sources: [{ uri: redirect, title: "visitmysmokies.com" }] };
      },
    });
    const c = ctx(llm);
    await webSearch.run({ query: "winter things to do gatlinburg", purpose: "things_to_do" }, c);
    expect(seen[0]!.builtinTools).toEqual(["googleSearch"]);
    expect(c.out[1]).toEqual({ type: "link", url: "https://www.visitmysmokies.com/winter" });
    expect(JSON.stringify(c.out)).not.toContain("vertexaisearch");

    // Unresolvable redirect: the list still goes out, without a link.
    clearSearchCache();
    setSearchFetch((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    const d = ctx(llm);
    await webSearch.run({ query: "winter things to do gatlinburg", purpose: "things_to_do" }, d);
    expect(d.out.map((a) => a.type)).toEqual(["say"]);
  });
});
