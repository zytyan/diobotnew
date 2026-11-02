import type { Message } from "grammy/types";
import { messageContent } from "../src/message_content.ts";
import { messageEvidence } from "../src/message_evidence.ts";
import { buildModerationRequest, moderate } from "../src/moderation.ts";
import { Store } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const base = {
  message_id: 1,
  date: 1,
  chat: { id: -1, type: "supergroup", title: "Group" },
  from: { id: 42, is_bot: false, first_name: "Sender" },
} as const;
Deno.test("同群回复与跨频道回复来源独立传递，不把原广告混入当前作者正文", () => {
  const message = {
    ...base,
    text: "来发财",
    external_reply: {
      origin: {
        type: "channel",
        date: 1,
        chat: {
          id: -2,
          type: "channel",
          title: "Ad",
          username: "example_channel",
        },
        message_id: 9,
      },
      chat: {
        id: -2,
        type: "channel",
        title: "Ad",
        username: "example_channel",
      },
      message_id: 9,
    },
    quote: { text: "联系 @example_bot", position: 0 },
  } as Message;
  const content = messageContent(message),
    evidence = messageEvidence(message, content);
  assert(content.text === "来发财");
  assert(
    evidence.replies[0].kind === "external" &&
      evidence.replies[0].attribution === "reference_only",
  );
  assert(
    evidence.replies[0].quote_text === "联系 @example_bot" &&
      evidence.replies[0].contacts[0].username === "example_bot",
  );
  assert(evidence.replies[0].content_status === "partial");
  const outbound = buildModerationRequest(
    content.text,
    "@cf/cloudflare/clef-flash",
    { messageKind: content.kind, evidence },
  );
  assert(
    "state" in outbound &&
      outbound.state.evidence?.replies[0].quote_text === message.quote!.text,
  );

  const noQuote = messageEvidence({ ...message, quote: undefined });
  assert(
    noQuote.replies[0].content_status === "not_provided" &&
      !noQuote.replies[0].text,
  );
  const same = {
    ...base,
    text: "举报这条广告",
    reply_to_message: {
      ...base,
      message_id: 2,
      text: "来发财，联系 @example_bot",
    },
  } as Message;
  assert(messageContent(same).text === "举报这条广告");
  assert(messageEvidence(same).replies[0].text!.includes("来发财"));
});
Deno.test("名片、无用户名用户提及、bio联系人和via_bot均成为可联系目标", () => {
  const message = {
    ...base,
    contact: {
      first_name: "客服",
      phone_number: "+000000000",
      user_id: 123,
      vcard:
        "BEGIN:VCARD\nTEL:+000000000\nEMAIL:contact@example.invalid\nURL:https://t.me/example_bot\nEND:VCARD",
    },
    via_bot: {
      id: 88,
      is_bot: true,
      first_name: "Entry",
      username: "entry_bot",
    },
  } as Message;
  const content = messageContent(message),
    evidence = messageEvidence(message, content, "私聊 @bio_target");
  assert(
    content.text.includes("联系人名片") &&
      content.text.includes("tg://user?id=123"),
  );
  assert(
    evidence.contacts.some((target) =>
      target.source === "contact_card" && target.user_id === 123 &&
      target.phone_number === "+000000000"
    ),
  );
  assert(
    evidence.contacts.some((target) =>
      target.email === "contact@example.invalid"
    ),
  );
  assert(evidence.contacts.some((target) => target.username === "example_bot"));
  assert(
    evidence.contacts.some((target) =>
      target.source === "sender_bio_mention" && target.username === "bio_target"
    ),
  );
  assert(evidence.via_bot?.is_bot === true && evidence.via_bot.user_id === 88);
  const mention = {
    ...base,
    text: "联系他",
    entities: [{
      type: "text_mention",
      offset: 2,
      length: 1,
      user: { id: 456, is_bot: false, first_name: "Target" },
    }],
  } as Message;
  assert(
    messageEvidence(mention).contacts.some((target) => target.user_id === 456),
  );
});
Deno.test("Cloudflare与文本模型都收到结构化回复和联系人；上下文改变使缓存失效", async () => {
  const message = {
    ...base,
    text: "来发财",
    external_reply: {
      origin: {
        type: "channel",
        date: 1,
        chat: { id: -2, type: "channel", title: "Ad" },
        message_id: 9,
      },
      contact: {
        first_name: "Target",
        phone_number: "+000000000",
        user_id: 123,
      },
    },
  } as Message;
  const context = { messageKind: "text", evidence: messageEvidence(message) };
  const clef = buildModerationRequest(
    "来发财",
    "@cf/cloudflare/clef-flash",
    context,
  );
  assert(
    "state" in clef &&
      clef.state.evidence!.replies[0].contacts[0].user_id === 123,
  );
  const text = buildModerationRequest("来发财", "text-model", context);
  assert(
    "messages" in text && text.messages[1].content.includes('"user_id":123'),
  );
  const store = new Store(":memory:");
  const config = loadConfig({
    BOT_TOKEN: "99:fake",
    TELEGRAM_ENV: "test",
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
  });
  let calls = 0;
  const request: typeof fetch = (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert(payload.state.evidence.replies.length === 1);
    return Promise.resolve(
      Response.json({
        success: true,
        result: {
          response: {
            label: "advertisement",
            certainty: "high",
            reason: "引流",
          },
        },
      }),
    );
  };
  try {
    await moderate(config, store, -1, 1, "来发财", request, context);
    await moderate(config, store, -1, 1, "来发财", request, context);
    assert(calls === 1);
    context.evidence.replies[0].source.message_id = 10;
    await moderate(config, store, -1, 1, "来发财", request, context);
    assert(Number(calls) === 2);
  } finally {
    store.close();
  }
});
