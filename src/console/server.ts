// The judge console: a localhost-only page that shows, live, the evidence behind what Atlas
// says in the chat — speak-gate decisions and reasons, extracted facts with the words they came
// from, budgets with their formula and Nessie ids, every Nessie call, memory recalls, the
// forecast timeline, the money ledger and job failures. Private budgets are masked here too.
import { createServer, type Server } from "node:http";
import { childLog } from "../log.ts";
import { q } from "../db/pool.ts";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas console</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--mute:#6e6e73;--line:#e5e5e7;--accent:#0a7cff;--good:#1a7f37;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1c1c1e;--ink:#f2f2f7;--mute:#98989f;--line:#2c2c2e;--accent:#4aa3ff;--good:#3fb950;--bad:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:12px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
h1{font-size:16px;margin:0}select{font:inherit;padding:4px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px;padding:16px 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-width:0;max-height:440px;overflow:auto}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{text-align:left;padding:4px 6px;border-top:1px solid var(--line);vertical-align:top;word-break:break-word}th{color:var(--mute);font-weight:500;border-top:0}
.msg{padding:3px 0}.atlas{color:var(--accent)}.mute{color:var(--mute)}.good{color:var(--good)}.bad{color:var(--bad)}code{font-size:11.5px}
.pill{display:inline-block;padding:0 6px;border-radius:999px;border:1px solid var(--line);font-size:11px}
</style></head><body>
<header><h1>atlas console</h1><select id="chat"></select><span class="mute" id="status">localhost only · refreshes every 2s</span></header>
<main id="main"></main>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money=c=>c==null?"":"$"+(c/100).toLocaleString("en-US",{minimumFractionDigits:c%100?2:0,maximumFractionDigits:2});
const t=d=>d?new Date(d).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}):"";
function table(rows,cols){if(!rows.length)return '<div class="mute">nothing yet</div>';return '<table><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</table>'}
async function load(){
  const chats=await (await fetch('/api/chats')).json();const sel=document.getElementById('chat');
  if(!sel.options.length||sel.options.length!==chats.length){const cur=sel.value;sel.innerHTML=chats.map(c=>'<option value="'+c.id+'">'+esc(c.label)+'</option>').join('');if(cur)sel.value=cur}
  if(!sel.value)return;const d=await (await fetch('/api/chat/'+sel.value)).json();
  document.getElementById('main').innerHTML=[
   ['chat',d.messages.map(m=>'<div class="msg '+(m.direction==='outbound'?'atlas':'')+'"><span class="mute">'+t(m.sent_at)+'</span> <b>'+esc(m.who)+'</b> '+esc(m.text)+'</div>').join('')],
   ['speak gate &amp; routing',table(d.turns,[['time',r=>t(r.started_at)],['route',r=>esc(r.route)],['addressed',r=>r.addressed?'yes':''],['gate',r=>r.gate_decision?'<span class="pill">'+esc(r.gate_decision)+'</span> '+esc(r.gate_reason):''],['ms',r=>r.latency_ms??'']])],
   ['extracted facts (gemini → deterministic resolution)',table(d.facts,[['who',r=>esc(r.who)],['fact',r=>esc(r.key)+' <code>'+esc(JSON.stringify(r.value))+'</code> '+(r.polarity==='negative'?'<span class="bad">veto/no</span>':'')],['said',r=>'"'+esc(r.quote)+'"'],['conf',r=>r.confidence.toFixed(2)],['',r=>r.superseded?'<span class="mute">superseded</span>':'<span class="good">current</span>']])],
   ['budgets (nessie demo profiles)',table(d.budgets,[['who',r=>esc(r.who)],['budget',r=>r.visibility==='private'?'<span class="pill">private</span>':money(r.effective)],['how',r=>r.visibility==='private'?'':esc((r.explanation||[]).join(' · '))],['source',r=>esc(r.source)+(r.customer?'<br><code>'+esc(r.customer)+'</code>':'')]])],
   ['nessie calls',table(d.nessie,[['time',r=>t(r.created_at)],['call',r=>esc(r.method)+' <code>'+esc(r.path)+'</code>'],['',r=>r.from_cache?'<span class="pill">cache</span>':r.ok?'<span class="good">'+r.status+'</span>':'<span class="bad">'+esc(r.status??'')+' '+esc(r.error)+'</span>'],['object',r=>'<code>'+esc(r.object_id)+'</code>']])],
   ['trip money',table(d.expenses,[['#',r=>r.n],['what',r=>esc(r.description)],['amount',r=>money(r.amount_cents)],['payer',r=>esc(r.payer)],['status',r=>esc(r.status)],['nessie',r=>'<code>'+esc(r.nessie_purchase_id)+'</code>']])+table(d.settlements,[['transfer',r=>esc(r.from)+' → '+esc(r.to)],['amount',r=>money(r.amount_cents)],['status',r=>esc(r.status)],['nessie',r=>'<code>'+esc(r.nessie_transfer_id)+' '+esc(r.nessie_deposit_id)+'</code>']])+(d.spent?'<div class="mute">spent so far (trip_spend_daily continuous aggregate): '+money(d.spent)+'</div>':'')],
   ['semantic memory (pgvector + diskann)',table(d.memory,[['time',r=>t(r.created_at)],['hits',r=>esc(r.decision)],['top matches',r=>esc(r.reason)]])],
   ['forecast watch',table(d.weather,[['day',r=>esc(r.day)],['latest',r=>esc(r.category)+' '+esc(r.precip_probability??'')+'% '+esc(r.temp_max_f??'')+'°'],['fetches',r=>r.fetches],['precip range',r=>esc(r.precip_min)+'–'+esc(r.precip_max)+'%']])],
   ['job failures',table(d.failures,[['time',r=>t(r.created_at)],['queue',r=>esc(r.queue)],['error',r=>'<span class="bad">'+esc(r.error)+'</span>']])],
  ].map(([h,b])=>'<section><h2>'+h+'</h2>'+b+'</section>').join('');
}
load();setInterval(()=>load().catch(()=>{}),2000);
</script></body></html>`;

export function startConsole(port: number): Promise<Server> {
  const log = childLog({ component: "console" });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
      if (url.pathname === "/api/chats") {
        const rows = await q<{ id: number; platform: string; provider_chat_id: string; n: number }>(
          `SELECT c.id, c.platform, c.provider_chat_id, (SELECT count(*)::int FROM chat_members m WHERE m.chat_id = c.id AND m.active) AS n FROM chats c ORDER BY c.id DESC`,
        );
        return json(res, rows.map((r) => ({ id: r.id, label: `${r.platform} · ${r.provider_chat_id.slice(-10)} · ${r.n} people` })));
      }
      const m = /^\/api\/chat\/(\d+)$/.exec(url.pathname);
      if (m) return json(res, await chatData(Number(m[1])));
      send(res, 404, "not found", "text/plain");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "console request failed");
      send(res, 500, "error", "text/plain");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function chatData(chatId: number) {
  const who = `COALESCE(p.display_name, '…' || right(p.handle, 4))`;
  const [messages, turns, facts, budgets, nessie, expenses, settlements, memory, weather, failures, spent] = await Promise.all([
    q(`SELECT m.direction, m.text, m.sent_at, CASE WHEN m.direction = 'outbound' THEN 'atlas' ELSE ${who} END AS who FROM messages m LEFT JOIN people p ON p.id = m.person_id WHERE m.chat_id = $1 ORDER BY m.sent_at DESC, m.id DESC LIMIT 60`, [chatId]),
    q(`SELECT started_at, route, addressed, gate_decision, gate_reason, latency_ms FROM turns WHERE chat_id = $1 ORDER BY id DESC LIMIT 25`, [chatId]),
    q(`SELECT ${who} AS who, f.key, f.value, f.polarity, f.confidence, f.quote, f.superseded_by IS NOT NULL AS superseded FROM facts f JOIN people p ON p.id = f.person_id
       WHERE f.chat_id = $1 AND f.visibility = 'public' ORDER BY f.id DESC LIMIT 40`, [chatId]),
    q<{ who: string; visibility: string; effective: number | null; explanation: string[] | null; source: string | null; customer: string | null }>(
      `SELECT ${who} AS who, b.visibility, COALESCE(b.adjusted_cents, b.suggested_cents) AS effective, b.inputs->'result'->'explanation' AS explanation, b.inputs->>'source' AS source, b.inputs->>'customerId' AS customer
       FROM budgets b JOIN trips t ON t.id = b.trip_id JOIN people p ON p.id = b.person_id WHERE t.chat_id = $1`,
      [chatId],
    ),
    q(`SELECT method, path, status, ok, from_cache, object_id, error, created_at FROM nessie_calls ORDER BY id DESC LIMIT 30`),
    q(`SELECT row_number() OVER (ORDER BY e.id) AS n, e.description, e.amount_cents, ${who} AS payer, e.status, e.nessie_purchase_id FROM expenses e JOIN trips t ON t.id = e.trip_id JOIN people p ON p.id = e.payer_id WHERE t.chat_id = $1 ORDER BY e.id`, [chatId]),
    q(`SELECT COALESCE(a.display_name, a.handle) AS "from", COALESCE(b.display_name, b.handle) AS "to", s.amount_cents, s.status, s.nessie_transfer_id, s.nessie_deposit_id FROM settlements s JOIN trips t ON t.id = s.trip_id JOIN people a ON a.id = s.from_id JOIN people b ON b.id = s.to_id WHERE t.chat_id = $1 AND s.status <> 'cancelled' ORDER BY s.id`, [chatId]),
    q(`SELECT created_at, decision, reason FROM llm_traces WHERE chat_id = $1 AND role = 'memory' ORDER BY id DESC LIMIT 10`, [chatId]),
    q(`SELECT d.day::text AS day, d.fetches, d.precip_min, d.precip_max, s.category, s.precip_probability, s.temp_max_f FROM (
         SELECT trip_id, day, sum(fetches)::int AS fetches, min(precip_min) AS precip_min, max(precip_max) AS precip_max FROM forecast_drift_daily GROUP BY trip_id, day) d
       JOIN trips t ON t.id = d.trip_id
       LEFT JOIN LATERAL (SELECT category, precip_probability, temp_max_f FROM weather_snapshots w WHERE w.trip_id = d.trip_id AND w.day = d.day ORDER BY fetched_at DESC LIMIT 1) s ON true
       WHERE t.chat_id = $1 ORDER BY d.day`, [chatId]),
    q(`SELECT created_at, queue, error FROM job_failures WHERE chat_id = $1 OR chat_id IS NULL ORDER BY id DESC LIMIT 15`, [chatId]),
    q<{ spent: number }>(`SELECT sum(spent_cents)::bigint AS spent FROM trip_spend_daily d JOIN trips t ON t.id = d.trip_id WHERE t.chat_id = $1`, [chatId]),
  ]);
  return {
    messages: messages.reverse(),
    turns,
    facts,
    budgets: budgets.map((b) => (b.visibility === "private" ? { who: b.who, visibility: "private" } : b)),
    nessie,
    expenses,
    settlements,
    memory,
    weather,
    failures,
    spent: spent[0]?.spent ? Number(spent[0].spent) : null,
  };
}

function send(res: import("node:http").ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
}

function json(res: import("node:http").ServerResponse, body: unknown): void {
  send(res, 200, JSON.stringify(body), "application/json");
}
