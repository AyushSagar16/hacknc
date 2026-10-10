// Adapted from ethanyanghq/scout bridge/devchat/platform.ts @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: many chats in one world; native polls and votes; membership events (Atlas joins,
// friends join/leave); switchable capabilities so the same scenario can run as a Linq-like line
// or as a local-iMessage-like line (poll/react/reply throw UnsupportedError → text fallbacks);
// completion is "the pipeline is idle for this chat" instead of a relay outcome; timestamps come
// from the movable app clock so scenarios can jump days ahead.

import { UnsupportedError, definePlatform, type Content, type Message } from "spectrum-ts";
import { asPoll, asPollOption, asReaction, type ProviderMessageRecord } from "spectrum-ts/authoring";
import { z } from "zod";
import { now } from "../../clock.ts";
import { inboundExtrasSchema, safeExtras, type InboundExtras } from "../extras.ts";
import { EventQueue } from "../queue.ts";
import { tapbackEmoji, tapbackNamed, type Tapback } from "../tapbacks.ts";

export const SIM_PLATFORM = "sim";

export interface SimCapabilities {
  polls: boolean;
  reactions: boolean;
  replies: boolean;
}

export const LINQ_LIKE: SimCapabilities = { polls: true, reactions: true, replies: true };
export const LOCAL_LIKE: SimCapabilities = { polls: false, reactions: false, replies: false };

export type SimMember = { name: string; handle: string };

export type SimEntry = {
  id: string;
  from: string; // a member's name, or "atlas"
  text: string;
  kind: "text" | "reaction" | "poll" | "link" | "system";
  replyTo?: string;
  on?: string;
  poll?: { title: string; options: string[] };
};

/** Resolves once the pipeline has finished everything it will do for a chat right now. */
export type WaitIdle = (chatId: string) => Promise<void>;

export class SimChat {
  readonly transcript: SimEntry[] = [];
  readonly members: SimMember[];
  private atlasPresent = false;

  constructor(
    readonly world: SimWorld,
    readonly id: string,
    members: SimMember[],
    public capabilities: SimCapabilities = LINQ_LIKE,
  ) {
    this.members = [...members];
  }

  get hasAtlas(): boolean {
    return this.atlasPresent;
  }

  /** A friend adds Atlas's number to the group. */
  async addAtlas(byName?: string): Promise<SimEntry[]> {
    this.atlasPresent = true;
    const by = byName ? this.member(byName) : this.members[0];
    const sys = this.add({ from: by?.name ?? "someone", text: `${by?.name ?? "someone"} added atlas to the group`, kind: "system" });
    return this.deliver(sys, { type: "addMember", members: this.members.map((m) => m.handle) } as Content, undefined, { memberEvent: "joined", isGroup: true });
  }

  async addMember(name: string, handle: string): Promise<SimEntry[]> {
    const member = { name: name.toLowerCase(), handle };
    this.members.push(member);
    const sys = this.add({ from: "system", text: `${member.name} joined`, kind: "system" });
    return this.deliver(sys, { type: "addMember", members: [handle] } as Content, undefined, { memberEvent: "added", isGroup: true });
  }

  async removeMember(name: string): Promise<SimEntry[]> {
    const member = this.member(name);
    this.members.splice(this.members.indexOf(member), 1);
    const sys = this.add({ from: "system", text: `${member.name} left`, kind: "system" });
    return this.deliver(sys, { type: "removeMember", members: [member.handle] } as Content, undefined, { memberEvent: "removed", isGroup: true });
  }

  say(name: string, text: string, opts: { wait?: boolean } = {}): Promise<SimEntry[]> {
    const m = this.member(name);
    const entry = this.add({ from: m.name, text, kind: "text" });
    return this.deliver(entry, { type: "text", text }, m, { isGroup: true }, opts.wait);
  }

  reply(name: string, target: string, text: string): Promise<SimEntry[]> {
    const m = this.member(name);
    const under = this.find(target);
    const entry = this.add({ from: m.name, text, kind: "text", replyTo: under.id });
    return this.deliver(entry, { type: "text", text }, m, { replyTo: { messageId: under.id }, isGroup: true });
  }

