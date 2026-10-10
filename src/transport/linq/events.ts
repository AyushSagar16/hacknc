// Adapted from ethanyanghq/scout bridge/linq.ts (readLinqEvent, readTapback, readParts)
// @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: zod-validated payloads for both webhook versions (2026-02-03 and 2025-01-01);
// tapback removals are forwarded (so a vote can be taken back) instead of dropped; native
// poll votes (poll.vote.added/removed) become Spectrum poll_option content; membership
// events (participant.added/removed, chat.created) become addMember/removeMember content;
// is_group and the webhook event id travel as validated extras; link parts read as text.

import type { Content, Message } from "spectrum-ts";
import { asAttachment, asGroup, asPoll, asPollOption, asReaction, type ProviderMessageRecord } from "spectrum-ts/authoring";
import { z } from "zod";
import { safeExtras } from "../extras.ts";
import { isTapback, tapbackEmoji } from "../tapbacks.ts";
import type { LinqEnvelope } from "./webhook.ts";

export type Skip = { skip: string };
export type ReadResult = ProviderMessageRecord | Skip;

export function isSkip(r: ReadResult): r is Skip {
  return "skip" in r;
}

export interface PollInfo {
  title: string;
  /** `voters` (handles) is present when the info came from the poll API, which lists them. */
  options: { id: string; text: string; voters?: string[] }[];
}

/** The option title a vote carries when Atlas couldn't work out which option it was for. */
export const UNKNOWN_POLL_OPTION = "(unreadable option)";

export interface ReadContext {
  /** Our own line's handles (E.164), to recognize "Atlas was added". */
  selfHandles: ReadonlySet<string>;
  /** Resolve a poll's options (cached by the platform; falls back to the Linq API). `fresh` skips the cache. */
  pollInfo: (pollMessageId: string, opts?: { fresh?: boolean }) => Promise<PollInfo | undefined>;
  /** Download a media part lazily. */
  download: (url: string) => Promise<Buffer>;
}

const handleSchema = z.union([z.string(), z.object({ handle: z.string(), is_me: z.boolean().optional() }).passthrough()]);
const partSchema = z
  .object({ type: z.string(), value: z.string().optional(), url: z.string().optional(), mime_type: z.string().optional() })
  .passthrough();

const received2026 = z
  .object({
    id: z.string(),
    chat: z.object({ id: z.string(), is_group: z.boolean().optional() }).passthrough(),
    direction: z.string().optional(),
    sender_handle: handleSchema,
    parts: z.array(partSchema).default([]),
    sent_at: z.string().optional(),
    reply_to: z.object({ message_id: z.string() }).passthrough().nullish(),
  })
  .passthrough();

const received2025 = z
  .object({
    chat_id: z.string(),
    from: z.string().optional(),
    from_handle: handleSchema.optional(),
    is_from_me: z.boolean().optional(),
    is_group: z.boolean().optional(),
    message: z
      .object({ id: z.string(), parts: z.array(partSchema).default([]), sent_at: z.string().nullish(), created_at: z.string().nullish() })
      .passthrough(),
  })
  .passthrough();

const reactionData = z
  .object({
    chat_id: z.string(),
    message_id: z.string(),
    reaction_type: z.string(),
    custom_emoji: z.string().nullish(),
    is_from_me: z.boolean().optional(),
    from: z.string().optional(),
    from_handle: handleSchema.optional(),
    reacted_at: z.string().optional(),
  })
  .passthrough();

const pollVoteData = z
  .object({
    message_id: z.string(),
    direction: z.string().optional(),
    chat: z.object({ id: z.string(), is_group: z.boolean().optional() }).passthrough(),
    sender_handle: handleSchema,
    option_id: z.string(),
  })
  .passthrough();

const participantData = z
  .object({
    chat_id: z.string(),
    handle: handleSchema.optional(),
    participant: z.union([handleSchema, z.record(z.string(), z.unknown())]).optional(),
    added_at: z.string().optional(),
    removed_at: z.string().optional(),
  })
  .passthrough();

const chatCreatedData = z
  .object({
    id: z.string(),
    is_group: z.boolean().optional(),
    handles: z.array(handleSchema).default([]),
    created_at: z.string().optional(),
  })
  .passthrough();

const handleOf = (h: z.infer<typeof handleSchema> | undefined): string | undefined => (typeof h === "string" ? h : h?.handle);
const isMe = (h: z.infer<typeof handleSchema> | undefined, self: ReadonlySet<string>): boolean =>
  typeof h === "object" ? h.is_me === true || self.has(h.handle) : h !== undefined && self.has(h);

const when = (iso: string | null | undefined, fallback: Date): Date => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : fallback;
};

