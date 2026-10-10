// Data access for people, chats, membership and the per-chat message history.
import { db, one, q, type Queryable } from "../pool.ts";

export interface ChatRow {
  id: number;
  platform: string;
  provider_chat_id: string;
  is_group: boolean;
  quiet_mode: boolean;
  intro_sent_at: Date | null;
  timezone: string;
  created_at: Date;
}

export interface PersonRow {
  id: number;
  handle: string;
  display_name: string | null;
}

export interface MemberRow extends PersonRow {
  active: boolean;
  joined_at: Date;
}

export interface MessageRow {
  id: number;
  chat_id: number;
  person_id: number | null;
  provider_message_id: string;
  direction: "inbound" | "outbound";
  kind: string;
  text: string;
  reply_to_provider_id: string | null;
  meta: Record<string, unknown>;
  sent_at: Date;
  received_at: Date;
  turn_id: number | null;
  speakable: boolean;
  extracted_at: Date | null;
  sender_name?: string | null;
  sender_handle?: string | null;
}

export async function upsertChat(platform: string, providerChatId: string, isGroup: boolean | undefined, at: Date, on: Queryable = db()): Promise<ChatRow> {
  const row = await one<ChatRow>(
    `INSERT INTO chats (platform, provider_chat_id, is_group, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, provider_chat_id) DO UPDATE SET is_group = COALESCE($5, chats.is_group)
     RETURNING *`,
    [platform, providerChatId, isGroup ?? true, at, isGroup ?? null],
    on,
  );
  return row!;
}

export async function getChat(chatId: number, on: Queryable = db()): Promise<ChatRow | undefined> {
  return one<ChatRow>(`SELECT * FROM chats WHERE id = $1`, [chatId], on);
}

export async function findChat(platform: string, providerChatId: string): Promise<ChatRow | undefined> {
  return one<ChatRow>(`SELECT * FROM chats WHERE platform = $1 AND provider_chat_id = $2`, [platform, providerChatId]);
}

export async function setQuiet(chatId: number, quiet: boolean): Promise<void> {
  await q(`UPDATE chats SET quiet_mode = $2 WHERE id = $1`, [chatId, quiet]);
}

export async function markIntroSent(chatId: number, at: Date, on: Queryable = db()): Promise<boolean> {
  const row = await one(`UPDATE chats SET intro_sent_at = $2 WHERE id = $1 AND intro_sent_at IS NULL RETURNING id`, [chatId, at], on);
  return Boolean(row);
}

export async function upsertPerson(handle: string, at: Date, displayName?: string | null, on: Queryable = db()): Promise<PersonRow> {
  const row = await one<PersonRow>(
    `INSERT INTO people (handle, display_name, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (handle) DO UPDATE SET display_name = COALESCE(people.display_name, EXCLUDED.display_name)
     RETURNING id, handle, display_name`,
    [handle, displayName ?? null, at],
    on,
  );
  return row!;
}

export async function setDisplayName(personId: number, name: string, opts: { overwrite?: boolean } = {}): Promise<void> {
  await q(
    opts.overwrite
      ? `UPDATE people SET display_name = $2 WHERE id = $1`
      : `UPDATE people SET display_name = $2 WHERE id = $1 AND display_name IS NULL`,
    [personId, name],
  );
}

export async function getPerson(personId: number): Promise<PersonRow | undefined> {
  return one<PersonRow>(`SELECT id, handle, display_name FROM people WHERE id = $1`, [personId]);
}

export async function ensureMember(chatId: number, personId: number, at: Date, on: Queryable = db()): Promise<boolean> {
  const row = await one<{ inserted: boolean }>(
    `INSERT INTO chat_members (chat_id, person_id, active, joined_at) VALUES ($1, $2, true, $3)
     ON CONFLICT (chat_id, person_id) DO UPDATE SET active = true, left_at = NULL
     RETURNING (xmax = 0) AS inserted`,
    [chatId, personId, at],
    on,
  );
  return row?.inserted ?? false;
}

export async function deactivateMember(chatId: number, personId: number, at: Date, on: Queryable = db()): Promise<void> {
  await q(`UPDATE chat_members SET active = false, left_at = $3 WHERE chat_id = $1 AND person_id = $2`, [chatId, personId, at], on);
}