  react(name: string, target: string, tapback: Tapback, opts: { remove?: boolean } = {}): Promise<SimEntry[]> {
    const m = this.member(name);
    const on = this.find(target);
    const emoji = tapbackEmoji(tapback);
    const entry = this.add({ from: m.name, text: `${opts.remove ? "removed " : ""}${emoji} on ${on.id}`, kind: "reaction", on: on.id });
    const content = asReaction({ emoji, target: stub(on) });
    return this.deliver(entry, content, m, { reactionRemoved: opts.remove || undefined, isGroup: true });
  }

  /** Vote in Atlas's latest native poll by option number (1-based) or title words. */
  vote(name: string, choice: string, opts: { remove?: boolean } = {}): Promise<SimEntry[]> {
    const m = this.member(name);
    const pollEntry = this.transcript.findLast((e) => e.kind === "poll" && e.from === "atlas");
    if (!pollEntry?.poll) throw new Error("atlas hasn't sent a native poll in this chat");
    const options = pollEntry.poll.options;
    const idx = /^\d+$/.test(choice) ? Number(choice) - 1 : options.findIndex((o) => o.toLowerCase().includes(choice.toLowerCase()));
    const title = options[idx];
    if (title === undefined) throw new Error(`no option "${choice}" in: ${options.join(" / ")}`);
    const entry = this.add({ from: m.name, text: `${opts.remove ? "unvoted" : "voted"} "${title}"`, kind: "reaction", on: pollEntry.id });
    const poll = asPoll({ title: pollEntry.poll.title, options: options.map((o) => ({ title: o })) });
    const content = asPollOption({ option: { title }, poll, selected: !opts.remove });
    return this.deliver(entry, content, m, { pollMessageId: pollEntry.id, optionId: String(idx), isGroup: true });
  }

  /** Atlas's messages since (and excluding) the given entry. */
  atlasSince(entry: SimEntry | undefined): SimEntry[] {
    const start = entry ? this.transcript.indexOf(entry) + 1 : 0;
    return this.transcript.slice(start).filter((e) => e.from === "atlas");
  }

  lastEntry(): SimEntry | undefined {
    return this.transcript.at(-1);
  }

  member(name: string): SimMember {
    const m = this.members.find((x) => x.name === name.toLowerCase());
    if (!m) throw new Error(`${name} isn't in ${this.id}. Members: ${this.members.map((x) => x.name).join(", ")}`);
    return m;
  }

  find(target: string): SimEntry {
    if (/^m\d+$/.test(target)) {
      const e = this.transcript.find((x) => x.id === target);
      if (!e) throw new Error(`no message ${target}`);
      return e;
    }
    const atlas = this.transcript.filter((e) => e.from === "atlas" && e.kind !== "reaction");
    const e = target === "atlas.last" ? atlas.at(-1) : atlas.findLast((x) => x.text.toLowerCase().includes(target.toLowerCase()));
    if (!e) throw new Error(`atlas hasn't sent anything matching "${target}"`);
    return e;
  }

  // Called by the platform.

  recordAtlas(content: Content): ProviderMessageRecord {
    const shown = describe(content);
    const entry = this.add({ from: "atlas", ...shown });
    return { id: entry.id, content, space: { id: this.id }, timestamp: now() };
  }

  recorded(id: string): ProviderMessageRecord | undefined {
    const e = this.transcript.find((x) => x.id === id);
    if (!e) return undefined;
    return { id: e.id, content: { type: "text", text: e.text }, direction: e.from === "atlas" ? "outbound" : "inbound", space: { id: this.id }, timestamp: now() };
  }

  private add(fields: Omit<SimEntry, "id">): SimEntry {
    const entry = { id: this.world.nextId(), ...fields };
    this.transcript.push(entry);
    return entry;
  }

  private async deliver(
    entry: SimEntry,
    content: Content,
    sender: SimMember | undefined,
    extras: InboundExtras,
    wait = true,
  ): Promise<SimEntry[]> {
    this.world.expect(this.id);
    this.world.queue.push({
      id: entry.id,
      content,
      direction: "inbound",
      ...(sender ? { sender: { id: sender.handle } } : {}),
      space: { id: this.id },
      timestamp: now(),
      ...safeExtras({ ...extras, receivedAt: now(), eventId: entry.id }),
    });
    if (!wait) return [];
    await this.world.waitIdle(this.id);
    return this.atlasSince(entry);
  }
}

