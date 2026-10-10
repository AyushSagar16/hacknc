// Long-term memory, read side. One nearest-neighbour query over the diskann index, scoped so
// history never crosses chats (message and decision chunks must belong to this chat) while a
// person's facts follow them into every chat they're in; private chunks only surface in that
// person's own 1:1 chat. Candidates are then reranked in code with a gentle recency decay.
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
/** Below this cosine similarity a chunk is noise. */
export const MIN_SIMILARITY = 0.15;
/** Recency multiplier: 1.0 for a fresh chunk, decaying (e-folding RECENCY_DAYS) to RECENCY_FLOOR. */
export const RECENCY_FLOOR = 0.85;
export const RECENCY_DAYS = 14;

export interface Candidate {
  id: number;
  kind: ChunkKind;
  content: string;
  createdAt: Date;
  /** 1 − cosine distance. */
  similarity: number;
  visibility?: Visibility;
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
const SCOPE = `embedding IS NOT NULL
  AND ((kind IN ('message', 'decision') AND chat_id = $1) OR (kind = 'fact' AND person_id = ANY($2::bigint[])))
  AND (visibility = 'public' OR (NOT $3::boolean AND person_id = $4::bigint))`;

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
  // Nothing recallable (a brand-new chat, or every chunk is made of messages the agent already sees,
  // as in any chat younger than the fresh window): skip the embedding call, ~200–500 ms and a request
  // from the free-tier embed bucket on every agent turn. Same filter as the query below, minus ranking.
  if (!(await one(`SELECT 1 FROM memory_chunks WHERE ${SCOPE} AND NOT (cardinality(source_ids) > 0 AND source_ids <@ $5::bigint[]) LIMIT 1`, [...scope, exclude]))) return [];
  const [vector] = await input.llm.embed([query], "query");
  if (!vector || !vector.some((x) => x !== 0)) return [];
  const rows = await tx(async (client) => {
    // diskann walks a graph with 1-bit quantized distances and re-scores only the first N with the
    // full vectors; the chat/person filter is applied after, so widen both for this query only.
    // (hnsw.ef_search covers the HNSW fallback when pgvectorscale isn't installed.)
    await q(
      `SELECT set_config('diskann.query_search_list_size', $1, true), set_config('diskann.query_rescore', $2, true), set_config('hnsw.ef_search', $3, true)`,
      [String(SEARCH_LIST_SIZE), String(RESCORE), String(SEARCH_LIST_SIZE)],
      client,
    );
    return q<CandidateRow>(
      `SELECT id, kind, content, created_at, visibility, 1 - (embedding <=> $5::vector) AS similarity
       FROM memory_chunks
       WHERE ${SCOPE}
         AND NOT (cardinality(source_ids) > 0 AND source_ids <@ $6::bigint[])
       ORDER BY embedding <=> $5::vector
       LIMIT $7`,
      [...scope, vectorLiteral(vector), exclude, CANDIDATES],
      client,
    );
  });
  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    content: r.content,
    createdAt: r.created_at,
    similarity: Number(r.similarity),
    visibility: r.visibility,
  }));
  return rerank(candidates, input.now, input.limit ?? DEFAULT_LIMIT);
}
