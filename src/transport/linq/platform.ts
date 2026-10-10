// Adapted from ethanyanghq/scout bridge/linq.ts (linqPlatform, sendContent, setTyping,
// sendTapback, listMembers, fetchMessage) @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: inbound events come from a durable, signature-checked webhook log through an
// ordered queue (one bad event is skipped, never ends the stream); native Linq polls (title
// sent as its own bubble, votes mapped back through a poll cache + the poll API); custom-emoji
// reactions; idempotency keys from the outbox GUID; typing errors never fail a send; the rival
// guard is echo detection on message.sent instead of a GET before every send.

import { UnsupportedError, definePlatform, type Content } from "spectrum-ts";
import type { ProviderMessageRecord } from "spectrum-ts/authoring";
import { z } from "zod";
import { LRUCache } from "lru-cache";
import { childLog } from "../../log.ts";
import { inboundExtrasSchema } from "../extras.ts";
import { currentClientGuid } from "../sendContext.ts";
import { tapbackNamed } from "../tapbacks.ts";
import type { EventQueue } from "../queue.ts";
import { LinqApiError, type LinqApi } from "./api.ts";
import { isSkip, readLinqEvent, readParts, type PollInfo } from "./events.ts";
import type { WebhookEvent } from "./webhook.ts";

export const LINQ_PLATFORM = "linq";

export interface LinqPlatformDeps {
  api: LinqApi;
  queue: EventQueue<WebhookEvent>;
  /** Our line's own handles; filled in at startup from /phone_numbers. */
  selfHandles: () => ReadonlySet<string>;
  /** Called for events Atlas doesn't turn into a message, so the log can mark them processed. */
  onSkip?: (event: WebhookEvent, reason: string) => void;
  /** Called when the line sent a message this process didn't — another Atlas is running on it. */
  onRival?: (chatId: string, messageId: string) => void;
  /** False when poll vote events can't reach us (CLI relay): polls then fall back to numbered text. */
  nativePolls?: () => boolean;
}

const sentEventSchema = z
  .object({ id: z.string().optional(), message: z.object({ id: z.string() }).passthrough().optional(), chat: z.object({ id: z.string() }).passthrough().optional(), chat_id: z.string().optional() })
  .passthrough();