/** Turn one webhook into a Spectrum record, or say why Atlas skips it. */
export async function readLinqEvent(
  envelope: LinqEnvelope,
  eventId: string,
  receivedAt: Date,
  ctx: ReadContext,
): Promise<ReadResult> {
  const type = envelope.event_type;
  switch (type) {
    case "message.received":
      return readReceived(envelope.data, eventId, receivedAt, ctx);
    case "reaction.added":
    case "reaction.removed":
      return readReaction(envelope.data, eventId, receivedAt, type === "reaction.removed", ctx);
    case "poll.vote.added":
    case "poll.vote.removed":
      return readPollVote(envelope.data, eventId, receivedAt, type === "poll.vote.added", ctx);
    case "participant.added":
    case "participant.removed":
      return readParticipant(envelope.data, eventId, receivedAt, type === "participant.added", ctx);
    case "chat.created":
      return readChatCreated(envelope.data, eventId, receivedAt, ctx);
    default:
      return { skip: `not a member event (${type})` };
  }
}

async function readReceived(data: unknown, eventId: string, receivedAt: Date, ctx: ReadContext): Promise<ReadResult> {
  const modern = received2026.safeParse(data);
  if (modern.success) {
    const m = modern.data;
    if (m.direction === "outbound" || isMe(m.sender_handle, ctx.selfHandles)) return { skip: "atlas's own message" };
    const sender = handleOf(m.sender_handle);
    if (!sender) return { skip: "no sender" };
    const content = readParts(m.id, m.parts, ctx);
    if (!content) return { skip: "nothing in it" };
    return {
      id: m.id,
      content,
      direction: "inbound",
      sender: { id: sender },
      space: { id: m.chat.id },
      timestamp: when(m.sent_at, receivedAt),
      ...safeExtras({
        replyTo: m.reply_to ? { messageId: m.reply_to.message_id } : undefined,
        isGroup: m.chat.is_group,
        receivedAt,
        eventId,
      }),
    };
  }
  const legacy = received2025.safeParse(data);
  if (legacy.success) {
    const m = legacy.data;
    if (m.is_from_me) return { skip: "atlas's own message" };
    const sender = m.from ?? handleOf(m.from_handle);
    if (!sender || ctx.selfHandles.has(sender)) return { skip: "atlas's own message" };
    const content = readParts(m.message.id, m.message.parts, ctx);
    if (!content) return { skip: "nothing in it" };
    return {
      id: m.message.id,
      content,
      direction: "inbound",
      sender: { id: sender },
      space: { id: m.chat_id },
      timestamp: when(m.message.sent_at ?? m.message.created_at, receivedAt),
      ...safeExtras({ isGroup: m.is_group, receivedAt, eventId }),
    };
  }
  return { skip: "unrecognized message.received payload" };
}

// Spectrum only needs an id and content on a reaction target; the pipeline looks up the words.
const targetRef = (id: string) => ({ id, content: { type: "text", text: "" } }) as unknown as Message;

function readReaction(data: unknown, eventId: string, receivedAt: Date, removed: boolean, ctx: ReadContext): ReadResult {
  const parsed = reactionData.safeParse(data);
  if (!parsed.success) return { skip: "unrecognized reaction payload" };
  const r = parsed.data;
  const from = r.from ?? handleOf(r.from_handle);
  if (r.is_from_me || !from || ctx.selfHandles.has(from)) return { skip: "atlas's own tapback" };
  const emoji = isTapback(r.reaction_type) ? tapbackEmoji(r.reaction_type) : r.custom_emoji;
  if (!emoji) return { skip: `a ${r.reaction_type} reaction` };
  return {
    id: eventId,
    content: asReaction({ emoji, target: targetRef(r.message_id) }),
    direction: "inbound",
    sender: { id: from },
    space: { id: r.chat_id },
    timestamp: when(r.reacted_at, receivedAt),
    ...safeExtras({ reactionRemoved: removed || undefined, receivedAt, eventId }),
  };
}

