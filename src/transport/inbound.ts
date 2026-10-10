// Turns any platform's [space, message] pair into one small event type the pipeline
// understands. Everything platform-specific stops here.
import type { Message, Space } from "spectrum-ts";
import { tapbackNamed } from "./tapbacks.ts";
import type { InboundExtras } from "./extras.ts";

interface Base {
  platform: string;
  chatId: string;
  isGroup: boolean | undefined;
  providerMessageId: string;
  sentAt: Date;
  receivedAt: Date;
  eventId?: string;
}

export type InboundEvent =
  | (Base & { kind: "text"; sender: string; text: string; replyToId?: string; hasMedia: boolean })
  | (Base & { kind: "reaction"; sender: string; emoji: string; tapback?: string; targetId: string; removed: boolean })
  | (Base & {
      kind: "poll_vote";
      sender: string;
      pollMessageId?: string;
      optionTitle: string;
      pollTitle: string;
      pollOptions: string[];
      selected: boolean;
    })
  | (Base & { kind: "membership"; change: "joined" | "added" | "removed"; handles: string[]; actor?: string })
  | { kind: "ignored"; reason: string; platform: string; eventId?: string };

export function normalize(space: Space, message: Message, now: Date): InboundEvent {
  const extras = message as unknown as InboundExtras;
  const platform = message.platform;
  if (message.direction === "outbound") return { kind: "ignored", reason: "outbound echo", platform, eventId: extras.eventId };

  const base: Base = {
    platform,
    chatId: space.id,
    isGroup: extras.isGroup ?? guessGroup(space),
    providerMessageId: message.id,
    sentAt: message.timestamp ?? now,
    receivedAt: extras.receivedAt ?? now,
    eventId: extras.eventId,
  };
  const sender = message.sender?.id;
  const content = message.content;

  switch (content.type) {
    case "text":
      if (!sender) return { kind: "ignored", reason: "no sender", platform, eventId: extras.eventId };
      return { ...base, kind: "text", sender, text: content.text, replyToId: extras.replyTo?.messageId, hasMedia: false };
    case "group": {
      if (!sender) return { kind: "ignored", reason: "no sender", platform, eventId: extras.eventId };
      const texts = content.items.flatMap((item) => (item.content.type === "text" ? [item.content.text] : []));
      const media = content.items.filter((item) => item.content.type === "attachment" || item.content.type === "voice").length;
      const text = [texts.join("\n"), media ? `(sent ${media === 1 ? "a photo" : `${media} attachments`})` : ""].filter(Boolean).join(" ");
      return { ...base, kind: "text", sender, text, replyToId: extras.replyTo?.messageId, hasMedia: media > 0 };
    }
    case "attachment":
    case "voice":
      if (!sender) return { kind: "ignored", reason: "no sender", platform, eventId: extras.eventId };
      return {
        ...base,
        kind: "text",
        sender,
        text: content.type === "voice" ? "(sent a voice note)" : `(sent ${content.mimeType.startsWith("image/") ? "a photo" : "a file"})`,
        hasMedia: true,
      };
    case "reaction":
      if (!sender) return { kind: "ignored", reason: "no sender", platform, eventId: extras.eventId };
      return {
        ...base,
        kind: "reaction",
        sender,
        emoji: content.emoji,
        tapback: tapbackNamed(content.emoji),
        targetId: content.target.id,
        removed: extras.reactionRemoved === true,
      };
    case "poll_option":
      if (!sender) return { kind: "ignored", reason: "no sender", platform, eventId: extras.eventId };
      return {
        ...base,
        kind: "poll_vote",
        sender,
        pollMessageId: extras.pollMessageId,
        optionTitle: content.option.title,
        pollTitle: content.poll.title,
        pollOptions: content.poll.options.map((o) => o.title),
        selected: content.selected,
      };
    case "addMember":
    case "removeMember":
      return {
        ...base,
        kind: "membership",
        change: extras.memberEvent ?? (content.type === "addMember" ? "added" : "removed"),
        handles: content.members,
        actor: sender,
      };
    default:
      return { kind: "ignored", reason: `unhandled content ${content.type}`, platform, eventId: extras.eventId };
  }
}

function guessGroup(space: Space): boolean | undefined {
  const type = (space as unknown as { type?: string }).type;
  if (type === "group") return true;
  if (type === "dm") return false;
  if (space.id.includes(";+;")) return true; // local iMessage chat GUIDs
  if (space.id.includes(";-;")) return false;
  return undefined;
}
