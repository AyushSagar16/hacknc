import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { FakeLlm, jsonResult, LlmError, type GenerateRequest } from "../../src/agent/llm.ts";
import type { ToolCtx } from "../../src/agent/tools.ts";
import type { Action } from "../../src/transport/outbound.ts";
import { academicYear, cacheKey, clearSearchCache, lookup, parseLookup, searchQueryFor, setSearchFetch, webSearch } from "../../src/agent/features/search.ts";
import { clip, formatItem, formatList, MAX_ITEM_CHARS, stripArtifacts } from "../../src/search/format.ts";
import { linkable, parseDdgHtml, resolveRedirect, unwrapDdg } from "../../src/search/web.ts";

const cfg = { GEMINI_MODEL_AGENT: "gemini-test", AGENT_NAME: "atlas" } as unknown as Config;

const ddgResult = (url: string, title: string, snippet: string, ad = false) =>
  `<div class="result results_links results_links_deep web-result${ad ? " result--ad" : ""}"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${title}</a></h2><a class="result__snippet" href="x">${snippet}</a></div>`;

const DDG_PAGE = [
  ddgResult("https://ads.example.com/x", "Ad", "buy", true),
  ddgResult("https://www.gatlinburg.com/winter/", "Winter in <b>Gatlinburg</b>", "Winterfest lights &amp; more"),
  ddgResult("https://www.nps.gov/grsm/index.htm", "Great Smoky Mountains", "hiking"),
].join("\n");

function fakeFetch(html = DDG_PAGE, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("vertexaisearch")) return new Response(null, { status: 302, headers: { location: "https://www.visitmysmokies.com/winter" } });
    return new Response(html, { status: 200 });
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

  it("needs at least three items and drops duplicates", () => {
    expect(formatList("x", [{ name: "a" }, { name: "A" }, { name: "b" }])).toBeNull();
    expect(formatList("", [{ name: "a" }, { name: "b" }, { name: "c" }])).toBe("here's what i found:\n1. a\n2. b\n3. c");
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
  let fetchCalls: string[];
  beforeEach(() => {
    clearSearchCache();
    fetchCalls = [];
    setSearchFetch(fakeFetch(DDG_PAGE, fetchCalls));
  });
  afterEach(() => {
    setSearchFetch(undefined);
    delete process.env.GEMINI_SEARCH_GROUNDING;
  });

  it("posts a formatted list and one source link, personalized to the group", async () => {
    const llm = new FakeLlm({ search: () => ({ ...jsonResult(LIST), sources: [{ uri: "https://www.gatlinburg.com/winter/" }] }) });
    const c = ctx(llm);
    const r = await webSearch.run({ query: "things to do in gatlinburg in december", purpose: "things_to_do" }, c);
    expect(r.ok).toBe(true);
    expect(c.out).toHaveLength(2);
    expect(c.out[0]).toMatchObject({ type: "say", text: expect.stringMatching(/^top things to do in gatlinburg in december:\n1\. great smoky mountains — /) });
    expect(c.out[1]).toEqual({ type: "link", url: "https://www.gatlinburg.com/winter/" });
    const req = llm.calls[0]!;
    expect(req.builtinTools).toEqual(["urlContext"]);
    const prompt = JSON.stringify(req.contents);
    expect(prompt).toContain("sai wants mountains");
    expect(prompt).toContain("leo: vegetarian");
    expect(prompt).toContain("trip dates: 2026-12-14 to 2026-12-17 (december)");
    expect(prompt).toContain("https://www.gatlinburg.com/winter/");
    expect(webSearch.soloPost).toBe(true);
  });

  it("caches repeated questions (normalized) instead of calling again", async () => {
    const llm = new FakeLlm({ search: () => jsonResult(LIST) });
    await webSearch.run({ query: "Things to do in Gatlinburg in December?", purpose: "things_to_do" }, ctx(llm));
    const again = ctx(llm);
    await webSearch.run({ query: "things to do in gatlinburg in december", purpose: "things_to_do" }, again);
    expect(llm.calls).toHaveLength(1);
    expect(fetchCalls.filter((u) => u.includes("duckduckgo"))).toHaveLength(1);
    expect(again.out[0]).toMatchObject({ type: "say" });
    expect(cacheKey({ query: "A b?", purpose: "food", context: [] })).toBe(cacheKey({ query: "a  b", purpose: "food", context: [] }));
  });

  it("returns dates as data without posting", async () => {
    const llm = new FakeLlm({ search: () => jsonResult({ start: "2026-12-12", end: "2027-01-05", confidence: "high", note: "last fall exam dec 11, spring starts jan 6", source: 1 }) });
    const c = ctx(llm);
    const r = await webSearch.run({ query: "unc chapel hill winter break", purpose: "dates" }, c);
    expect(c.out).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, data: { start: "2026-12-12", end: "2027-01-05", confidence: "high", source: "https://www.gatlinburg.com/winter/" } });
    expect(llm.calls[0]!.system).toContain("2026-27 academic year");
    expect(fetchCalls[0]).toContain(encodeURIComponent("unc chapel hill winter break 2026-27 academic calendar"));
  });

  it("fails softly on model errors, empty search and timeouts", async () => {
    const broken = new FakeLlm({
      search: () => {
        throw new LlmError("429 RESOURCE_EXHAUSTED", "api");
      },
    });
    const c = ctx(broken);
    expect(await webSearch.run({ query: "food in asheville", purpose: "food" }, c)).toEqual({ ok: false, error: "couldn't look that up right now" });
    expect(c.out).toHaveLength(0);

    setSearchFetch(fakeFetch("<html>no results</html>"));
    const noPlace = ctx(new FakeLlm({ search: () => jsonResult(LIST) }), { trip: { id: 1, destination_name: null, start_date: null, end_date: null } as never });
    expect(await webSearch.run({ query: "best ramen", purpose: "food" }, noPlace)).toMatchObject({ ok: false });

    const slow = new FakeLlm({ search: () => new Promise<never>(() => {}) });
    setSearchFetch(fakeFetch());
    await expect(lookup(slow, cfg, { query: "slow", purpose: "facts", context: [], today: "2026-10-10" }, 50)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("falls back to the destination's wikivoyage page when web search is blocked", async () => {
    setSearchFetch(fakeFetch("<html>challenge</html>"));
    const llm = new FakeLlm({ search: () => jsonResult(LIST) });
    const c = ctx(llm);
    expect((await webSearch.run({ query: "things to do", purpose: "things_to_do" }, c)).ok).toBe(true);
    expect(JSON.stringify(llm.calls[0]!.contents)).toContain("https://en.wikivoyage.org/wiki/Gatlinburg");
  });

  it("with grounding on, never posts a raw redirect url", async () => {
    process.env.GEMINI_SEARCH_GROUNDING = "1";
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
