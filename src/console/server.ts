// The judge console: a localhost-only page that shows, live, the evidence behind what Atlas
// says in the chat — speak-gate decisions and reasons, extracted facts with the words they came
// from, budgets with their formula and Nessie ids, every Nessie call, memory recalls, the
// forecast timeline, the money ledger and job failures. Private budgets are masked here too.
import { createServer, type Server } from "node:http";
import { childLog, redactUrl } from "../log.ts";
import { q } from "../db/pool.ts";
import { sharedNessie } from "../nessie/seed.ts";

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
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{text-align:left;padding:4px 6px;border-top:1px solid var(--line);vertical-align:top;word-break:break-word}th{color:var(--mute);font-weight:500;border-top:0;white-space:nowrap}
.msg{padding:3px 0}.atlas{color:var(--accent)}.mute{color:var(--mute)}.good{color:var(--good)}.bad{color:var(--bad)}code{font-size:11.5px}
.pill{display:inline-block;padding:0 6px;border-radius:999px;border:1px solid var(--line);font-size:11px}
.tabs{display:flex;gap:2px;border:1px solid var(--line);border-radius:9px;padding:2px;background:var(--card)}
.tabs button{font:inherit;border:0;background:none;color:var(--mute);padding:3px 10px;border-radius:7px;cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--bg);color:var(--ink);font-weight:600}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.filters input,.filters select{font:inherit;font-size:12.5px;padding:3px 7px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
section.wide{grid-column:1/-1;max-height:none}.num{text-align:right;font-variant-numeric:tabular-nums}
.linkbtn{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--accent);border-radius:7px;padding:1px 8px;cursor:pointer;float:right}
</style></head><body>
<header><h1>atlas console</h1><div class="tabs"><button id="tab-chat" aria-pressed="true">chat</button><button id="tab-nessie" aria-pressed="false">nessie</button></div><select id="chat"></select><span class="mute" id="status">localhost only · refreshes every 2s</span></header>
<main id="main"></main>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money=c=>c==null?"":"$"+(c/100).toLocaleString("en-US",{minimumFractionDigits:c%100?2:0,maximumFractionDigits:2});
const t=d=>d?new Date(d).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}):"";
function table(rows,cols){if(!rows.length)return '<div class="mute">nothing yet</div>';return '<table><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</table>'}
let view=location.hash==='#nessie'?'nessie':'chat';
function setView(v){view=v;location.hash=v==='nessie'?'nessie':'';document.getElementById('tab-chat').setAttribute('aria-pressed',v==='chat');document.getElementById('tab-nessie').setAttribute('aria-pressed',v==='nessie');document.getElementById('chat').style.display=v==='chat'?'':'none';document.getElementById('main').innerHTML='';balances=null;load().catch(()=>{});if(v==='nessie')loadBalances()}
document.getElementById('tab-chat').onclick=()=>setView('chat');document.getElementById('tab-nessie').onclick=()=>setView('nessie');
const filt={method:'',status:'',path:'',person:''};let balances=null,balLoading=false;
async function loadBalances(){if(balLoading)return;balLoading=true;try{balances=await (await fetch('/api/nessie/balances')).json()}catch{balances={mode:'error',accounts:{}}}balLoading=false;load().catch(()=>{})}
function bal(id){if(!id)return'';const b=balances&&balances.accounts[id];const code='<code>'+esc(id)+'</code>';if(!balances)return code+'<br><span class="mute">loading…</span>';if(!b)return code;
 const v=b.balance==null?'<span class="mute">'+esc(b.note||'no balance')+'</span>':'<b>'+money(Math.round(b.balance*100))+'</b>';
 return code+'<br>'+v+(b.source==='cache'?' <span class="pill">cached '+esc(t(b.fetchedAt))+'</span>':b.source==='live'?' <span class="pill good">live</span>':'')}