export async function activeMembers(chatId: number, on: Queryable = db()): Promise<MemberRow[]> {
  return q<MemberRow>(
    `SELECT p.id, p.handle, p.display_name, m.active, m.joined_at
     FROM chat_members m JOIN people p ON p.id = m.person_id
     WHERE m.chat_id = $1 AND m.active ORDER BY m.joined_at, p.id`,
    [chatId],
    on,
  );
}

export interface NewMessage {
  chatId: number;
  personId: number | null;
  providerMessageId: string;
  direction: "inbound" | "outbound";
  kind: string;
  text: string;
  replyToProviderId?: string | null;
  meta?: Record<string, unknown>;
  sentAt: Date;
  receivedAt: Date;
  speakable?: boolean;
  turnId?: number | null;
}

/** Inserts a message; resolves undefined if this provider id was already stored (a redelivery). */
export async function insertMessage(m: NewMessage, on: Queryable = db()): Promise<MessageRow | undefined> {
  return one<MessageRow>(
    `INSERT INTO messages (chat_id, person_id, provider_message_id, direction, kind, text, reply_to_provider_id, meta, sent_at, received_at, speakable, turn_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (chat_id, provider_message_id) DO NOTHING
     RETURNING *`,
    [
      m.chatId,
      m.personId,
      m.providerMessageId,
      m.direction,
      m.kind,
      m.text,
      m.replyToProviderId ?? null,
      JSON.stringify(m.meta ?? {}),
      m.sentAt,
      m.receivedAt,
      m.speakable ?? true,
      m.turnId ?? null,
    ],
    on,
  );
}

const WITH_SENDER = `SELECT msg.*, p.display_name AS sender_name, p.handle AS sender_handle FROM messages msg LEFT JOIN people p ON p.id = msg.person_id`;

export async function recentMessages(chatId: number, limit: number, on: Queryable = db()): Promise<MessageRow[]> {
  const rows = await q<MessageRow>(`${WITH_SENDER} WHERE msg.chat_id = $1 ORDER BY msg.sent_at DESC, msg.id DESC LIMIT $2`, [chatId, limit], on);
  return rows.reverse();
}

export async function messageByProviderId(chatId: number, providerId: string, on: Queryable = db()): Promise<MessageRow | undefined> {
  return one<MessageRow>(`${WITH_SENDER} WHERE msg.chat_id = $1 AND msg.provider_message_id = $2`, [chatId, providerId], on);
}

/** Atlas's outbound rows also index every provider id they produced (meta.providerIds). */
export async function atlasMessageByProviderId(chatId: number, providerId: string): Promise<MessageRow | undefined> {
  return one<MessageRow>(
    `${WITH_SENDER} WHERE msg.chat_id = $1 AND msg.direction = 'outbound'
       AND (msg.provider_message_id = $2 OR msg.meta->'providerIds' ? $2)
     ORDER BY msg.id DESC LIMIT 1`,
    [chatId, providerId],
  );
}

export async function claimUnclaimed(chatId: number, turnId: number, on: Queryable = db()): Promise<MessageRow[]> {
  await q(
    `UPDATE messages SET turn_id = $2 WHERE chat_id = $1 AND turn_id IS NULL AND direction = 'inbound'`,
    [chatId, turnId],
    on,
  );
  return q<MessageRow>(`${WITH_SENDER} WHERE msg.turn_id = $1 ORDER BY msg.sent_at, msg.id`, [turnId], on);
}

export async function releaseClaim(turnId: number, on: Queryable = db()): Promise<void> {
  await q(`UPDATE messages SET turn_id = NULL WHERE turn_id = $1 AND direction = 'inbound'`, [turnId], on);
}

export async function hasUnclaimed(chatId: number): Promise<boolean> {
  const row = await one(`SELECT 1 FROM messages WHERE chat_id = $1 AND turn_id IS NULL AND direction = 'inbound' LIMIT 1`, [chatId]);
  return Boolean(row);
}

export async function chatsWithUnclaimed(): Promise<number[]> {
  const rows = await q<{ chat_id: number }>(`SELECT DISTINCT chat_id FROM messages WHERE turn_id IS NULL AND direction = 'inbound'`);
  return rows.map((r) => r.chat_id);
}

export function labelOf(p: { display_name: string | null | undefined; handle: string | null | undefined }): string {
  if (p.display_name) return p.display_name;
  const digits = (p.handle ?? "").replace(/\D/g, "");
  return digits ? `…${digits.slice(-4)}` : "someone";
}
