import type { Message, MessageEntity } from "grammy/types";
export function messageContent(
  message: Message,
): { text: string; links: string[]; kind?: string } {
  const parts: string[] = [];
  const links: string[] = [];
  const add = (text?: string, entities?: MessageEntity[]) => {
    if (text) parts.push(text);
    for (const entity of entities ?? []) {
      if (entity.type === "text_link") links.push(entity.url);
    }
  };
  let kind: string | undefined;
  for (
    const key of [
      "text",
      "photo",
      "video",
      "animation",
      "sticker",
      "document",
      "voice",
      "audio",
      "video_note",
      "poll",
      "checklist",
      "checklist_tasks_added",
      "poll_option_added",
      "contact",
      "venue",
      "location",
      "game",
      "invoice",
      "paid_media",
      "rich_message",
    ] as const
  ) {
    if (message[key] !== undefined) {
      kind = key;
      break;
    }
  }
  add(message.text, message.entities);
  add(message.caption, message.caption_entities);
  if (message.poll) {
    add(message.poll.question, message.poll.question_entities);
    add(message.poll.description, message.poll.description_entities);
    add(message.poll.explanation, message.poll.explanation_entities);
    for (const option of message.poll.options) {
      if (
        option.added_by_chat ||
        (option.added_by_user && option.added_by_user.id !== message.from?.id)
      ) continue;
      add(option.text, option.text_entities);
      if (option.media?.link?.url) links.push(option.media.link.url);
    }
  }
  if (message.poll_option_added) {
    add(
      message.poll_option_added.option_text,
      message.poll_option_added.option_text_entities,
    );
  }
  if (message.checklist) {
    add(message.checklist.title, message.checklist.title_entities);
    for (const task of message.checklist.tasks) {
      add(task.text, task.text_entities);
    }
  }
  for (const task of message.checklist_tasks_added?.tasks ?? []) {
    add(task.text, task.text_entities);
  }
  add(message.document?.file_name);
  add(message.audio?.title);
  add(message.audio?.performer);
  add(message.audio?.file_name);
  add(message.video?.file_name);
  add(message.animation?.file_name);
  add(message.sticker?.emoji);
  add(message.sticker?.set_name);
  if (message.contact) {
    add(
      "【Telegram联系人名片：可联系的对象，本群普通成员发送名片属于强引流信号】",
    );
    if (message.contact.user_id) {
      add(
        `联系人用户ID：${message.contact.user_id}；联系入口：tg://user?id=${message.contact.user_id}`,
      );
    }
    add(
      [
        message.contact.first_name,
        message.contact.last_name,
        message.contact.phone_number,
      ].filter(Boolean).join(" "),
    );
  }
  if (message.venue) {
    add(message.venue.title);
    add(message.venue.address);
  }
  if (message.game) {
    add(message.game.title);
    add(message.game.description);
    add(message.game.text, message.game.text_entities);
  }
  if (message.invoice) {
    add(message.invoice.title);
    add(message.invoice.description);
  }
  for (const row of message.reply_markup?.inline_keyboard ?? []) {
    for (const button of row) {
      add(button.text);
      if ("url" in button) {
        links.push(button.url);
      }
    }
  }
  // Only visible rich-message content, never reply/forward metadata or callback data.
  const rich = (value: unknown, depth = 0) => {
    if (!value || depth > 16) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) rich(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        ["text", "title", "caption", "markdown", "html"].includes(key) &&
        typeof item === "string"
      ) add(item);
      else if (["url", "href"].includes(key) && typeof item === "string") {
        links.push(item);
      } else if (
        ["blocks", "items", "rows", "cells", "children", "buttons", "entities"]
          .includes(key)
      ) rich(item, depth + 1);
    }
  };
  rich(message.rich_message);
  const uniqueLinks = [...new Set(links)].slice(0, 32).map((v) =>
    v.slice(0, 512)
  );
  // Include hidden destinations for local message rules as well as AI.
  return {
    text: [...parts, ...uniqueLinks].join("\n").slice(0, 32768),
    links: uniqueLinks,
    kind,
  };
}
