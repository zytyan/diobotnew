import type {
  Chat,
  Message,
  MessageEntity,
  MessageOrigin,
  User,
} from "grammy/types";
import { messageContent } from "./message_content.ts";
export interface ContactTarget {
  source: string;
  user_id?: number;
  username?: string;
  display_name?: string;
  is_bot?: boolean;
  phone_number?: string;
  email?: string;
  url?: string;
  vcard?: string;
}
export interface ReplyEvidence {
  kind: "same_chat" | "external" | "quote" | "story";
  attribution: "reference_only";
  source: Record<string, unknown>;
  content_status: "included" | "partial" | "not_provided";
  text?: string;
  quote_text?: string;
  quote_is_manual?: boolean;
  contacts: ContactTarget[];
  links: string[];
  via_bot?: ContactTarget;
}
export interface MessageEvidence {
  contacts: ContactTarget[];
  replies: ReplyEvidence[];
  via_bot?: ContactTarget;
  forwarded_from?: Record<string, unknown>;
}
const person = (user: User, source: string): ContactTarget => ({
  source,
  user_id: user.id,
  display_name: [user.first_name, user.last_name].filter(Boolean).join(" ")
    .slice(0, 256),
  ...(user.username ? { username: user.username.slice(0, 64) } : {}),
  is_bot: user.is_bot,
});
const chatInfo = (chat?: Chat) =>
  chat
    ? {
      id: chat.id,
      type: chat.type,
      ...("title" in chat && typeof chat.title === "string"
        ? { title: chat.title.slice(0, 256) }
        : {}),
      ...("username" in chat && chat.username
        ? { username: chat.username.slice(0, 64) }
        : {}),
    }
    : undefined;