async function readPollVote(data: unknown, eventId: string, receivedAt: Date, selected: boolean, ctx: ReadContext): Promise<ReadResult> {
  const parsed = pollVoteData.safeParse(data);
  if (!parsed.success) return { skip: "unrecognized poll vote payload" };
  const v = parsed.data;
  if (v.direction === "outbound" || isMe(v.sender_handle, ctx.selfHandles)) return { skip: "atlas's own vote" };
  const sender = handleOf(v.sender_handle);
  if (!sender) return { skip: "no voter" };

  // A vote must never be lost to a cache or API hiccup: cached options, then a fresh read of the
  // poll, then the poll's own voter list (an added vote shows the sender under their option).
  // If all of that fails the vote still goes through with an unreadable option, and the poll
  // feature reconciles it from the provider's voter list later.
  let info = await ctx.pollInfo(v.message_id).catch(() => undefined);
  let chosen = info?.options.find((o) => o.id && o.id === v.option_id);
  if (!chosen) {
    info = (await ctx.pollInfo(v.message_id, { fresh: true }).catch(() => undefined)) ?? info;
    chosen = info?.options.find((o) => o.id && o.id === v.option_id);
  }
  if (!chosen && selected && info) {
    const mine = info.options.filter((o) => o.voters?.includes(sender));
    if (mine.length === 1) chosen = mine[0];
  }
  const titles = (info?.options ?? []).map((o) => o.text).filter(Boolean);
  const optionTitle = chosen?.text || UNKNOWN_POLL_OPTION;
  const pollTitles = titles.includes(optionTitle) ? titles.slice(0, 10) : [...titles.slice(0, 9), optionTitle];
  while (pollTitles.length < 2) pollTitles.push(pollTitles.includes(UNKNOWN_POLL_OPTION) ? `${UNKNOWN_POLL_OPTION} ${pollTitles.length}` : UNKNOWN_POLL_OPTION);
  let content: Content;
  try {
    const poll = asPoll({ title: info?.title || "poll", options: pollTitles.map((title) => ({ title })) });
    content = asPollOption({ option: { title: optionTitle }, poll, selected });
  } catch {
    return { skip: "poll vote did not fit Spectrum's poll shape" };
  }
  return {
    id: eventId,
    content,
    direction: "inbound",
    sender: { id: sender },
    space: { id: v.chat.id },
    timestamp: receivedAt,
    ...safeExtras({ pollMessageId: v.message_id, optionId: v.option_id, isGroup: v.chat.is_group, receivedAt, eventId }),
  };
}

function readParticipant(data: unknown, eventId: string, receivedAt: Date, added: boolean, ctx: ReadContext): ReadResult {
  const parsed = participantData.safeParse(data);
  if (!parsed.success) return { skip: "unrecognized participant payload" };
  const p = parsed.data;
  const participant = p.participant as z.infer<typeof handleSchema> | undefined;
  const handle = handleOf(p.handle) ?? (typeof participant === "string" || (participant && "handle" in participant) ? handleOf(participant) : undefined);
  if (!handle) return { skip: "participant event without a handle" };
  const self = ctx.selfHandles.has(handle) || (typeof participant === "object" && participant?.is_me === true);
  return {
    id: eventId,
    content: { type: added ? "addMember" : "removeMember", members: self ? [] : [handle] } as Content,
    direction: "inbound",
    space: { id: p.chat_id },
    timestamp: when(p.added_at ?? p.removed_at, receivedAt),
    ...safeExtras({ memberEvent: self ? (added ? "joined" : "removed") : added ? "added" : "removed", isGroup: true, receivedAt, eventId }),
  };
}

function readChatCreated(data: unknown, eventId: string, receivedAt: Date, ctx: ReadContext): ReadResult {
  const parsed = chatCreatedData.safeParse(data);
  if (!parsed.success) return { skip: "unrecognized chat.created payload" };
  const c = parsed.data;
  if (!c.is_group) return { skip: "a new private chat" };
  const others = c.handles.filter((h) => !isMe(h, ctx.selfHandles)).map(handleOf).filter((h): h is string => Boolean(h));
  return {
    id: eventId,
    content: { type: "addMember", members: others } as Content,
    direction: "inbound",
    space: { id: c.id },
    timestamp: when(c.created_at, receivedAt),
    ...safeExtras({ memberEvent: "joined", isGroup: true, receivedAt, eventId }),
  };
}

/** Text parts become one text, each media part an attachment; a photo with a caption becomes a group. */
export function readParts(messageId: string, parts: z.infer<typeof partSchema>[], ctx: Pick<ReadContext, "download">): Content | null {
  const texts = parts.flatMap((p) => ((p.type === "text" || p.type === "link") && p.value ? [p.value] : []));
  const media = parts.filter((p) => p.type === "media" && p.url);
  const items: Content[] = [
    ...(texts.length > 0 ? [{ type: "text" as const, text: texts.join("\n") }] : []),
    ...media.map((p) =>
      asAttachment({
        name: p.url!.split("/").pop()?.split("?")[0] || "attachment",
        mimeType: p.mime_type ?? "application/octet-stream",
        read: () => ctx.download(p.url!),
      }),
    ),
  ];
  if (items.length <= 1) return items[0] ?? null;
  return asGroup({ items: items.map((content, i) => ({ id: `${messageId}:${i}`, content })) as unknown as Message[] });
}
