// Extra fields our custom platforms attach to inbound messages. Spectrum parses these
// with the platform's message.schema on every record and ends the whole stream if one
// fails, so every field is optional and records are pre-validated before they're yielded.
import { z } from "zod";

export const inboundExtrasSchema = z.object({
  replyTo: z.object({ messageId: z.string() }).optional(),
  isGroup: z.boolean().optional(),
  receivedAt: z.date().optional(),
  eventId: z.string().optional(),
  reactionRemoved: z.boolean().optional(),
  pollMessageId: z.string().optional(),
  optionId: z.string().optional(),
  /** "joined" = Atlas itself was added (or first saw the chat); members lists the others. */
  memberEvent: z.enum(["added", "removed", "joined"]).optional(),
});

export type InboundExtras = z.infer<typeof inboundExtrasSchema>;

/** Returns only the extras that validate, so one odd field can't end the stream. */
export function safeExtras(extras: Record<string, unknown>): InboundExtras {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extras)) {
    if (value === undefined) continue;
    const field = inboundExtrasSchema.shape[key as keyof InboundExtras];
    if (field && field.safeParse(value).success) out[key] = value;
  }
  return out as InboundExtras;
}
