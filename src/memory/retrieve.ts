// Long-term memory, read side. Hybrid search in one SQL statement: BM25 (pg_textsearch) and the
// diskann vector index each rank this chat's history and decisions, and reciprocal rank fusion
// merges them, so names, cities and dates match lexically even when embeddings are vague. Private
// chunks only surface in that person's own 1:1 chat. Facts aren't recalled: every member's resolved
// facts are already in the situation each turn, and old fact chunks go stale. Results are reranked
// in code with a gentle recency decay and a small boost for decisions.
import { one, q, tx } from "../db/pool.ts";
import type { Llm } from "../agent/llm.ts";
import type { ChunkKind, Visibility } from "./write.ts";
import { vectorLiteral } from "./write.ts";

/** Nearest neighbours fetched before reranking. */
export const CANDIDATES = 50;
export const DEFAULT_LIMIT = 8;
/** ANN search breadth and full-vector re-scoring depth for the recall query (pgvectorscale defaults: 100 / 50). */
export const SEARCH_LIST_SIZE = 200;
export const RESCORE = 400;
/** Below this cosine similarity a chunk is noise (rerank's floor for the test embedder). */
export const MIN_SIMILARITY = 0.15;
/** A vector-only hit (no BM25 match) needs this similarity with a real embedding model. */
export const MIN_VECTOR_ONLY = 0.7;
/** RRF constant (Cormack et al.; Tiger's hybrid-search tutorial uses 60). */
export const RRF_K = 60;
const IMPORTANCE: Record<string, number> = { decision: 1.2, message: 1 };
/** Recency multiplier: 1.0 for a fresh chunk, decaying (e-folding RECENCY_DAYS) to RECENCY_FLOOR. */
export const RECENCY_FLOOR = 0.85;
export const RECENCY_DAYS = 14;

export interface Candidate {
  id: number;
  kind: ChunkKind;
  content: string;
  createdAt: Date;
  /** 1 − cosine distance (0 when only BM25 found it). */
  similarity: number;
  visibility?: Visibility;
  /** Matched the query's words (BM25). */
  lexical?: boolean;
  /** Reciprocal-rank-fusion score across BM25 and vector ranks. */
  rrf?: number;
}

export interface MemoryHit extends Candidate {
  score: number;
}

export interface RecallInput {
  llm: Llm;
  chatId: number;
  /** People in this chat: their facts are recalled from any chat. */
  memberIds: number[];
  query: string;
  isGroup: boolean;
  /** In a 1:1 chat, the person reading: their own private chunks are allowed. */
  viewerId?: number;
  /** Chunks made only of these messages are skipped (the agent already sees them). */
  excludeMessageIds?: number[];
  now: Date;
  limit?: number;
  /** Vector-only hits below this are dropped (defaults to MIN_SIMILARITY; real embedders: MIN_VECTOR_ONLY). */
  minVectorSimilarity?: number;
}

const STOP = new Set("a an and are at be but by can do does for from get go got had has have hey hi how i i'm im in is it its just let lol me my no not of ok okay on or our so that the then there this to u up us was we what when where who why will with yes yeah you your".split(" "));
/** Words that carry meaning ("yes", "ok do it", "what happened" have none worth an embedding). */
export function contentTerms(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9$]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
}

export function recencyFactor(ageDays: number): number {
  const age = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-age / RECENCY_DAYS);
}

/**
 * score = similarity × (0.85 + 0.15·e^(−ageDays/14)); drop similarity < 0.15; best first.
 * Equal scores: newer first, then the later chunk (higher id).
 */
export function rerank(candidates: readonly Candidate[], now: Date, limit = Number.POSITIVE_INFINITY): MemoryHit[] {
  return candidates
    .filter((c) => Number.isFinite(c.similarity) && c.similarity >= MIN_SIMILARITY)
    .map((c) => ({ ...c, score: c.similarity * recencyFactor((now.getTime() - c.createdAt.getTime()) / 86_400_000) }))
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
    .slice(0, limit);
}

