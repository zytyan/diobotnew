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
              advertisement: .006,
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

Deno.test("处罚模式：观察不处理、删除不禁言、禁言保留成员；低概率和管理员受保护", async () => {
  for (const mode of ["observe", "delete", "mute", "ban"] as const) {
    const config = loadConfig({
      BOT_TOKEN: "99:fake",
      TELEGRAM_ENV: "test",
      CF_ACCOUNT_ID: "account",
      CF_API_TOKEN: "token",
      MODERATION_MODE: mode,
      PUBLIC_CHAT_IDS: "-1",
    });
    const store = new Store(":memory:");
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    let score = .91;
    let role = "member";
    let failMute = false;
    let disableDuringRequest = false;
    const request: typeof fetch = () => {
      if (disableDuringRequest) store.updateSetting(-1, "moderation", "off", 0);
      return Promise.resolve(Response.json({
        success: true,
        result: {
          answers: {
            classification: {
              type: "choice",
              choice: "advertisement",
              confidence: score,
              probabilities: {
                normal: 1 - score,
                advertisement: score,
                uncertain: 0,
              },
            },
          },
        },
      }));
    };
    const { bot } = createBot(config, store, { request });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "restrictChatMember" && failMute) {
        throw new Error("restriction failed");
      }
      const result = method === "getMe"
        ? { id: 99, is_bot: true, first_name: "Bot", username: "bot" }
        : method === "getChatMember"
        ? { status: role, user }
        : method === "getChat"
        ? { id: 42, type: "private", first_name: "Alice", bio: "sale" }
        : method === "getUserProfilePhotos"
        ? { total_count: 0, photos: [] }
        : true;
      return Promise.resolve({ ok: true, result }) as ReturnType<
        typeof _prev<typeof method>
      >;
    });
    const send = (id: number) =>
      bot.handleUpdate({
        update_id: id,
        message: { ...message, message_id: id } as NonNullable<
          Update["message"]
        >,
      });
    try {
      await bot.init();
      await send(1);
      assert(
        calls.filter((c) => c.method === "deleteMessage").length ===
          (mode === "observe" ? 0 : 1),
      );
      const restrictions = calls.filter((c) =>
        c.method === "restrictChatMember"
      );
      assert(restrictions.length === (mode === "mute" ? 1 : 0));
      if (mode === "mute") {
        assert(
          restrictions[0].payload.user_id === 42 &&
            restrictions[0].payload.until_date === 0,
        );
        assert(JSON.stringify(restrictions[0].payload.permissions) === "{}");
        assert(store.recentReviews(-1)[0].action === "muted");
      }
      const bans = calls.filter((c) => c.method === "banChatMember");
      assert(bans.length === (mode === "ban" ? 1 : 0));
      if (mode === "ban") {
        assert(
          bans[0].payload.user_id === 42 && bans[0].payload.until_date === 0,
        );
        assert(store.recentReviews(-1)[0].action === "banned");
      }
      const before = calls.length;
      score = .79;
      await send(2);
      role = "administrator";
      await send(3);
      assert(
        !calls.slice(before).some((c) =>
          ["deleteMessage", "restrictChatMember", "banChatMember"].includes(
            c.method,
          )
        ),
      );
      if (mode === "mute") {
        role = "member";
        score = .91;
        failMute = true;
        await send(4);
        assert(store.recentReviews(-1)[0].action === "deleted_mute_failed");
      }
      if (mode === "delete") {
        role = "member";
        score = .91;
        disableDuringRequest = true;
        const count = calls.filter((c) => c.method === "deleteMessage").length;
        await send(5);
        assert(
          calls.filter((c) => c.method === "deleteMessage").length === count,
        );
        assert(store.recentReviews(-1)[0].action === "settings_changed");
      }
      assert(!calls.some((c) => c.method === "unbanChatMember"));
      if (mode !== "ban") {
        assert(!calls.some((c) => c.method === "banChatMember"));
      }
    } finally {
      store.close();
    }
  }
});

