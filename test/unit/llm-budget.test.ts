import { describe, expect, it } from "vitest";
import { bucketKey, GeminiLlm, LlmError, type GenerateRequest } from "../../src/agent/llm.ts";

const quota429 = (delay = "20s") => new Error(`{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"${delay}"}]}}`);

/** A GeminiLlm whose network call is scripted per model. */
function scripted(fallbacks: string[], answer: (model: string, n: number, req: { config: { tools?: unknown[] } }) => unknown) {
  const llm = new GeminiLlm("test-key", "gemini-embedding-2", fallbacks);
  const calls: string[] = [];
  (llm as unknown as { ai: { models: { generateContent: (a: { model: string; config: { tools?: unknown[] } }) => Promise<unknown> } } }).ai.models.generateContent = async (a) => {
    calls.push(a.model);
    const out = answer(a.model, calls.length, a);
    if (out instanceof Error) throw out;
    return out;
  };
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
