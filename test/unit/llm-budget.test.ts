import { describe, expect, it } from "vitest";
import { bucketKey, GeminiLlm, LlmError, splitKeys, type GenerateRequest } from "../../src/agent/llm.ts";

const quota429 = (delay = "20s") => new Error(`{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"${delay}"}]}}`);

/** A GeminiLlm whose network call is scripted per model (and per key, numbered from 0). */
function scripted(fallbacks: string[], answer: (model: string, n: number, req: { config: { tools?: unknown[] } }, key: number) => unknown, keys: string[] = ["test-key"]) {
  const llm = new GeminiLlm(keys, "gemini-embedding-2", fallbacks);
  const calls: string[] = [];
  const clients = (llm as unknown as { clients: { models: { generateContent: (a: { model: string; config: { tools?: unknown[] } }) => Promise<unknown> } }[] }).clients;
  clients.forEach((client, key) => {
    client.models.generateContent = async (a) => {
      calls.push(keys.length > 1 ? `${a.model}@${key}` : a.model);
      const out = answer(a.model, calls.length, a, key);
      if (out instanceof Error) throw out;
      return out;
    };
  });
  return { llm, calls };
}

const ok = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const req = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({ role: "search", model: "a", system: "s", contents: [{ role: "user", parts: [{ text: "q" }] }], timeoutMs: 5_000, ...extra });

describe("quota buckets", () => {
  it("urlContext shares the model's quota; google search grounding has its own", () => {
    expect(bucketKey("m", ["urlContext"])).toBe("m");
    expect(bucketKey("m")).toBe("m");
    expect(bucketKey("m", ["googleSearch"])).toBe("m+googleSearch");
  });

  it("a 429 on a urlContext read benches the model for plain calls too, and fails over", async () => {
    const { llm, calls } = scripted(["b"], (model) => (model === "a" ? quota429() : ok("fine")));
    expect((await llm.generate(req({ builtinTools: ["urlContext"] }))).model).toBe("b");
    expect((await llm.generate(req())).model).toBe("b");
    expect(calls).toEqual(["a", "b", "b"]);
  });
});

describe("budgeted calls", () => {
  it("fails fast when every model is benched longer than the budget", async () => {
    const { llm, calls } = scripted(["b"], () => quota429("40s"));
    await expect(llm.generate(req())).rejects.toBeInstanceOf(LlmError);
    expect(calls).toEqual(["a", "b"]);
    const t0 = Date.now();
    await expect(llm.generate(req({ budgetMs: 5_000 }))).rejects.toThrow(/all models busy/);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(calls).toHaveLength(2); // no more 429s burned
  });

  it("caps each attempt by what's left of the budget and benches a model that ran out of time", async () => {
    // The stub ignores the abort signal, so model "a" answers just after its 1s attempt timeout.
    const hanging = scripted(["b"], (model) => {
      if (model === "a") return new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 1_100));
      return ok("from b");
    });
    const r = await hanging.llm.generate(req({ timeoutMs: 1_000, budgetMs: 6_000 }));
    expect(r.model).toBe("b");
    // The next call skips the slow model.
    await hanging.llm.generate(req({ timeoutMs: 1_000, budgetMs: 6_000 }));
    expect(hanging.calls).toEqual(["a", "b", "b"]);
  });
});

describe("several API keys", () => {
  const dailyQuota = () => new Error(`{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel","status":"RESOURCE_EXHAUSTED"}}`);
  const overloaded = () => new Error(`{"error":{"code":503,"message":"The model is overloaded","status":"UNAVAILABLE"}}`);

  it("splits a comma-separated key list and drops blanks and repeats", () => {
    expect(splitKeys(" k1, k2 ,,k1 ")).toEqual(["k1", "k2"]);
    expect(splitKeys(undefined)).toEqual([]);
  });

  it("rotates calls across keys", async () => {
    const { llm, calls } = scripted([], () => ok("hi"), ["k1", "k2", "k3"]);
    for (let i = 0; i < 4; i++) await llm.generate(req());
    expect(calls).toEqual(["a@0", "a@1", "a@2", "a@0"]);
  });

  it("a spent key keeps the same model on another key, and stays skipped", async () => {
    const { llm, calls } = scripted(["b"], (_m, _n, _r, key) => (key === 0 ? dailyQuota() : ok("fine")), ["k1", "k2"]);
    const r = await llm.generate(req());
    expect(r.model).toBe("a");
    for (let i = 0; i < 3; i++) await llm.generate(req());
    expect(calls).toEqual(["a@0", "a@1", "a@1", "a@1", "a@1"]);
  });

  it("falls back to the next model only once every key is spent on this one", async () => {
    const { llm, calls } = scripted(["b"], (model) => (model === "a" ? quota429() : ok("fine")), ["k1", "k2"]);
    expect((await llm.generate(req())).model).toBe("b");
    expect(calls).toEqual(["a@0", "a@1", "b@0"]);
  });

  it("an overloaded model is benched on every key, not retried per key", async () => {
    const { llm, calls } = scripted(["b"], (model) => (model === "a" ? overloaded() : ok("fine")), ["k1", "k2"]);
    expect((await llm.generate(req())).model).toBe("b");
    expect(calls).toEqual(["a@0", "b@0"]);
  });

  it("a rejected key is skipped for every model", async () => {
    const badKey = new Error(`{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}`);
    const { llm, calls } = scripted(["b"], (_m, _n, _r, key) => (key === 0 ? badKey : ok("fine")), ["bad", "good"]);
    await llm.generate(req());
    await llm.generate(req({ model: "b" }));
    expect(calls).toEqual(["a@0", "a@1", "b@1"]);
  });
});
