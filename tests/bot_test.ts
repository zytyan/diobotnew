import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const user = {
  id: 99,
  is_bot: true as const,
  first_name: "Test",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
};
function setup(publicChat = false) {
  const config = loadConfig({
    BOT_TOKEN: "99:fake",
    TELEGRAM_ENV: "test",
    TURNSTILE_SITE_KEY: "key",
    TURNSTILE_SECRET: "secret",
    VERIFY_HOSTNAME: "test.example",
    PUBLIC_CHAT_IDS: publicChat ? "-1" : "",
  });
  const store = new Store(":memory:");
  const app = createBot(config, store);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  app.bot.api.config.use((_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve({
      ok: true as const,
      result: method === "getMe"
        ? user
        : method === "sendMessage"
        ? { message_id: 123 }
        : true,
    }) as ReturnType<typeof _previous<typeof method>>;
  });
  return { ...app, store, calls };
}
Deno.test("真实 handler：公开群入群申请直接批准、不创建验证状态，并记录群", async () => {
  const { bot, store, calls } = setup(true);
  try {
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      chat_join_request: {
        chat: { id: -1, type: "supergroup", title: "公开群" },
        from: { id: 42, is_bot: false, first_name: "User" },
        user_chat_id: 42,
        date: 1,
      },
    });
    assert(calls.some((c) => c.method === "approveChatJoinRequest"));
    assert(!calls.some((c) => c.method === "restrictChatMember"));
    assert(store.active().length === 0);
    assert(store.chats().length === 1);
  } finally {
    store.close();
  }
});
Deno.test("真实 handler：普通申请发私信，验证成功由后台审批；过期请求拒绝", async () => {
  const { bot, sweep, store, calls } = setup();
  try {
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      chat_join_request: {
        chat: { id: -1, type: "supergroup", title: "验证群" },
        from: { id: 42, is_bot: false, first_name: "User" },
        user_chat_id: 1234,
        date: 1,
      },
    });
    const row = store.active()[0];
    assert(row.user_id === 42);
    assert(
      calls.some((c) =>
        c.method === "sendMessage" && c.payload.chat_id === 1234 &&
        String(c.payload.text).includes(row.id)
      ),
    );
    assert(!calls.some((c) => c.method === "approveChatJoinRequest"));
    store.resolve(row.id, 42, true);
    await sweep();
    assert(calls.some((c) => c.method === "approveChatJoinRequest"));
    assert(store.get(row.id)?.state === "done");
    assert(!calls.some((c) => c.method === "deleteMessage"));
    const expired = store.create(-2, 43, "request", {}, Date.now() - 400_000);
    await sweep();
    assert(
      calls.some((c) =>
        c.method === "declineChatJoinRequest" && c.payload.user_id === 43
      ),
    );
    assert(store.get(expired.id)?.state === "rejected");
  } finally {
    store.close();
  }
});
Deno.test("后台恢复群权限后直接完成，不再创建发言检查", async () => {
  const { bot, sweep, store, calls } = setup();
  try {
    await bot.init();
    const row = store.create(-1, 42, "direct", {
      can_send_messages: true,
      can_send_photos: false,
    });
    store.resolve(row.id, 42, true);
    await sweep();
    const restrict = calls.find((c) => c.method === "restrictChatMember");
    assert(restrict);
    assert(
      (restrict.payload.permissions as Record<string, boolean>)
        .can_send_photos === false,
    );
    assert(store.get(row.id)?.state === "done");
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 22,
        date: 1,
        chat: { id: -1, type: "supergroup", title: "验证群" },
        from: { id: 42, is_bot: false, first_name: "User" },
        text: "大家好",
      },
    });
    assert(store.get(row.id)?.state === "done");
    await sweep();
    assert(!calls.some((c) => c.method === "banChatMember"));
  } finally {
    store.close();
  }
});

Deno.test("群内后台任务和更新按序执行，不阻塞其他群且错误后释放队列", async () => {
  const { ChatQueue } = await import("../src/queue.ts");
  const queue = new ChatQueue();
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(-1, async () => {
    events.push("first");
    await barrier;
    events.push("finished");
  });
  const second = queue.run(-1, () => {
    events.push("second");
    return Promise.resolve();
  });
  await queue.run(-2, () => {
    events.push("other");
    return Promise.resolve();
  });
  assert(events.join(",") === "first,other");
  release();
  await Promise.all([first, second]);
  assert(events.join(",") === "first,other,finished,second");
  await queue.run(-1, () => Promise.reject(new Error("expected"))).catch(
    () => {},
  );
  await queue.run(-1, () => {
    events.push("recovered");
    return Promise.resolve();
  });
  assert(events.at(-1) === "recovered");
});

Deno.test("群内验证链接成功后删除，临时删除失败可重试且不重复恢复权限", async () => {
  const { bot, sweep, store, calls } = setup();
  let failDelete = true;
  bot.api.config.use((previous, method, payload, signal) => {
    if (method === "getChat") {
      return Promise.resolve({
        ok: true,
        result: {
          id: -1,
          type: "supergroup",
          title: "验证群",
          permissions: { can_send_messages: true },
        },
      }) as ReturnType<typeof previous<typeof method>>;
    }
    if (method === "deleteMessage" && failDelete) {
      failDelete = false;
      throw new Error("temporary network failure");
    }
    return previous(method, payload, signal);
  });
  try {
    await bot.init();
    const member = { id: 42, is_bot: false, first_name: "User" };
    await bot.handleUpdate({
      update_id: 10,
      chat_member: {
        chat: { id: -1, type: "supergroup", title: "验证群" },
        from: member,
        date: 1,
        old_chat_member: { status: "left", user: member },
        new_chat_member: { status: "member", user: member },
        invite_link: {
          invite_link: "https://t.me/+test",
          creator: user,
          creates_join_request: false,
          is_primary: false,
          is_revoked: false,
        },
      },
    });
    const join = store.active()[0];
    assert(join.message_id === 123);
    await sweep();
    assert(!calls.some((c) => c.method === "deleteMessage"));
    store.resolve(join.id, 42, true);
    await sweep();
    assert(store.get(join.id)?.state === "done");
    assert(store.active().some((j) => j.id === join.id));
    const restored = calls.filter((c) =>
      c.method === "restrictChatMember"
    ).length;
    await sweep();
    assert(store.get(join.id)?.message_id === null);
    assert(!store.active().some((j) => j.id === join.id));
    assert(
      calls.filter((c) => c.method === "restrictChatMember").length ===
        restored,
    );
    const deletion = calls.find((c) => c.method === "deleteMessage");
    assert(
      deletion?.payload.chat_id === -1 && deletion.payload.message_id === 123,
    );
  } finally {
    store.close();
  }
});
