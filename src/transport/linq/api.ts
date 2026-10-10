// Adapted from ethanyanghq/scout bridge/linq-api.ts @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: class-based client with per-request timeouts, retries with jittered backoff on
// 429/5xx/network errors (honoring Retry-After), idempotency keys on sends and polls, typed
// helpers for every endpoint Atlas uses (polls, webhook subscriptions), and an injectable fetch.

export const LINQ_API_URL = "https://api.linqapp.com/api/partner/v3";

export class LinqApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Linq ${path} returned ${status}: ${body.slice(0, 300)}`);
  }

  /** Linq's numeric error code, when the body carries one (e.g. 1007 rate limit, 2008 contact must text first). */
  get code(): number | undefined {
    try {
      const parsed = JSON.parse(this.body) as { error?: { code?: number }; code?: number };
      return parsed.error?.code ?? parsed.code;
    } catch {
      return undefined;
    }
  }
}

export interface LinqHandle {
  handle: string;
  is_me?: boolean;
  status?: string;
}

export type LinqPart =
  | { type: "text"; value: string }
  | { type: "link"; value: string }
  | { type: "media"; url: string; mime_type?: string };

export interface LinqPollOption {
  id: string;
  text: string;
  voters?: { handle: string }[];
}

export interface LinqPoll {
  message_id: string;
  options: LinqPollOption[];
  total_voters?: number;
}

export interface LinqApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class LinqApi {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LinqApiOptions) {
    this.baseUrl = options.baseUrl ?? LINQ_API_URL;
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T = unknown>(path: string, request: { method?: string; body?: object } = {}): Promise<T> {
    const method = request.method ?? (request.body ? "POST" : "GET");
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            ...(request.body ? { "Content-Type": "application/json" } : {}),
          },
          body: request.body ? JSON.stringify(request.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Network error or timeout. Sends carry idempotency keys, so a retry can't double-send.
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const body = await response.text().catch(() => "");
      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }
      throw new LinqApiError(path, response.status, body);
    }
  }

  async sendMessage(
    chatId: string,
    parts: LinqPart[],
    opts: { replyTo?: string; idempotencyKey?: string } = {},
  ): Promise<{ id: string }> {
    const result = await this.call<{ message?: { id: string }; id?: string }>(`/chats/${chatId}/messages`, {
      body: {
        message: {
          parts,
          ...(opts.replyTo ? { reply_to: { message_id: opts.replyTo, part_index: 0 } } : {}),
          ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
        },
      },
    });
    const id = result?.message?.id ?? result?.id;
    if (!id) throw new LinqApiError(`/chats/${chatId}/messages`, 200, "response had no message id");
    return { id };
  }

  async react(messageId: string, type: string, opts: { customEmoji?: string; remove?: boolean } = {}): Promise<void> {
    await this.call(`/messages/${messageId}/reactions`, {
      body: {
        operation: opts.remove ? "remove" : "add",
        type,
        ...(opts.customEmoji ? { custom_emoji: opts.customEmoji } : {}),
      },
    });
  }

  async setTyping(chatId: string, on: boolean): Promise<void> {
    await this.call(`/chats/${chatId}/typing`, { method: on ? "POST" : "DELETE" });
  }

  /** Linq polls have no title; the caller sends the question as its own text first. */
  async createPoll(chatId: string, options: string[], idempotencyKey?: string): Promise<{ messageId: string }> {
    const result = await this.call<{ message_id?: string; poll?: { message_id?: string }; message?: { id?: string } }>(
      `/chats/${chatId}/polls`,
      { body: { poll: { options: options.map((text) => ({ text })), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) } } },
    );
    const messageId = result?.message_id ?? result?.poll?.message_id ?? result?.message?.id;
    if (!messageId) throw new LinqApiError(`/chats/${chatId}/polls`, 202, "response had no message_id");
    return { messageId };
  }

  async getPoll(messageId: string): Promise<LinqPoll> {
    const result = await this.call<LinqPoll | { poll: LinqPoll }>(`/messages/${messageId}/poll`);
    return "poll" in result ? result.poll : result;
  }

  async getChat(chatId: string): Promise<{ id: string; is_group?: boolean; handles: LinqHandle[] }> {
    const result = await this.call<{ id: string; is_group?: boolean; handles?: LinqHandle[]; chat?: { id: string; is_group?: boolean; handles?: LinqHandle[] } }>(
      `/chats/${chatId}`,
    );
    const chat = result.chat ?? result;
    return { id: chat.id, is_group: chat.is_group, handles: chat.handles ?? [] };
  }

  async getMessage(messageId: string): Promise<{ id: string; chat_id: string; is_from_me: boolean; created_at: string; parts: LinqPart[] }> {
    return this.call(`/messages/${messageId}`);
  }

  async createChat(from: string, to: string[], text: string): Promise<{ id: string }> {
    const result = await this.call<{ chat?: { id: string }; id?: string }>(`/chats`, {
      body: { from, to, message: { parts: [{ type: "text", value: text }] } },
    });
    const id = result.chat?.id ?? result.id;
    if (!id) throw new LinqApiError("/chats", 200, "response had no chat id");
    return { id };
  }

  async listPhoneNumbers(): Promise<string[]> {
    const result = await this.call<{ phone_numbers?: { phone_number: string }[] }>(`/phone_numbers`);
    return (result.phone_numbers ?? []).map((p) => p.phone_number);
  }

  async listWebhookSubscriptions(): Promise<{ id: string; target_url: string }[]> {
    const result = await this.call<{ webhook_subscriptions?: { id: string; target_url: string }[]; data?: { id: string; target_url: string }[] }>(
      `/webhook-subscriptions`,
    );
    return result.webhook_subscriptions ?? result.data ?? [];
  }

  async createWebhookSubscription(targetUrl: string, events: string[]): Promise<{ id: string; secret?: string }> {
    const result = await this.call<{ id: string; secret?: string; signing_secret?: string }>(`/webhook-subscriptions`, {
      body: { target_url: targetUrl, subscribed_events: events },
    });
    return { id: result.id, secret: result.secret ?? result.signing_secret };
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    await this.call(`/webhook-subscriptions/${id}`, { method: "DELETE" });
  }
}

function backoffMs(attempt: number): number {
  const base = 400 * 2 ** attempt;
  return base + Math.floor(Math.random() * base * 0.3);
}