export function linqPlatform(deps: LinqPlatformDeps) {
  const log = childLog({ component: "linq.platform" });
  const { api } = deps;
  const chatsWithoutTyping = new Set<string>();
  const ownMessageIds = new LRUCache<string, true>({ max: 2_000 });
  const polls = new LRUCache<string, PollInfo>({ max: 500 });
  const pollTitles = new Map<string, string>();

  const pollInfo = async (messageId: string): Promise<PollInfo | undefined> => {
    const cached = polls.get(messageId);
    if (cached && cached.options.every((o) => o.id)) return cached;
    try {
      const poll = await api.getPoll(messageId);
      const info = { title: pollTitles.get(messageId) ?? cached?.title ?? "poll", options: poll.options.map((o) => ({ id: o.id, text: o.text })) };
      polls.set(messageId, info);
      return info;
    } catch (err) {
      log.warn({ err: (err as Error).message, messageId }, "could not read poll");
      return cached;
    }
  };

  const download = async (url: string): Promise<Buffer> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };

  const watchForRival = (event: WebhookEvent) => {
    const parsed = sentEventSchema.safeParse(event.envelope.data);
    if (!parsed.success) return;
    const messageId = parsed.data.message?.id ?? parsed.data.id;
    const chatId = parsed.data.chat?.id ?? parsed.data.chat_id;
    if (!messageId || !chatId) return;
    // Our own POST may still be in flight when Linq reports the send, so look again shortly.
    setTimeout(() => {
      if (!ownMessageIds.has(messageId)) deps.onRival?.(chatId, messageId);
    }, 5_000).unref();
  };

  async function* messages(): AsyncGenerator<ProviderMessageRecord> {
    for await (const event of deps.queue) {
      try {
        if (event.envelope.event_type === "message.sent") {
          watchForRival(event);
          deps.onSkip?.(event, "atlas's own send");
          continue;
        }
        const result = await readLinqEvent(event.envelope, event.id, event.receivedAt, {
          selfHandles: deps.selfHandles(),
          pollInfo,
          download,
        });
        if (isSkip(result)) {
          deps.onSkip?.(event, result.skip);
          continue;
        }
        yield result;
      } catch (err) {
        // One bad event must never end the stream (and with it every chat's inbound).
        log.error({ err: (err as Error).message, eventId: event.id }, "failed to read linq event");
        deps.onSkip?.(event, `error: ${(err as Error).message}`);
      }
    }
  }

  const record = (id: string, content: Content, chatId: string): ProviderMessageRecord => {
    ownMessageIds.set(id, true);
    return { id, content, space: { id: chatId }, timestamp: new Date() };
  };

  const setTyping = async (chatId: string, state: "start" | "stop"): Promise<undefined> => {
    if (chatsWithoutTyping.has(chatId)) return undefined;
    try {
      await api.setTyping(chatId, state === "start");
    } catch (err) {
      // Linq refuses typing in group chats (403); stop asking there. Any other error is logged
      // and swallowed: a typing bubble is never worth failing a reply over.
      if (err instanceof LinqApiError && err.status === 403) chatsWithoutTyping.add(chatId);
      else log.warn({ err: (err as Error).message, chatId }, "typing indicator failed");
    }
    return undefined;
  };

  return definePlatform(LINQ_PLATFORM, {
    config: z.object({}),
    message: { schema: inboundExtrasSchema },
    user: { resolve: async ({ input }) => ({ id: input.userID }) },
    space: {
      create: async (): Promise<{ id: string }> => {
        throw UnsupportedError.action("space.create", LINQ_PLATFORM, "friends add Atlas to their group");
      },
    },
    lifecycle: { createClient: async () => api },
    // Records are pre-validated (extras via safeExtras); the cast bridges Spectrum's schema-derived record type.
    messages: messages as never,
    actions: {
      getMembers: async (_ctx, space) => {
        const chat = await api.getChat(space.id);
        return chat.handles.filter((h) => !h.is_me && (h.status ?? "active") === "active" && !deps.selfHandles().has(h.handle)).map((h) => ({ id: h.handle }));
      },
      getMessage: async (_ctx, _space, messageId) => {
        try {
          const m = await api.getMessage(messageId);
          const content = readParts(m.id, m.parts as never, { download });
          if (!content) return undefined;
          return { id: m.id, content, direction: m.is_from_me ? "outbound" : "inbound", space: { id: m.chat_id }, timestamp: new Date(m.created_at) };
        } catch {
          return undefined;
        }
      },
    },
    send: async ({ space, content }) => {
      const chatId = space.id;
      const guid = currentClientGuid();
      switch (content.type) {
        case "typing":
          return setTyping(chatId, content.state);
        case "text": {
          const sent = await api.sendMessage(chatId, [{ type: "text", value: content.text }], { idempotencyKey: guid });
          return record(sent.id, content, chatId);
        }
        case "reply": {
          if (content.content.type !== "text") throw UnsupportedError.content("reply", LINQ_PLATFORM, "only text replies");
          const sent = await api.sendMessage(chatId, [{ type: "text", value: content.content.text }], {
            replyTo: content.target.id,
            idempotencyKey: guid,
          });
          return record(sent.id, content, chatId);
        }
        case "reaction": {
          const tapback = tapbackNamed(content.emoji);
          if (tapback) await api.react(content.target.id, tapback);
          else await api.react(content.target.id, "custom", { customEmoji: content.emoji });
          return record(`${content.target.id}:${tapback ?? content.emoji}`, content, chatId);
        }
        case "poll": {
          if (deps.nativePolls && !deps.nativePolls()) throw UnsupportedError.content("poll", LINQ_PLATFORM, "poll votes aren't subscribed on this connection");
          // Linq polls carry no question, so the question goes first as its own bubble.
          await api.sendMessage(chatId, [{ type: "text", value: content.title }], { idempotencyKey: guid ? `${guid}:q` : undefined });
          const { messageId } = await api.createPoll(
            chatId,
            content.options.map((o) => o.title),
            guid,
          );
          pollTitles.set(messageId, content.title);
          polls.set(messageId, { title: content.title, options: content.options.map((o) => ({ id: "", text: o.title })) });
          return record(messageId, content, chatId);
        }
        case "richlink": {
          // A link part must be alone in its message.
          const sent = await api.sendMessage(chatId, [{ type: "link", value: content.url }], { idempotencyKey: guid });
          return record(sent.id, content, chatId);
        }
        default:
          throw UnsupportedError.content(content.type, LINQ_PLATFORM);
      }
    },
  });
}