function originInfo(
  origin?: MessageOrigin,
): Record<string, unknown> | undefined {
  if (!origin) return;
  if (origin.type === "user") {
    return {
      type: origin.type,
      sender: person(origin.sender_user, "origin"),
      date: origin.date,
    };
  }
  if (origin.type === "hidden_user") {
    return {
      type: origin.type,
      display_name: origin.sender_user_name.slice(0, 256),
      date: origin.date,
    };
  }
  if (origin.type === "channel") {
    return {
      type: origin.type,
      chat: chatInfo(origin.chat),
      message_id: origin.message_id,
      date: origin.date,
      author_signature: origin.author_signature?.slice(0, 256),
    };
  }
  return {
    type: origin.type,
    chat: chatInfo(origin.sender_chat),
    author_signature: origin.author_signature?.slice(0, 256),
    date: origin.date,
  };
}
function contacts(
  message: Message,
  links: string[] = [],
  bio?: string,
): ContactTarget[] {
  const result: ContactTarget[] = [];
  const add = (target: ContactTarget) => {
    if (result.length < 32) result.push(target);
  };
  const link = (raw: string, source: string) => {
    try {
      const url = new URL(
        /^(?:t\.me|telegram\.me)\//i.test(raw) ? "https://" + raw : raw,
      );
      if (url.protocol === "tg:" && url.hostname === "user") {
        const id = Number(url.searchParams.get("id"));
        if (Number.isSafeInteger(id) && id > 0) {
          add({ source, user_id: id, url: raw.slice(0, 512) });
        }
      } else if (url.protocol === "tg:" && url.hostname === "resolve") {
        const username = url.searchParams.get("domain");
        if (username && /^[a-zA-Z0-9_]{1,64}$/.test(username)) {
          add({ source, username, url: raw.slice(0, 512) });
        }
      } else if (
        ["t.me", "telegram.me", "www.t.me"].includes(url.hostname.toLowerCase())
      ) {
        const [username, rest] = url.pathname.slice(1).split("/");
        if (
          username && /^[a-zA-Z0-9_]{1,64}$/.test(username) &&
          ![
            "c",
            "joinchat",
            "share",
            "proxy",
            "socks",
            "addstickers",
            "addemoji",
            "iv",
          ].includes(username)
        ) {
          add({
            source: rest ? source + "_chat_link" : source,
            username,
            url: raw.slice(0, 512),
          });
        }
      }
    } catch { /* Untrusted links are never fetched. */ }
  };
  const scan = (
    text?: string,
    entities?: MessageEntity[],
    source = "message",
  ) => {
    for (const entity of entities ?? []) {
      const value = text?.slice(entity.offset, entity.offset + entity.length) ??
        "";
      if (entity.type === "text_mention") {
        add(person(entity.user, source + "_text_mention"));
      } else if (entity.type === "phone_number" && value) {
        add({ source, phone_number: value.slice(0, 64) });
      } else if (entity.type === "email" && value) {
        add({ source, email: value.slice(0, 256) });
      } else if (entity.type === "text_link") {
        link(entity.url, source + "_link");
      }
    }
    for (
      const match of (text ?? "").matchAll(
        /(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{1,64})/g,
      )
    ) add({ source: source + "_mention", username: match[1] });
    for (
      const match of (text ?? "").matchAll(
        /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\s<>]+|tg:\/\/(?:user|resolve)\?[^\s<>]+/gi,
      )
    ) link(match[0], source + "_link");
  };
  if (message.contact) {
    const card = message.contact;
    add({
      source: "contact_card",
      display_name: [card.first_name, card.last_name].filter(Boolean).join(" ")
        .slice(0, 256),
      phone_number: card.phone_number.slice(0, 64),
      ...(card.user_id
        ? { user_id: card.user_id, url: `tg://user?id=${card.user_id}` }
        : {}),
      ...(card.vcard ? { vcard: card.vcard.slice(0, 2048) } : {}),
    });
    scan(card.vcard, undefined, "vcard");
    for (
      const line of (card.vcard ?? "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
    ) {
      const match = /^(TEL|EMAIL|URL|IMPP)(?:;[^:]*)?:(.*)$/i.exec(line);
      if (!match) continue;
      if (match[1].toUpperCase() === "TEL") {
        add({ source: "vcard", phone_number: match[2].slice(0, 64) });
      } else if (match[1].toUpperCase() === "EMAIL") {
        add({ source: "vcard", email: match[2].slice(0, 256) });
      } else link(match[2], "vcard");
    }
  }
  scan(message.text, message.entities);
  scan(message.caption, message.caption_entities, "caption");
  scan(bio, undefined, "sender_bio");
  if (message.poll) {
    scan(message.poll.question, message.poll.question_entities, "poll");
    scan(message.poll.description, message.poll.description_entities, "poll");
    for (const option of message.poll.options) {
      if (
        !option.added_by_chat &&
        (!option.added_by_user || option.added_by_user.id === message.from?.id)
      ) scan(option.text, option.text_entities, "poll");
    }
  }
  if (message.checklist) {
    scan(
      message.checklist.title,
      message.checklist.title_entities,
      "checklist",
    );
    for (const task of message.checklist.tasks) {
      scan(task.text, task.text_entities, "checklist");
    }
  }
  for (const task of message.checklist_tasks_added?.tasks ?? []) {
    scan(task.text, task.text_entities, "checklist");
  }
  for (const url of links) link(url, "message_link");
  if (message.via_bot) add(person(message.via_bot, "via_bot"));
  const seen = new Set<string>();
  return result.filter((target) => {
    const key = JSON.stringify(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}
export function messageEvidence(
  message: Message,
  current = messageContent(message),
  bio?: string,
): MessageEvidence {
  const evidence: MessageEvidence = {
    contacts: contacts(message, current.links, bio),
    replies: [],
  };
  if (message.via_bot) evidence.via_bot = person(message.via_bot, "via_bot");
  if (message.forward_origin) {
    evidence.forwarded_from = originInfo(message.forward_origin);
  }
  const replied = message.reply_to_message;
  if (replied) {
    const body = messageContent(replied as Message);
    evidence.replies.push({
      kind: "same_chat",
      attribution: "reference_only",
      source: {
        chat: chatInfo(replied.sender_chat ?? replied.chat),
        message_id: replied.message_id,
        ...(replied.from && !replied.sender_chat
          ? { sender: person(replied.from, "reply_author") }
          : {}),
        ...(replied.forward_origin
          ? { origin: originInfo(replied.forward_origin) }
          : {}),
      },
      content_status: body.text ? "included" : "partial",
      text: body.text.slice(0, 3000),
      contacts: contacts(replied as Message, body.links),
      links: body.links.slice(0, 8),
      ...(replied.via_bot
        ? { via_bot: person(replied.via_bot, "reply_via_bot") }
        : {}),
    });
  }
  if (message.external_reply) {
    const external = message.external_reply;
    const sourceMessage = {
      ...external,
      chat: external.chat ?? message.chat,
      message_id: external.message_id ?? 0,
      date: external.origin.date,
    } as Message;
    const body = messageContent(sourceMessage);
    const extraLinks = external.link_preview_options?.url
      ? [external.link_preview_options.url.slice(0, 512)]
      : [];
    evidence.replies.push({
      kind: "external",
      attribution: "reference_only",
      source: {
        chat: chatInfo(external.chat),
        message_id: external.message_id,
        origin: originInfo(external.origin),
      },
      content_status: body.text ? "partial" : "not_provided",
      ...(body.text ? { text: body.text.slice(0, 3000) } : {}),
      contacts: contacts(sourceMessage, [...body.links, ...extraLinks]),
      links: [...body.links, ...extraLinks].slice(0, 8),
    });
  }
  if (message.quote) {
    if (!evidence.replies.length) {
      evidence.replies.push({
        kind: "quote",
        attribution: "reference_only",
        source: {},
        content_status: "partial",
        contacts: [],
        links: [],
      });
    }
    const reply = evidence.replies.at(-1)!;
    reply.quote_text = message.quote.text.slice(0, 1500);
    reply.quote_is_manual = !!message.quote.is_manual;
    const quote = {
      chat: message.chat,
      message_id: message.message_id,
      date: message.date,
      text: message.quote.text,
      entities: message.quote.entities,
    } as Message;
    reply.contacts = [...reply.contacts, ...contacts(quote)].slice(0, 16);
    if (reply.content_status === "not_provided") {
      reply.content_status = "partial";
    }
  }
  if (message.reply_to_story) {
    evidence.replies.push({
      kind: "story",
      attribution: "reference_only",
      source: {
        chat: chatInfo(message.reply_to_story.chat),
        story_id: message.reply_to_story.id,
      },
      content_status: "not_provided",
      contacts: [],
      links: [],
    });
  }
  return evidence;
}
