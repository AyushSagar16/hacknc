// Durable background jobs in Postgres: claimed with FOR UPDATE SKIP LOCKED, due-times
// from the app clock (so the simulator's time travel fires them), retried with jittered
// backoff, and every failure recorded in job_failures.
import { randomUUID } from "node:crypto";
import { now } from "../clock.ts";
import { childLog } from "../log.ts";
import { db, one, q, type Queryable } from "../db/pool.ts";

/** Return `{ rescheduleAt }` to run the same job again later (recurring work like weather checks). */
export type JobHandler = (payload: Record<string, unknown>, ctx: { jobId: number; attempt: number }) => Promise<void | { rescheduleAt?: Date | null; payload?: Record<string, unknown> }>;

export interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueueJob(
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { dueAt?: Date; singletonKey?: string; maxAttempts?: number } = {},
  on: Queryable = db(),
): Promise<number | undefined> {
  const row = await one<{ id: number }>(
    `INSERT INTO jobs (kind, due_at, payload, singleton_key, max_attempts, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL AND done_at IS NULL AND failed_at IS NULL DO NOTHING
     RETURNING id`,
    [kind, opts.dueAt ?? now(), JSON.stringify(payload), opts.singletonKey ?? null, opts.maxAttempts ?? 5, now()],
    on,
  );
  return row?.id;
}

/** Move a pending singleton job's due time (e.g. re-plan the next weather check). */
export async function rescheduleSingleton(singletonKey: string, dueAt: Date): Promise<void> {
  await q(`UPDATE jobs SET due_at = $2 WHERE singleton_key = $1 AND done_at IS NULL AND failed_at IS NULL AND locked_at IS NULL`, [singletonKey, dueAt]);
}

/** Record a failure without ever throwing; a failed failure-record must not take down a worker. */
export async function recordJobFailure(
  queue: string,
  jobId: string | number | null,
  payload: unknown,
  error: unknown,
  chatId?: number | null,
): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    let body = JSON.stringify(payload ?? null);
    if (body.length > 4_000) body = JSON.stringify({ truncated: true, preview: body.slice(0, 4_000) });
    await q(
      `INSERT INTO job_failures (queue, job_id, chat_id, payload, error, stack, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [queue, jobId === null ? null : String(jobId), chatId ?? null, body, err.message.slice(0, 2_000), err.stack?.slice(0, 4_000) ?? null, now()],
    );
  } catch (logErr) {
    childLog({ component: "job_failures" }).error({ queue, jobId, err: err.message, logErr: (logErr as Error).message }, "could not record job failure");
  }
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workerId = `w-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly log = childLog({ component: "jobs" });

  register(kind: string, handler: JobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  start(intervalMs = 1_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDue();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "job tick failed");
    } finally {
      this.running = false;
    }
  }

  /** Run every job that is due now (by the app clock). Returns how many ran. */
  async runDue(limit = 50): Promise<number> {
    let ran = 0;
    while (ran < limit) {
      const job = await this.claim();
      if (!job) break;
      ran += 1;
      await this.execute(job);
    }
    return ran;
  }

  private async claim(): Promise<JobRow | undefined> {
    const t = now();
    return one<JobRow>(
      `UPDATE jobs SET locked_at = $1, locked_by = $2, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE done_at IS NULL AND failed_at IS NULL AND due_at <= $1
           AND (locked_at IS NULL OR locked_at < $1 - interval '5 minutes')
           AND kind = ANY($3)
         ORDER BY due_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [t, this.workerId, [...this.handlers.keys()]],
    );
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) return;
    try {
      const outcome = await handler(job.payload, { jobId: job.id, attempt: job.attempts });
      if (outcome && outcome.rescheduleAt) {
        await q(`UPDATE jobs SET due_at = $2, locked_at = NULL, attempts = 0, last_error = NULL, payload = COALESCE($3, payload) WHERE id = $1`, [
          job.id,
          outcome.rescheduleAt,
          outcome.payload ? JSON.stringify(outcome.payload) : null,
        ]);
      } else {
        await q(`UPDATE jobs SET done_at = $2, locked_at = NULL WHERE id = $1`, [job.id, now()]);
      }
    } catch (err) {
      const chatId = typeof job.payload.chatId === "number" ? job.payload.chatId : null;
      await recordJobFailure(job.kind, job.id, job.payload, err, chatId);
      if (job.attempts >= job.max_attempts) {
        await q(`UPDATE jobs SET failed_at = $2, locked_at = NULL, last_error = $3 WHERE id = $1`, [job.id, now(), (err as Error).message]);
        this.log.error({ kind: job.kind, jobId: job.id, err: (err as Error).message }, "job failed permanently");
      } else {
        const delay = Math.min(15 * 60_000, 2_000 * 2 ** job.attempts) * (0.8 + Math.random() * 0.4);
        await q(`UPDATE jobs SET due_at = $2, locked_at = NULL, last_error = $3 WHERE id = $1`, [job.id, new Date(now().getTime() + delay), (err as Error).message]);
        this.log.warn({ kind: job.kind, jobId: job.id, attempt: job.attempts, err: (err as Error).message }, "job failed; will retry");
      }
    }
  }
}

/** 30-day retention for the audit table and finished jobs. */
export async function pruneOld(): Promise<void> {
  const cutoff = new Date(now().getTime() - 30 * 86_400_000);
  await q(`DELETE FROM job_failures WHERE created_at < $1`, [cutoff]);
  await q(`DELETE FROM jobs WHERE (done_at IS NOT NULL OR failed_at IS NOT NULL) AND created_at < $1`, [cutoff]);
}
