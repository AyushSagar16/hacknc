// Atlas's outgoing action model. Every rich action has a plain-text fallback, and a
// fallback is used whenever the platform skips the native form (Spectrum resolves
// undefined on UnsupportedError) or throws trying. One Spectrum send per item, so the
// outbox can map every action to the provider message(s) it produced.
import { poll, reply, reaction, richlink, text, type Message, type Space } from "spectrum-ts";
import { childLog } from "../log.ts";
import { sendContext } from "./sendContext.ts";
import { tapbackEmoji, type Tapback } from "./tapbacks.ts";

export type Action =
  | { type: "say"; text: string; replyTo?: string }
  | { type: "react"; targetId: string; tapback: Tapback; fallbackText?: string }
  | { type: "poll"; title: string; options: string[]; pollId?: number }
  | { type: "link"; url: string; fallbackText?: string };

export interface Rendered {
  renderedAs: "native" | "fallback" | "skipped";
  /** Provider ids of every message produced (a text poll produces one per option). */
  providerMessageIds: string[];
  /** What the chat actually shows, for the history log. */
  shownText: string;
}

const stub = (id: string): Message => ({ id, content: { type: "text", text: "" } }) as unknown as Message;

export async function render(space: Space, action: Action, clientGuid: string): Promise<Rendered> {
  const log = childLog({ component: "outbound", chat: space.id });
  const sendOne = async (content: Parameters<Space["send"]>[0], guid: string): Promise<string | undefined> => {
    const sent = await sendContext.run({ clientGuid: guid }, () => space.send(content));
    const first = Array.isArray(sent) ? sent[0] : sent;
    return (first as { id?: string } | undefined)?.id;
  };
  const tryNative = async (content: Parameters<Space["send"]>[0], guid: string): Promise<string | undefined> => {
    try {
      return await sendOne(content, guid);
    } catch (err) {
      log.warn({ err: (err as Error).message, action: action.type }, "native send failed; using text fallback");
      return undefined;
    }
  };
  const plain = async (body: string, guid: string): Promise<string> => {
    const id = await sendOne(text(body), guid);
    if (!id) throw new Error("platform accepted text but returned no message id");
    return id;
  };

  switch (action.type) {
    case "say": {
      if (action.replyTo) {
        const id = await tryNative(reply(action.text, stub(action.replyTo)), clientGuid);
        if (id) return { renderedAs: "native", providerMessageIds: [id], shownText: action.text };
      }
      const id = await plain(action.text, clientGuid);
      return { renderedAs: action.replyTo ? "fallback" : "native", providerMessageIds: [id], shownText: action.text };
    }
    case "react": {
      const id = await tryNative(reaction(tapbackEmoji(action.tapback), stub(action.targetId)), clientGuid);
      if (id) return { renderedAs: "native", providerMessageIds: [id], shownText: `(${action.tapback} tapback)` };
      if (!action.fallbackText) return { renderedAs: "skipped", providerMessageIds: [], shownText: "" };
      const fid = await plain(action.fallbackText, `${clientGuid}:fb`);
      return { renderedAs: "fallback", providerMessageIds: [fid], shownText: action.fallbackText };
    }
    case "poll": {
      // A poll needs two choices (Spectrum rejects fewer); the options were already listed as text.
      if (action.options.length < 2) return { renderedAs: "skipped", providerMessageIds: [], shownText: "" };
      const id = await tryNative(poll(action.title, action.options), clientGuid);
      const listed = action.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
      if (id) return { renderedAs: "native", providerMessageIds: [id], shownText: `${action.title}\n${listed}` };
      // Text poll: the question, then one bubble per option so each can be tapbacked.
      const ids = [await plain(`${action.title}\nreply with a number or tap 👍 on your pick`, `${clientGuid}:q`)];
      for (const [i, o] of action.options.entries()) ids.push(await plain(`${i + 1}. ${o}`, `${clientGuid}:o${i}`));
      return { renderedAs: "fallback", providerMessageIds: ids, shownText: `${action.title}\n${listed}` };
    }
    case "link": {
      const id = await tryNative(richlink(action.url), clientGuid);
      if (id) return { renderedAs: "native", providerMessageIds: [id], shownText: action.url };
      const body = action.fallbackText ? `${action.fallbackText}\n${action.url}` : action.url;
      const fid = await plain(body, `${clientGuid}:fb`);
      return { renderedAs: "fallback", providerMessageIds: [fid], shownText: body };
    }
  }
}
