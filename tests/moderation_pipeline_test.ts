import { createBot } from "../src/bot.ts";
import { Store } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import type { Message, Update, User } from "grammy/types";
function assert(v: unknown): asserts v {
  if (!v) throw new Error("assertion failed");
}
const user: User = { id: 42, is_bot: false, first_name: "Alice" };
const message: Message = {
  message_id: 1,
  date: 1,
  chat: { id: -1, type: "supergroup", title: "Test" },
  from: user,
  text: "Alice",
};
Deno.test("完整审核链：人/bot 管理员和关联频道在资料读取、记录和上传前排除，普通成员才上传", async () => {
  const config = loadConfig({
    BOT_TOKEN: "99:fake",
    TELEGRAM_ENV: "test",
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    MODERATION_MODE: "observe",
    PUBLIC_CHAT_IDS: "-1",
  });
  const store = new Store(":memory:");
  let role = "administrator",
    profileReads = 0,
    uploads = 0,
    lookupFails = false,
    promote = false;
  const request: typeof fetch = (_url, init) => {
    uploads++;
    const payload = JSON.parse(String(init?.body));
    assert(payload.state.sender.display_name === "Alice");
    assert(payload.state.sender.bio === "developer");
    return Promise.resolve(Response.json({
      success: true,
      result: {
        answers: {
          classification: {
            type: "choice",
            choice: "normal",
            confidence: .99,
            probabilities: {
              normal: .99,
              advertisement: .003,
              scam: .003,
              uncertain: .004,
            },
          },
        },
      },
    }));
  };
  const { bot } = createBot(config, store, { request });
  bot.api.config.use((_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    if (method === "getChatMember" && lookupFails) {
      throw new Error("lookup unavailable");
    }
    const result = method === "getMe"
      ? { id: 99, is_bot: true, first_name: "Bot", username: "bot" }
      : method === "getChatMember"
      ? { status: role, user }
      : method === "getChat"
      ? (Number(p.chat_id) > 0
        ? (profileReads++,
          promote && (role = "administrator"),
          { id: 42, type: "private", first_name: "Alice", bio: "developer" })
        : { id: -1, type: "supergroup", title: "Test", linked_chat_id: -100 })
      : method === "getUserProfilePhotos"
      ? { total_count: 0, photos: [] }
      : true;
    return Promise.resolve({ ok: true, result }) as ReturnType<
      typeof _prev<typeof method>
    >;
  });
  let n = 0;
  const send = (changes: Partial<Message> = {}) =>
    bot.handleUpdate({
      update_id: ++n,
      message: { ...message, message_id: n, ...changes } as NonNullable<
        Update["message"]
      >,
    });
  try {
    await bot.init();
    await send();
    await send({ from: { ...user, is_bot: true } });
    assert(
      profileReads === 0 && uploads === 0 && !store.recentReviews(-1).length,
    );
    role = "member";
    await send({
      sender_chat: { id: -100, type: "channel", title: "Channel" },
    });
    await send({ is_automatic_forward: true });
    await send({
      forward_origin: {
        type: "channel",
        chat: { id: -100, type: "channel", title: "Channel" },
        message_id: 1,
        date: 1,
      },
    });
    lookupFails = true;
    await send();
    lookupFails = false;
    assert(profileReads === 0 && uploads === 0);
    promote = true;
    await send();
    assert(uploads === 0 && !store.recentReviews(-1).length);
    promote = false;
    role = "member";
    await send();
    assert(Number(uploads) === 1 && store.recentReviews(-1).length === 1);
    await send({ from: { ...user, is_bot: true } });
    assert(Number(uploads) === 2);
    role = "administrator";
    await send();
    assert(!store.recentReviews(-1).length && Number(uploads) === 2);
  } finally {
    store.close();
  }
});
