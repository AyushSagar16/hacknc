// An in-memory Nessie that behaves like the live sandbox as observed in 2026: create responses
// wrapped in {code, message, objectCreated}, 36-char ids, balances that never move, transfers
// that reject medium/payee_id, deposit/purchase amounts that drop cents, empty transfer lists as 404.
import { randomUUID } from "node:crypto";

type Obj = Record<string, unknown> & { _id: string };

export interface FakeNessieOptions {
  transferPayee?: boolean;
  dropCents?: boolean;
}

export function fakeNessie(opts: FakeNessieOptions = {}) {
  const state = {
    customers: new Map<string, Obj>(),
    accounts: new Map<string, Obj>(),
    merchants: new Map<string, Obj>(),
    objects: new Map<string, Obj & { kind: string; account: string }>(),
    calls: [] as { method: string; path: string }[],
    down: false,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const created = (obj: Obj) => json(201, { code: 201, message: "Created", objectCreated: obj });

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (state.down) throw new TypeError("fetch failed (fake nessie is down)");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.searchParams.get("key")) return json(502, { message: "Internal server error" });
    const method = init?.method ?? "GET";
    const path = url.pathname;
    state.calls.push({ method, path });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;

    if (method === "POST" && path === "/customers") {
      const c = { _id: randomUUID(), ...body };
      state.customers.set(c._id, c);
      return created(c);
    }
    if (method === "POST" && (m = /^\/customers\/([^/]+)\/accounts$/.exec(path))) {
      if (!state.customers.has(m[1]!)) return json(404, { message: "customer not found" });
      if (!["Checking", "Savings", "Credit Card"].includes(String(body.type))) return json(400, { message: "invalid account type" });
      const a = { _id: randomUUID(), customer_id: m[1], account_number: "1234567812345678", ...body };
      state.accounts.set(a._id, a);
      return created(a);
    }
    if (method === "POST" && path === "/merchants") {
      const mer = { _id: randomUUID(), ...body };
      state.merchants.set(mer._id, mer);
      return created(mer);
    }
    if (method === "POST" && (m = /^\/accounts\/([^/]+)\/(deposits|withdrawals|purchases|bills|transfers)$/.exec(path))) {
      const [, account, kind] = m as unknown as [string, string, string];
      if (!state.accounts.has(account)) return json(404, { message: "account not found" });
      if (kind === "transfers" && !opts.transferPayee && ("payee_id" in body || "medium" in body)) return json(400, { message: "extra fields not permitted: medium, payee_id" });
      if (kind === "purchases" && !state.merchants.has(String(body.merchant_id))) return json(400, { message: "merchant_id is invalid" });
      const amount = typeof body.amount === "number" && opts.dropCents !== false && kind !== "bills" ? Math.trunc(body.amount) : body.amount;
      const o = { _id: randomUUID(), kind, account, ...body, ...(amount !== undefined ? { amount } : {}), ...(kind === "transfers" ? { payer_id: account } : {}) };
      state.objects.set(o._id, o);
      return created(o);
    }
    if (method === "GET" && (m = /^\/accounts\/([^/]+)$/.exec(path))) {
      const a = state.accounts.get(m[1]!);
      return a ? json(200, a) : json(404, { message: "not found" });
    }
    if (method === "GET" && (m = /^\/accounts\/([^/]+)\/(deposits|withdrawals|purchases|bills|transfers)$/.exec(path))) {
      const list = [...state.objects.values()].filter((o) => o.account === m![1] && o.kind === m![2]).map(({ kind: _k, account: _a, ...rest }) => rest);
      if (m[2] === "transfers" && list.length === 0) return json(404, { message: "no transfers" });
      return json(200, list);
    }
    if (method === "DELETE" && /^\/purchases\//.test(path)) return json(403, { message: "Missing Authentication Token" });
    return json(403, { message: "Missing Authentication Token" });
  };
  return { fetch: handler as typeof fetch, state };
}
