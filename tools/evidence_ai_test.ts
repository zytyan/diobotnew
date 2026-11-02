/** Synthetic contacts and replies only; no Telegram messages or real contacts. */
import type { Message } from "grammy/types";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { moderate } from "../src/moderation.ts";
import { messageContent } from "../src/message_content.ts";
import { messageEvidence } from "../src/message_evidence.ts";
const runtime = JSON.parse(
  await Deno.readTextFile(
    new URL("../data/deploy/cf-runtime.json", import.meta.url),
  ),
);
const config = loadConfig({
  BOT_TOKEN: "0:synthetic-test",
  TELEGRAM_ENV: "test",
  CF_ACCOUNT_ID: runtime.account_id,
  CF_API_TOKEN: runtime.token,
  CF_MODEL: "@cf/cloudflare/clef-flash",
  AI_DAILY_LIMIT: "10",
});
const store = new Store(":memory:");
const base = {
  message_id: 1,
  date: 1,
  chat: { id: -1, type: "supergroup", title: "Synthetic" },
  from: { id: 42, is_bot: false, first_name: "陈伟" },
} as const;
const card = {
  ...base,
  contact: {
    first_name: "联系人",
    phone_number: "+12025550123",
    user_id: 999999999999,
  },
} as Message;
const samples = [
  { name: "普通成员发送名片", expected: "advertisement", message: card },
  {
    name: "来发财跨频道联系人入口",
    expected: "advertisement",
    message: {
      ...base,
      text: "来发财",
      external_reply: {
        origin: {
          type: "channel",
          date: 1,
          chat: { id: -2, type: "channel", title: "发财交流" },
          message_id: 9,
        },
        contact: card.contact,
      },
      via_bot: {
        id: 999999999998,
        is_bot: true,
        first_name: "发财助手",
        username: "example_profit_bot",
      },
    } as Message,
  },
  {
    name: "举报所引用的广告名片",
    expected: "normal",
    message: {
      ...base,
      text: "举报这条‘来发财’广告，不要联系他，请管理员处理。",
      reply_to_message: card,
    } as Message,
  },
];
let failures = 0;
try {
  for (const [index, sample] of samples.entries()) {
    const content = messageContent(sample.message);
    const start = performance.now();
    const verdict = await moderate(
      config,
      store,
      -1,
      index + 1,
      content.text,
      fetch,
      {
        messageKind: content.kind,
        links: content.links,
        evidence: messageEvidence(sample.message, content),
      },
    );
    console.log(
      JSON.stringify({
        sample: sample.name,
        label: verdict?.label,
        score: verdict?.score,
        elapsed_ms: Math.round(performance.now() - start),
      }),
    );
    if (
      verdict?.label !== sample.expected ||
      (sample.expected === "advertisement" &&
        (verdict?.score ?? 0) < config.aiThreshold)
    ) failures++;
  }
} finally {
  store.close();
}
if (failures) {
  throw new Error(`${failures} synthetic classifications below expectation`);
}
