// The durable inbound log behind the Linq webhook: insert-before-ack, mark processed once
// the pipeline has stored the message, replay unprocessed events after a restart.
import { now } from "../clock.ts";
import { one, q } from "../db/pool.ts";
import type { WebhookEvent, WebhookSink } from "../transport/linq/webhook.ts";

export async function persistWebhookEvent(event: WebhookEvent): Promise<boolean> {
  const row = await one(
    `INSERT INTO webhook_events (webhook_id, event_type, received_at, payload) VALUES ($1, $2, $3, $4)
     ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`,
    [event.id, event.envelope.event_type, event.receivedAt, JSON.stringify(event.envelope)],
  );
  return Boolean(row);
}

export async function markWebhookProcessed(webhookId: string, note?: string): Promise<void> {
  await q(`UPDATE webhook_events SET processed_at = $2, error = $3 WHERE webhook_id = $1 AND processed_at IS NULL`, [webhookId, now(), note ?? null]);
}

/** Events received in the last day that never reached the pipeline, oldest first. */
export async function unprocessedWebhookEvents(maxAgeHours = 24): Promise<WebhookEvent[]> {
  const since = new Date(now().getTime() - maxAgeHours * 3_600_000);
  const rows = await q<{ webhook_id: string; payload: WebhookEvent["envelope"]; received_at: Date }>(
    `SELECT webhook_id, payload, received_at FROM webhook_events WHERE processed_at IS NULL AND received_at >= $1 ORDER BY received_at`,
    [since],
  );
  return rows.map((r) => ({ id: r.webhook_id, envelope: r.payload, receivedAt: r.received_at }));
}

export function webhookSink(enqueue: (event: WebhookEvent) => void): WebhookSink {
  return { persist: persistWebhookEvent, enqueue };
}