interface CandidateRow {
  id: number;
  kind: ChunkKind;
  content: string;
  created_at: Date;
  similarity: number;
  visibility: Visibility;
}

// Shared WHERE: $1 chat, $2 members, $3 is_group, $4 viewer.
// ($2 members is kept in the signature for callers; facts are no longer recalled.)
const SCOPE = `embedding IS NOT NULL
  AND kind IN ('message', 'decision') AND chat_id = $1 AND cardinality($2::bigint[]) >= 0
  AND (visibility = 'public' OR (NOT $3::boolean AND person_id = $4::bigint))`;

let bm25Checked: { db: string; ok: boolean } | undefined;
async function hasBm25(): Promise<boolean> {
  const db = (await one<{ d: string }>(`SELECT current_database() AS d`))?.d ?? "";
  if (bm25Checked?.db === db) return bm25Checked.ok;
  const ok = Boolean((await one<{ ok: boolean }>(`SELECT to_regclass('memory_chunks_bm25') IS NOT NULL AS ok`))?.ok);
  bm25Checked = { db, ok };
  return ok;
}

/** A recall started early (warmRecall) that the matching recall() call picks up instead of re-running. */
const WARM_TTL_MS = 15_000;
const warm = new Map<string, { at: number; llm: Llm; hits: Promise<MemoryHit[]> }>();

const warmKey = (input: RecallInput): string =>
  JSON.stringify([input.chatId, [...input.memberIds].sort((a, b) => a - b), input.query.trim().slice(0, 2_000), input.isGroup, input.viewerId ?? null, [...(input.excludeMessageIds ?? [])].sort((a, b) => a - b), input.limit ?? DEFAULT_LIMIT]);

/**
 * Start a recall now (e.g. while extraction runs on an addressed turn) so the embedding round trip
 * overlaps other work. The next recall() with the same input takes the result once; errors are
 * left for that call to see. Unused warm-ups expire after 15 s.
 */
export function warmRecall(input: RecallInput): void {
  const t = Date.now();
  for (const [k, w] of warm) if (t - w.at > WARM_TTL_MS) warm.delete(k);
  const key = warmKey(input);
  if (warm.has(key)) return;
  const hits = recallNow(input);
  hits.catch(() => {}); // observed by the recall() that consumes it
  warm.set(key, { at: t, llm: input.llm, hits });
}

export async function recall(input: RecallInput): Promise<MemoryHit[]> {
  const key = warmKey(input);
  const w = warm.get(key);
  if (w) {
    warm.delete(key);
    if (w.llm === input.llm && Date.now() - w.at <= WARM_TTL_MS) return w.hits;
  }
  return recallNow(input);
}

