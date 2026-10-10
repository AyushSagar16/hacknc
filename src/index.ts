import { Spectrum } from "spectrum-ts";
import { localIMessage } from "@spectrum-ts/imessage-local";
// Spectrum bridges a single agent loop to many messaging interfaces.
// Each provider in `providers` adds an interface (terminal TUI, iMessage, …).
// Docs: https://photon.codes/docs/spectrum-ts
//
// Local iMessage runs on this Mac and sends as the Apple account signed in to
// Messages. Group chats need it: the cloud provider's shared lines (Free/Pro)
// don't support groups.
const app = await Spectrum({
  providers: [localIMessage.config()],
});

// The bot sees every message sent to this Apple account, so it only answers
// group messages that start with the trigger, optionally limited to listed chats.
const TRIGGER = (process.env.BOT_TRIGGER ?? "@bot").toLowerCase();
const ALLOWED_CHATS = new Set(
  (process.env.ALLOWED_CHATS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
);

console.log(`Listening for group messages starting with "${TRIGGER}"`);

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
for await (const [space, message] of app.messages) {
  if (message.platform !== "local_imessage" || message.content.type !== "text") continue;
  if (localIMessage(space).type !== "group") continue;

  const text = message.content.text.trim();
  if (!text.toLowerCase().startsWith(TRIGGER)) continue;

  if (ALLOWED_CHATS.size > 0 && !ALLOWED_CHATS.has(space.id)) {
    console.log(`Ignoring trigger in chat not in ALLOWED_CHATS: ${space.id}`);
    continue;
  }

  console.log(`[${space.id}] ${message.sender?.id ?? "unknown"}: ${text}`);
  const prompt = text.slice(TRIGGER.length).trim();
  await space.send(`echo: ${prompt || "(say something after the trigger)"}`);
}