function keep(){const a=document.activeElement;return a&&a.dataset&&a.dataset.f?{f:a.dataset.f,pos:a.selectionStart}:null}
function restore(k){if(!k)return;const el=document.querySelector('[data-f="'+k.f+'"]');if(el){el.focus();if(k.pos!=null&&el.setSelectionRange)el.setSelectionRange(k.pos,k.pos)}}
async function loadNessie(){
  const qs=new URLSearchParams(Object.entries(filt).filter(([,v])=>v));const d=await (await fetch('/api/nessie?'+qs)).json();
  const k=keep();const opt=(f,vals)=>'<select data-f="'+f+'">'+vals.map(([v,l])=>'<option value="'+v+'"'+(filt[f]===v?' selected':'')+'>'+l+'</option>').join('')+'</select>';
  const banner=balances?(balances.mode==='live'?'':'<div class="mute" style="margin:0 0 6px">'+(balances.mode==='offline'?'offline: no NESSIE_API_KEY set, showing last cached balances where we have them':'nessie unreachable: showing last cached balances')+'</div>'):'';
  document.getElementById('main').innerHTML=[
   ['wide','customers &amp; accounts <button class="linkbtn" id="refresh-bal">refresh balances</button>',banner+table(d.links,[['person',r=>'<b>'+esc(r.who)+'</b>'+(r.connection?'<br><span class="pill">'+esc(r.connection)+'</span>':'')],['persona',r=>esc(r.persona)],['customer',r=>'<code>'+esc(r.customer_id)+'</code>'],['checking',r=>bal(r.checking_id)],['savings',r=>bal(r.savings_id)],['credit',r=>bal(r.credit_id)],['seed',r=>'<span class="'+(r.seed_status==='ready'?'good':r.seed_status==='failed'?'bad':'mute')+'">'+esc(r.seed_status)+'</span>'+(r.seeded_at?'<br><span class="mute">'+esc(t(r.seeded_at))+'</span>':'')+(r.seed_error?'<br><span class="bad">'+esc(r.seed_error)+'</span>':'')]])],
   ['wide','trip fund accounts',d.funds.length?d.funds.map(f=>'<div class="mute" style="margin:6px 0 2px"><code>'+esc(f.table)+'</code></div>'+table(f.rows,f.columns.map(c=>[esc(c),r=>/account_id$/.test(c)&&r[c]?bal(r[c]):/_cents$/.test(c)&&r[c]!=null?money(Number(r[c])):esc(typeof r[c]==='object'&&r[c]!==null?JSON.stringify(r[c]):r[c])]))).join(''):'<div class="mute">no trip fund table yet (added with the trip fund migration)</div>'],
   ['wide','nessie calls',
    '<div class="filters">'+opt('method',[['','all methods'],['GET','GET'],['POST','POST'],['DELETE','DELETE']])+opt('status',[['','any status'],['ok','ok'],['error','errors'],['cache','served from cache']])+opt('person',[['','anyone']].concat(d.people.map(p=>[String(p.id),esc(p.who)])))+'<input data-f="path" placeholder="path contains…" value="'+esc(filt.path)+'"></div>'+
    '<div class="mute small" style="margin:0 0 6px">'+d.stats.total+' calls · '+d.stats.errors+' errors · '+d.stats.cached+' from cache · median '+(d.stats.p50??'–')+' ms</div>'+
    table(d.calls,[['time',r=>esc(new Date(r.created_at).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"}))],['method',r=>'<b>'+esc(r.method)+'</b>'],['endpoint',r=>'<code>'+esc(r.path)+'</code>'],['status',r=>r.from_cache?'<span class="pill">cache</span>':r.ok?'<span class="good">'+r.status+'</span>':'<span class="bad">'+esc(r.status??'network')+'</span>'],['ms',r=>'<span class="num">'+esc(r.latency_ms??'')+'</span>'],['who',r=>esc(r.who)],['object / error',r=>r.error?'<span class="bad">'+esc(r.error)+'</span>':'<code>'+esc(r.object_id)+'</code>']])],
  ].map(([c,h,b])=>'<section class="'+c+'"><h2>'+h+'</h2>'+b+'</section>').join('');
  document.getElementById('refresh-bal').onclick=()=>{balances=null;loadBalances()};
  document.querySelectorAll('[data-f]').forEach(el=>{el[el.tagName==='INPUT'?'oninput':'onchange']=()=>{filt[el.dataset.f]=el.value;loadNessie().catch(()=>{})}});
  restore(k);
}
async function load(){
  if(view==='nessie')return loadNessie();
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
setView(view);setInterval(()=>{const a=document.activeElement;if(view==='nessie'&&a&&a.tagName==='SELECT')return;load().catch(()=>{})},2000);setInterval(()=>{if(view==='nessie')loadBalances()},30000);
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
      if (url.pathname === "/api/nessie") return json(res, await nessieData(callFilter(url.searchParams)));
      if (url.pathname === "/api/nessie/balances") return json(res, await nessieBalances());
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
       WHERE f.person_id IN (SELECT person_id FROM chat_members WHERE chat_id = $1) AND f.visibility = 'public' ORDER BY f.id DESC LIMIT 40`, [chatId]),
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

// ---- Nessie view (operator-only, so it may say Nessie) ----

export interface NessieCallRow {
  id: number;
  method: string;
  path: string;
  status: number | null;
  ok: boolean;
  from_cache: boolean;
  object_id: string | null;
  error: string | null;
  latency_ms: number | null;
  created_at: Date;
  who: string;
}

export interface CallFilter {
  method?: string;
  status?: "ok" | "error" | "cache";
  path?: string;
  personId?: number;
  limit?: number;
}

export function callFilter(params: URLSearchParams): CallFilter {
  const method = params.get("method")?.toUpperCase();
  const status = params.get("status");
  const person = Number(params.get("person"));
  return {
    method: method && ["GET", "POST", "PUT", "DELETE"].includes(method) ? method : undefined,
    status: status === "ok" || status === "error" || status === "cache" ? status : undefined,
    path: params.get("path")?.trim().slice(0, 120) || undefined,
    personId: Number.isInteger(person) && person > 0 ? person : undefined,
  };
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

interface FundTable {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Trip fund tables (added by the trip fund migration). A missing table is simply skipped. */
async function fundTables(): Promise<FundTable[]> {
  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name LIKE '%fund%' ORDER BY table_name`,
  ).catch(() => []);
  const out: FundTable[] = [];
  for (const { table_name: table } of tables) {
    if (!SAFE_IDENT.test(table)) continue;
    try {
      const rows = await q<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1 DESC LIMIT 25`);
      const cols = await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      out.push({ table, columns: cols.map((c) => c.column_name), rows });
    } catch {
      // a table mid-migration or with an odd shape mustn't break the page
    }
  }
  return out;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function nessieData(filter: CallFilter = {}) {
  const who = `COALESCE(p.display_name, '…' || right(p.handle, 4))`;
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.method) where.push(`c.method = $${args.push(filter.method)}`);
  if (filter.status === "ok") where.push(`c.ok AND NOT c.from_cache`);
  if (filter.status === "error") where.push(`NOT c.ok`);
  if (filter.status === "cache") where.push(`c.from_cache`);
  if (filter.path) where.push(`c.path ILIKE $${args.push(`%${likeEscape(filter.path)}%`)}`);
  if (filter.personId) where.push(`c.person_id = $${args.push(filter.personId)}`);
  const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const hasConnections = (await q<{ ok: boolean }>(`SELECT to_regclass('bank_connections') IS NOT NULL AS ok`))[0]?.ok ?? false;
  const connection = hasConnections ? `(SELECT b.status FROM bank_connections b WHERE b.person_id = l.person_id ORDER BY b.updated_at DESC LIMIT 1)` : `NULL::text`;
  const [links, calls, stats, people, funds] = await Promise.all([
    q<{ seed_progress: { error?: string } | null } & Record<string, unknown>>(
      `SELECT l.person_id, ${who} AS who, l.persona, l.customer_id, l.checking_id, l.savings_id, l.credit_id, l.seed_status, l.seed_progress, l.seeded_at, ${connection} AS connection
       FROM nessie_links l JOIN people p ON p.id = l.person_id ORDER BY l.created_at DESC`,
    ),
    q<NessieCallRow>(
      `SELECT c.id, c.method, c.path, c.status, c.ok, c.from_cache, c.object_id, c.error, c.latency_ms, c.created_at, CASE WHEN p.id IS NULL THEN '' ELSE ${who} END AS who
       FROM nessie_calls c LEFT JOIN people p ON p.id = c.person_id ${cond} ORDER BY c.id DESC LIMIT ${limit}`,
      args,
    ),
    q<{ total: number; errors: number; cached: number; p50: number | null }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE NOT c.ok))::int AS errors, (count(*) FILTER (WHERE c.from_cache))::int AS cached,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY c.latency_ms) FILTER (WHERE NOT c.from_cache AND c.latency_ms IS NOT NULL))::int AS p50
       FROM nessie_calls c ${cond}`,
      args,
    ),
    q<{ id: number; who: string }>(`SELECT DISTINCT p.id, ${who} AS who FROM nessie_calls c JOIN people p ON p.id = c.person_id ORDER BY 2`),
    fundTables(),
  ]);
  return {
    links: links.map(({ seed_progress, ...l }) => ({ ...l, seed_error: seed_progress?.error ?? null })),
    // Paths are redacted when audited; strip any query again so a key can never reach the page.
    calls: calls.map((c) => ({ ...c, path: redactUrl(c.path).split("?")[0] })),
    stats: stats[0] ?? { total: 0, errors: 0, cached: 0, p50: null },
    people,
    funds,
  };
}

export interface Balance {
  balance: number | null;
  source: "live" | "cache" | "none";
  fetchedAt: string | null;
  note?: string;
}

export interface Balances {
  mode: "live" | "offline" | "degraded";
  accounts: Record<string, Balance>;
}

let balanceCache: { at: number; value: Balances } | undefined;

/** Live balances for every linked and fund account; cached 20s so the page can't hammer Nessie. */
export async function nessieBalances(opts: { fresh?: boolean } = {}): Promise<Balances> {
  if (!opts.fresh && balanceCache && Date.now() - balanceCache.at < 20_000) return balanceCache.value;
  const ids = new Set<string>();
  for (const l of await q<{ checking_id: string | null; savings_id: string | null; credit_id: string | null }>(`SELECT checking_id, savings_id, credit_id FROM nessie_links`)) {
    for (const id of [l.checking_id, l.savings_id, l.credit_id]) if (id) ids.add(id);
  }
  for (const f of await fundTables()) {
    for (const row of f.rows) for (const [k, v] of Object.entries(row)) if (/account_id$/.test(k) && typeof v === "string" && v) ids.add(v);
  }
  const list = [...ids].slice(0, 60);
  const accounts: Record<string, Balance> = {};
  const client = sharedNessie();
  if (!client) {
    // No key: show the last balance Nessie gave us, if any.
    const cached = list.length
      ? await q<{ cache_key: string; body: { balance?: unknown }; fetched_at: Date }>(`SELECT cache_key, body, fetched_at FROM nessie_cache WHERE cache_key = ANY($1)`, [
          list.map((id) => `/accounts/${id}`),
        ])
      : [];
    const byKey = new Map(cached.map((c) => [c.cache_key, c]));
    for (const id of list) {
      const c = byKey.get(`/accounts/${id}`);
      accounts[id] =
        c && typeof c.body?.balance === "number"
          ? { balance: c.body.balance, source: "cache", fetchedAt: new Date(c.fetched_at).toISOString() }
          : { balance: null, source: "none", fetchedAt: null, note: "offline" };
    }
    balanceCache = { at: Date.now(), value: { mode: "offline", accounts } };
    return balanceCache.value;
  }
  let degraded = false;
  await Promise.all(
    list.map(async (id) => {
      try {
        const r = await client.account(id);
        if (r.fromCache) degraded = true;
        const balance = typeof r.value?.balance === "number" ? r.value.balance : null;
        accounts[id] = { balance, source: r.fromCache ? "cache" : "live", fetchedAt: new Date(r.fetchedAt).toISOString() };
      } catch (err) {
        degraded = true;
        accounts[id] = { balance: null, source: "none", fetchedAt: null, note: (err as Error).message.slice(0, 80) };
      }
    }),
  );
  balanceCache = { at: Date.now(), value: { mode: degraded ? "degraded" : "live", accounts } };
  return balanceCache.value;
}

function send(res: import("node:http").ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
}

function json(res: import("node:http").ServerResponse, body: unknown): void {
  send(res, 200, JSON.stringify(body), "application/json");
}