export class SimWorld {
  readonly queue = new EventQueue<ProviderMessageRecord>();
  readonly chats = new Map<string, SimChat>();
  private counter = 0;
  waitIdle: WaitIdle = async () => {};
  /** Lets the pipeline know an event is coming, so waitIdle can't resolve before it's ingested. */
  expect: (chatId: string) => void = () => {};

  nextId(): string {
    this.counter += 1;
    return `m${this.counter}`;
  }

  chat(id: string, members: SimMember[], capabilities: SimCapabilities = LINQ_LIKE): SimChat {
    const existing = this.chats.get(id);
    if (existing) return existing;
    const chat = new SimChat(this, id, members, capabilities);
    this.chats.set(id, chat);
    return chat;
  }

  /** Display name for a sim handle ("+15550100001" → "Maya"), so the roster is known like a demo roster. */
  nameOf(handle: string): string | undefined {
    for (const chat of this.chats.values()) {
      const m = chat.members.find((x) => x.handle === handle);
      if (m) return m.name.charAt(0).toUpperCase() + m.name.slice(1);
    }
    return undefined;
  }

  get(id: string): SimChat {
    const chat = this.chats.get(id);
    if (!chat) throw new Error(`no sim chat ${id}`);
    return chat;
  }
}

/** Fake phones (+1555…) per name, stable across runs. */
export function simMembers(names: string[]): SimMember[] {
  return names.map((name, i) => ({ name: name.toLowerCase(), handle: `+1555010${String(i + 1).padStart(4, "0")}` }));
}

export function simPlatform(world: SimWorld) {
  async function* messages(): AsyncGenerator<ProviderMessageRecord> {
    for await (const record of world.queue) yield record;
  }

  return definePlatform(SIM_PLATFORM, {
    config: z.object({}),
    message: { schema: inboundExtrasSchema },
    user: { resolve: async ({ input }) => ({ id: input.userID }) },
    space: {
      create: async (): Promise<{ id: string }> => {
        throw UnsupportedError.action("space.create", SIM_PLATFORM, "add atlas to a sim chat instead");
      },
    },
    lifecycle: { createClient: async () => world },
    messages: messages as never,
    actions: {
      getMembers: async (_ctx, space) => world.get(space.id).members.map((m) => ({ id: m.handle })),
      getMessage: async (_ctx, space, id) => world.get(space.id).recorded(id),
    },
    send: async ({ space, content }) => {
      const chat = world.get(space.id);
      const caps = chat.capabilities;
      if (content.type === "typing") return undefined;
      if (content.type === "poll" && !caps.polls) throw UnsupportedError.content("poll", SIM_PLATFORM, "this sim line has no native polls");
      if (content.type === "reaction" && !caps.reactions) throw UnsupportedError.content("reaction", SIM_PLATFORM, "this sim line has no tapbacks");
      if (content.type === "reply" && !caps.replies) throw UnsupportedError.content("reply", SIM_PLATFORM, "this sim line has no threaded replies");
      if (!["text", "reply", "reaction", "poll", "richlink"].includes(content.type)) throw UnsupportedError.content(content.type, SIM_PLATFORM);
      return chat.recordAtlas(content);
    },
  });
}

function describe(content: Content): Omit<SimEntry, "id" | "from"> {
  switch (content.type) {
    case "text":
      return { text: content.text, kind: "text" };
    case "reply":
      return { ...describe(content.content), replyTo: content.target.id };
    case "reaction":
      return { text: `${tapbackNamed(content.emoji) ?? content.emoji} on ${content.target.id}`, kind: "reaction", on: content.target.id };
    case "poll":
      return { text: `📊 ${content.title}\n${content.options.map((o, i) => `  ${i + 1}. ${o.title}`).join("\n")}`, kind: "poll", poll: { title: content.title, options: content.options.map((o) => o.title) } };
    case "richlink":
      return { text: content.url, kind: "link" };
    default:
      return { text: `[${content.type}]`, kind: "text" };
  }
}

const stub = (e: SimEntry): Message => ({ id: e.id, content: { type: "text", text: e.text } }) as unknown as Message;
