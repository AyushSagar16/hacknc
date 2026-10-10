// Carries the outbox row's stable client GUID from outbound.ts down into a platform's
// send() without changing Spectrum's content model. Platforms that support idempotency
// keys (Linq) read it; others ignore it.
import { AsyncLocalStorage } from "node:async_hooks";

export interface SendContext {
  clientGuid: string;
}

export const sendContext = new AsyncLocalStorage<SendContext>();

export function currentClientGuid(): string | undefined {
  return sendContext.getStore()?.clientGuid;
}
