import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

export function groupSettings(config: Config, store: Store, chat: number) {
  return store.settings(chat, {
    verification: !!config.siteKey && !config.publicChats.has(chat),
    moderation: config.publicChats.has(chat) ? config.moderationMode : "off",
    welcome: true,
    kicked: true,
    leave: true,
    tree: true,
  });
}