async function recallNow(input: RecallInput): Promise<MemoryHit[]> {
  const query = input.query.trim().slice(0, 2_000);
  if (!query) return [];
  const scope = [input.chatId, input.memberIds, input.isGroup, input.viewerId ?? null];
  const exclude = input.excludeMessageIds ?? [];
  // Nothing recallable (a brand-new chat, or every chunk is made of messages the agent already
  // sees): skip the work, including the embedding call.
  if (!(await one(`SELECT 1 FROM memory_chunks WHERE ${SCOPE} AND NOT (cardinality(source_ids) > 0 AND source_ids <@ $5::bigint[]) LIMIT 1`, [...scope, exclude]))) return [];
  const terms = contentTerms(query);
  if (terms.length === 0) return [];
  const lexical = await hasBm25();
  // One content word ("lisbon?") is a keyword search; save the embed request for real questions.
  const wantVector = terms.length >= 2 || !lexical;
  const vector = wantVector ? (await input.llm.embed([query], "query"))[0] : undefined;
  const vec = vector && vector.some((x) => x !== 0) ? vectorLiteral(vector) : null;
  if (!vec && !lexical) return [];
  const rows = await tx(async (client) => {
    // diskann walks a graph with 1-bit quantized distances and re-scores only the first N with the
    // full vectors; the chat filter is applied after, so widen both for this query only.
    await q(
      `SELECT set_config('diskann.query_search_list_size', $1, true), set_config('diskann.query_rescore', $2, true), set_config('hnsw.ef_search', $3, true)`,
      [String(SEARCH_LIST_SIZE), String(RESCORE), String(SEARCH_LIST_SIZE)],
      client,
    );
    const lexCte = lexical
      ? `lex AS (SELECT id, row_number() OVER (ORDER BY content <@> to_bm25query($8, 'memory_chunks_bm25')) AS r
           FROM memory_chunks WHERE id IN (SELECT id FROM scope) AND content <@> to_bm25query($8, 'memory_chunks_bm25') < 0
           ORDER BY content <@> to_bm25query($8, 'memory_chunks_bm25') LIMIT $7)`
      : `lex AS (SELECT NULL::bigint AS id, NULL::bigint AS r WHERE false)`;
    const vecCte = `vec AS (SELECT id, row_number() OVER (ORDER BY embedding <=> $6::vector) AS r, 1 - (embedding <=> $6::vector) AS sim
           FROM memory_chunks WHERE $6::text IS NOT NULL AND id IN (SELECT id FROM scope)
           ORDER BY embedding <=> $6::vector LIMIT $7)`;
    return q<CandidateRow & { lexical: boolean; rrf: number }>(
      `WITH scope AS MATERIALIZED (
         SELECT id FROM memory_chunks WHERE ${SCOPE} AND NOT (cardinality(source_ids) > 0 AND source_ids <@ $5::bigint[])
       ),
       ${lexCte},
       ${vecCte}
       SELECT c.id, c.kind, c.content, c.created_at, c.visibility,
              COALESCE(v.sim, CASE WHEN $6::text IS NULL THEN 0 ELSE 1 - (c.embedding <=> $6::vector) END) AS similarity,
              l.id IS NOT NULL AS lexical,
              COALESCE(1.0 / (${RRF_K} + l.r), 0) + COALESCE(1.0 / (${RRF_K} + v.r), 0) AS rrf
       FROM memory_chunks c LEFT JOIN lex l ON l.id = c.id LEFT JOIN vec v ON v.id = c.id
       WHERE l.id IS NOT NULL OR v.id IS NOT NULL
       ORDER BY rrf DESC LIMIT $7`,
      [...scope, exclude, vec, CANDIDATES, terms.join(" ")],
      client,
    );
  });
  const minVector = input.minVectorSimilarity ?? MIN_SIMILARITY;
  const candidates: Candidate[] = rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      createdAt: r.created_at,
      similarity: Number(r.similarity),
      visibility: r.visibility,
      lexical: r.lexical,
      rrf: Number(r.rrf),
    }))
    // A word match always counts; a vector-only neighbour has to be genuinely close.
    .filter((c) => c.lexical || c.similarity >= minVector);
  return rankHybrid(candidates, input.now, input.limit ?? DEFAULT_LIMIT);
}

/**
 * Hybrid order: similarity (or a lexical floor when only BM25 matched) × recency × importance,
 * with the RRF score breaking near-ties. Kept separate from rerank() (pure-vector scoring).
 */
export function rankHybrid(candidates: readonly Candidate[], now: Date, limit = Number.POSITIVE_INFINITY): MemoryHit[] {
  return candidates
    .map((c) => {
      const base = Math.max(c.similarity, c.lexical ? 0.5 : 0) + (c.rrf ?? 0);
      const score = base * recencyFactor((now.getTime() - c.createdAt.getTime()) / 86_400_000) * (IMPORTANCE[c.kind] ?? 1);
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
    .slice(0, limit);
}