Deno.test("名片与跨频道回复进入真实审核链：上传联系对象但只处理当前作者，并完整留存原始字段", async () => {
  const config = loadConfig({
    BOT_TOKEN: "99:fake",
    TELEGRAM_ENV: "test",
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    MODERATION_MODE: "ban",
    PUBLIC_CHAT_IDS: "-1",
  });
  const store = new Store(":memory:");
  const targets: number[] = [];
  const inputs: Record<string, unknown>[] = [];
  const request: typeof fetch = (_url, init) => {
    inputs.push(JSON.parse(String(init?.body)).state);
    return Promise.resolve(Response.json({
      success: true,
      result: {
        answers: {
          classification: {
            type: "choice",
            choice: "advertisement",
            confidence: .93,
            probabilities: { normal: .04, advertisement: .93, uncertain: .03 },
          },
        },
      },
    }));
  };
  const { bot } = createBot(config, store, { request });
  bot.api.config.use((_prev, method, payload) => {
    if (method === "banChatMember") {
      targets.push(Number((payload as { user_id: number }).user_id));
    }
    const result = method === "getMe"
      ? { id: 99, is_bot: true, first_name: "Bot", username: "bot" }
      : method === "getChatMember"
      ? { status: "member", user }
      : method === "getChat"
      ? { id: 42, type: "private", first_name: "Alice" }
      : method === "getUserProfilePhotos"
      ? { total_count: 0, photos: [] }
      : true;
    return Promise.resolve({ ok: true, result }) as ReturnType<
      typeof _prev<typeof method>
    >;
  });
  try {
    await bot.init();
    const card = {
      message_id: 101,
      date: 1,
      chat: message.chat,
      from: user,
      contact: {
        first_name: "Target",
        phone_number: "+12025550123",
        user_id: 777,
        vcard: "BEGIN:VCARD\nEMAIL:target@example.invalid\nEND:VCARD",
      },
    } as Message;
    await bot.handleUpdate({
      update_id: 101,
      message: card as NonNullable<Update["message"]>,
    });
    const external = {
      ...message,
      message_id: 102,
      text: "来发财",
      external_reply: {
        origin: {
          type: "channel",
          date: 1,
          chat: { id: -2, type: "channel", title: "Channel" },
          message_id: 8,
        },
        contact: card.contact,
      },
      quote: { text: "联系此人", position: 0 },
    } as Message;
    await bot.handleUpdate({
      update_id: 102,
      message: external as NonNullable<Update["message"]>,
    });
    assert(
      inputs.length === 2 && targets.length === 2 &&
        targets.every((id) => id === 42),
    );
    const first = inputs[0].evidence as { contacts: { user_id?: number }[] };
    const second = inputs[1].evidence as {
      replies: { attribution: string; contacts: { user_id?: number }[] }[];
    };
    assert(first.contacts.some((target) => target.user_id === 777));
    assert(
      second.replies[0].attribution === "reference_only" &&
        second.replies[0].contacts.some((target) => target.user_id === 777),
    );
    const snapshot = store.latestRawMessage(-1, 102);
    assert(
      snapshot &&
        JSON.parse(snapshot.message_json).external_reply.contact.vcard ===
          card.contact!.vcard,
    );
    assert(
      JSON.parse(snapshot.context_json).evidence.replies[0].contacts[0]
        .user_id === 777,
    );
  } finally {
    store.close();
  }
});

Deno.test("访客 bot 广告使用关于资料，并联动封禁 Telegram 记录的普通召唤者", async () => {
  const config = loadConfig({
    BOT_TOKEN: "99:fake",
    TELEGRAM_ENV: "test",
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    MODERATION_MODE: "ban",
    PUBLIC_CHAT_IDS: "-1",
  });
  const store = new Store(":memory:");
  const guest = {
    id: 88,
    is_bot: true,
    first_name: "Guest",
    username: "guest_bot",
  };
  const other = { ...user, id: 47 };
  const targets: number[] = [];
  const deletions: number[] = [];
  let callerRole = "member";
  let score = .92;
  let aboutReads = 0;
  const bio = "一单给500\n进群 & 咨询 https://t.me/example";
  const request: typeof fetch = (url, init) => {
    if (String(url) === "https://t.me/guest_bot") {
      aboutReads++;
      return Promise.resolve(
        new Response(
          '<div class="tgme_page_extra"><a href="tg://resolve?domain=guest_bot"></a>' +
            '<div class="tgme_page_description ">一单给500<br/>进群 &amp; 咨询 https://t.me/example</div></div>',
        ),
      );
    }
    const payload = JSON.parse(String(init?.body));
    assert(payload.state.sender.bio === bio);
    assert(payload.state.sender.bio_source === "bot_about");
    assert(payload.state.evidence.contacts.some(
      (target: { username?: string }) => target.username === "example",
    ));
    return Promise.resolve(Response.json({
      success: true,
      result: {
        answers: {
          classification: {
            type: "choice",
            choice: "advertisement",
            confidence: score,
            probabilities: { normal: 1 - score, advertisement: score },
          },
        },
      },
    }));
  };
  const { bot } = createBot(config, store, { request });
  bot.api.config.use((_prev, method, payload) => {
    const params = payload as { user_id?: number; message_id?: number };
    const member = params.user_id === guest.id ? guest : user;
    if (method === "deleteMessage") deletions.push(params.message_id!);
    if (method === "banChatMember") {
      targets.push(params.user_id!);
      if (params.user_id === guest.id) throw new Error("guest not in group");
    }
    const result = method === "getMe"
      ? { id: 99, is_bot: true, first_name: "Bot", username: "mod_bot" }
      : method === "getChatMember"
      ? { status: member.id === user.id ? callerRole : "left", user: member }
      : method === "getChat"
      ? { id: user.id, type: "private", first_name: "Alice", bio: "personal" }
      : method === "getUserProfilePhotos"
      ? { total_count: 0, photos: [] }
      : true;
    return Promise.resolve({ ok: true, result }) as ReturnType<
      typeof _prev<typeof method>
    >;
  });
  const send = (id: number, attrs: Partial<Message>) =>
    bot.handleUpdate({
      update_id: id,
      message: { ...message, message_id: id, ...attrs } as NonNullable<
        Update["message"]
      >,
    });
  const response = {
    from: guest,
    guest_bot_caller_user: user,
    reply_to_message: { ...message, from: other, reply_to_message: undefined },
  };
  try {
    await bot.init();
    await send(30065, response);
    assert(targets.join(",") === "88,42");
    assert(
      store.groupLogs(-1).some((row) =>
        row.kind === "action" && row.data.action === "guest_caller_banned" &&
        row.data.target_id === user.id
      ),
    );
    callerRole = "administrator";
    await send(30066, response);
    assert(targets.join(",") === "88,42,88");
    score = .68;
    await send(30067, response);
    assert(deletions.join(",") === "30065,30066");
    assert(targets.join(",") === "88,42,88");
    score = .92;
    callerRole = "member";
    await send(30068, { from: user, via_bot: guest });
    assert(targets.join(",") === "88,42,88,42");
    assert(aboutReads === 1);
  } finally {
    store.close();
  }
});
