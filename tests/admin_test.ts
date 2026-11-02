import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import type { ChatMember, Update, User } from "grammy/types";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const user = (id: number): User => ({
  id,
  is_bot: false,
  first_name: `User ${id}`,
});
const chat = { id: -1, type: "supergroup" as const, title: "Test" };
const defaults = {
  verification: false,
  moderation: "off" as const,
  welcome: true,
  kicked: true,
  leave: true,
  tree: true,
};
function setup(env: Record<string, string> = {}) {
  const store = new Store(":memory:");
  const config = loadConfig({
    BOT_TOKEN: "99:fake",
    TELEGRAM_ENV: "test",
    ...env,
  });
  const { bot, sweep } = createBot(config, store);
  const roles = new Map<number, ChatMember>([[1, {
    status: "creator",
    user: user(1),
    is_anonymous: false,
  }]]);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as Record<string, unknown>;
    const result = method === "getMe"
      ? { ...user(99), is_bot: true, username: "test_bot" }
      : method === "getChatMember"
      ? roles.get(Number(p.user_id)) ??
        { status: "member", user: user(Number(p.user_id)) }
      : method === "sendRichMessage"
      ? { message_id: 0, ephemeral_message_id: 123, receiver_user: user(1) }
      : true;
    return Promise.resolve({ ok: true, result }) as ReturnType<
      typeof _prev<typeof method>
    >;
  });
  let update = 0;
  async function command(id: number, text: string) {
    await bot.handleUpdate({
      update_id: ++update,
      message: {
        message_id: 0,
        ephemeral_message_id: 9,
        receiver_user: user(id),
        date: 1,
        chat,
        from: user(id),
        text,
        entities: [{
          type: "bot_command",
          offset: 0,
          length: text.split(" ")[0].length,
        }],
      },
    });
  }
  async function callback(id: number, data: string, receiver = id) {
    await bot.handleUpdate({
      update_id: ++update,
      callback_query: {
        id: `q${update}`,
        from: user(id),
        chat_instance: "chat",
        data,
        message: {
          message_id: 0,
          ephemeral_message_id: 123,
          receiver_user: user(receiver),
          date: 1,
          chat,
        },
      },
    });
  }
  async function member(
    id: number,
    from: number,
    status: "join" | "left" | "ban",
    until = 0,
  ) {
    const u = user(id);
    await bot.handleUpdate({
      update_id: ++update,
      chat_member: {
        chat,
        from: user(from),
        date: update,
        old_chat_member: status === "join"
          ? { status: "left", user: u }
          : { status: "member", user: u },
        new_chat_member: status === "join"
          ? { status: "member", user: u }
          : status === "left"
          ? { status: "left", user: u }
          : { status: "kicked", user: u, until_date: until },
      },
    } as Update);
  }
  return { bot, sweep, store, roles, calls, command, callback, member };
}
Deno.test("管理员设置使用原生 ephemeral rich + button；普通成员不能配置", async () => {
  const t = setup();
  try {
    await t.bot.init();
    await t.command(2, "/settings");
    assert(!t.calls.some((c) => c.method === "sendMessage"));
    assert(
      t.calls.some((c) =>
        c.method === "sendRichMessage" &&
        (c.payload.ephemeral_message_parameters as { receiver_user_id: number })
            .receiver_user_id === 2
      ),
    );
    await t.command(1, "/inline_settings");
    const panel = t.calls.filter((c) => c.method === "sendRichMessage").at(-1)!;
    assert(
      (panel.payload.rich_message as { blocks: { type: string }[] }).blocks
        .some((b) => b.type === "buttons"),
    );
    await t.callback(1, "cfg:1:welcome:0");
    assert(!t.store.settings(-1, defaults).welcome);
    assert(t.calls.some((c) => c.method === "editEphemeralMessageText"));
    await t.callback(1, "cfg:1:welcome:0");
    assert(!t.store.settings(-1, defaults).welcome);
    await t.callback(2, "cfg:1:welcome:1", 1);
    assert(!t.store.settings(-1, defaults).welcome);
    t.roles.set(1, { status: "member", user: user(1) });
    await t.callback(1, "cfg:1:welcome:1");
    assert(!t.store.settings(-1, defaults).welcome);
  } finally {
    t.store.close();
  }
});
Deno.test("欢迎、离开和封禁通知独立关闭；直接邀请关系仍保存", async () => {
  const t = setup();
  try {
    await t.bot.init();
    t.store.settings(-1, defaults);
    for (
      const [index, key] of (["welcome", "leave", "kicked"] as const).entries()
    ) t.store.updateSetting(-1, key, false, index);
    await t.member(3, 2, "join");
    assert(t.store.invitees(-1, 2)[0].user_id === 3);
    await t.member(3, 2, "left");
    assert(t.store.invitees(-1, 2).length === 0);
    await t.member(4, 2, "ban");
    assert(!t.calls.some((c) => c.method === "sendMessage"));
    assert(t.store.active().length === 0);
  } finally {
    t.store.close();
  }
});
Deno.test("砍树必须两次确认、绑定管理员和群、跳过管理员、不递归、不能重复执行", async () => {
  const t = setup();
  try {
    await t.bot.init();
    await t.member(3, 2, "join");
    await t.member(4, 2, "join");
    await t.member(5, 3, "join");
    t.roles.set(2, { status: "kicked", user: user(2), until_date: 0 });
    t.roles.set(4, {
      status: "administrator",
      user: user(4),
      can_be_edited: true,
      is_anonymous: false,
      can_manage_chat: true,
      can_send_welcome_messages: true,
      can_delete_messages: true,
      can_manage_video_chats: false,
      can_restrict_members: true,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: true,
      can_post_stories: false,
      can_edit_stories: false,
      can_delete_stories: false,
    });
    await t.member(2, 1, "ban");
    const action = t.store.db.prepare("SELECT id FROM tree_actions").get()!;
    const id = String(action.id);
    assert(t.store.treeAction(id)?.state === "offered");
    await t.sweep();
    assert(!t.calls.some((c) => c.method === "banChatMember"));
    await t.callback(2, `tree:preview:${id}`, 1);
    assert(t.store.treeAction(id)?.state === "offered");
    await t.callback(1, `tree:run:${id}`);
    assert(t.store.treeAction(id)?.state === "offered");
    await t.callback(1, `tree:preview:${id}`);
    assert(t.store.treeAction(id)?.state === "confirm");
    await t.callback(1, `tree:run:${id}`);
    await t.sweep();
    const bans = t.calls.filter((c) => c.method === "banChatMember");
    assert(bans.length === 1 && bans[0].payload.user_id === 3);
    assert(t.store.treeCounts(id).skipped === 1);
    await t.callback(1, `tree:run:${id}`);
    await t.sweep();
    assert(t.calls.filter((c) => c.method === "banChatMember").length === 1);
  } finally {
    t.store.close();
  }
});
Deno.test("临时封禁不提示砍树；解除永久封禁或撤销权限会取消已排队任务", async () => {
  const t = setup();
  try {
    await t.bot.init();
    await t.member(3, 2, "join");
    await t.member(2, 1, "ban", 9999999999);
    assert(!t.store.db.prepare("SELECT id FROM tree_actions").get());
    t.roles.set(2, { status: "kicked", user: user(2), until_date: 0 });
    await t.member(2, 1, "ban");
    const id = String(
      t.store.db.prepare("SELECT id FROM tree_actions").get()!.id,
    );
    await t.callback(1, `tree:preview:${id}`);
    await t.callback(1, `tree:run:${id}`);
    t.roles.set(2, { status: "left", user: user(2) });
    await t.sweep();
    assert(t.store.treeAction(id)?.state === "cancelled");
    assert(!t.calls.some((c) => c.method === "banChatMember"));
  } finally {
    t.store.close();
  }
});
Deno.test("关闭验证会放行待审批并恢复待验证成员", () => {
  const store = new Store(":memory:");
  try {
    store.settings(-1, { ...defaults, verification: true });
    const a = store.create(-1, 3, "direct");
    const b = store.create(-1, 4, "request");
    assert(store.updateSetting(-1, "verification", false, 0));
    assert(
      store.get(a.id)?.state === "verified" &&
        store.get(b.id)?.state === "verified",
    );
  } finally {
    store.close();
  }
});

Deno.test("砍树确认名单冻结，新邀请不会混入已确认任务；设置和邀请可在重启后恢复", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/state.sqlite`;
  try {
    let store = new Store(path);
    store.settings(-1, defaults);
    store.updateSetting(-1, "welcome", false, 0);
    store.invited(-1, 2, 3, "child", 1);
    store.invited(-2, 2, 9, "other group", 1);
    const action = store.offerTree(-1, 1, 2, "event")!;
    assert(store.previewTree(action.id));
    store.invited(-1, 2, 4, "new child", 2);
    assert(store.startTree(action.id));
    assert(store.treePending(action.id).join(",") === "3");
    store.db.prepare(
      "INSERT INTO joins(id,chat_id,user_id,kind,state,expires) VALUES('legacy',-1,5,'speech','speech',0)",
    ).run();
    store.close();
    store = new Store(path);
    try {
      assert(!store.settings(-1, defaults).welcome);
      assert(store.invitees(-1, 2).length === 2);
      assert(store.treeJobs()[0].id === action.id);
      assert(store.get("legacy")?.state === "done");
    } finally {
      store.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("解除封禁不会产生离开通知；管理员移出使用踢出开关", async () => {
  const t = setup();
  try {
    await t.bot.init();
    t.store.settings(-1, defaults);
    await t.bot.handleUpdate({
      update_id: 99,
      chat_member: {
        chat,
        from: user(1),
        date: 1,
        old_chat_member: { status: "kicked", user: user(3), until_date: 0 },
        new_chat_member: { status: "left", user: user(3) },
      },
    });
    assert(!t.calls.some((c) => c.method === "sendMessage"));
    t.store.updateSetting(-1, "leave", false, 0);
    await t.member(3, 1, "left");
    assert(t.calls.filter((c) => c.method === "sendMessage").length === 1);
    t.store.updateSetting(-1, "kicked", false, 1);
    await t.member(4, 1, "left");
    assert(t.calls.filter((c) => c.method === "sendMessage").length === 1);
  } finally {
    t.store.close();
  }
});

Deno.test("bot 被移出群时取消待验证和已确认砍树任务", async () => {
  const t = setup();
  try {
    await t.bot.init();
    const pending = t.store.create(-1, 3, "request");
    t.store.invited(-1, 2, 4, "child", 1);
    const action = t.store.offerTree(-1, 1, 2, "removed-bot")!;
    t.store.previewTree(action.id);
    t.store.startTree(action.id);
    const b = { ...user(99), is_bot: true };
    await t.bot.handleUpdate({
      update_id: 100,
      my_chat_member: {
        chat,
        from: user(1),
        date: 1,
        old_chat_member: { status: "member", user: b },
        new_chat_member: { status: "left", user: b },
      },
    });
    assert(t.store.get(pending.id)?.state === "superseded");
    assert(t.store.treeAction(action.id)?.state === "cancelled");
    await t.sweep();
    assert(!t.calls.some((c) => c.method === "banChatMember"));
  } finally {
    t.store.close();
  }
});

Deno.test("近期样本面板私密且只限当前管理员，标注按钮绑定操作者", async () => {
  const t = setup();
  try {
    await t.bot.init();
    const id = t.store.recordReview({
      chat: -1,
      message: 1,
      sender: 2,
      kind: "text",
      text: "Alice",
      profile: '{"sender":{"display_name":"Alice"}}',
      fingerprint: "1",
      date: 1,
      mode: "observe",
    }, { reviewDays: 7, reviewPerChat: 1000, reviewMax: 10000 })!;
    await t.command(2, "/review");
    assert(!JSON.stringify(t.calls.at(-1)).includes("Alice"));
    await t.command(1, "/review");
    assert(JSON.stringify(t.calls.at(-1)).includes("Alice"));
    assert(!t.calls.some((c) => c.method === "sendMessage"));
    await t.callback(2, `rev:1:${id}:normal`, 1);
    assert(!t.store.recentReviews(-1)[0].human_label);
    await t.callback(1, `rev:1:${id}:normal`);
    assert(t.store.recentReviews(-1)[0].human_label === "normal");
    t.roles.set(1, { status: "member", user: user(1) });
    await t.callback(1, `rev:1:${id}:scam`);
    assert(t.store.recentReviews(-1)[0].human_label === "normal");
  } finally {
    t.store.close();
  }
});

Deno.test("/check 私密命令检查回复消息，普通成员无权调用，管理员消息不上传", async () => {
  const t = setup();
  try {
    await t.bot.init();
    await t.command(2, "/check");
    assert(JSON.stringify(t.calls.at(-1)).includes("只有本群管理员"));
    await t.command(1, "/check");
    assert(JSON.stringify(t.calls.at(-1)).includes("请回复"));
    await t.bot.handleUpdate({
      update_id: 500,
      message: {
        message_id: 0,
        ephemeral_message_id: 9,
        receiver_user: user(1),
        chat,
        from: user(1),
        date: 1,
        text: "/check",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
        reply_to_message: {
          reply_to_message: undefined,
          message_id: 1,
          chat,
          from: user(1),
          date: 1,
          text: "private admin content",
        },
      },
    });
    assert(JSON.stringify(t.calls.at(-1)).includes("未上传"));
    assert(
      !t.calls.some((c) =>
        c.method === "sendMessage" || c.method === "getUserProfilePhotos"
      ),
    );
  } finally {
    t.store.close();
  }
});

Deno.test("审核设置循环包括禁言，旧广告与诈骗共用一个标注入口", async () => {
  const t = setup({ CF_ACCOUNT_ID: "account", CF_API_TOKEN: "token" });
  try {
    await t.bot.init();
    await t.command(1, "/inline_settings");
    for (
      const [revision, mode] of ["observe", "delete", "mute", "ban", "off"]
        .entries()
    ) {
      await t.callback(1, `cfg:1:moderation:${revision}`);
      assert(t.store.settings(-1, defaults).moderation === mode);
    }
    const id = t.store.recordReview({
      chat: -1,
      message: 1,
      sender: 2,
      kind: "text",
      text: "sale",
      profile: "{}",
      fingerprint: "1",
      date: 1,
      mode: "observe",
    }, { reviewDays: 7, reviewPerChat: 1000, reviewMax: 10000 })!;
    await t.command(1, "/review");
    const panel = JSON.stringify(t.calls.at(-1));
    assert(
      panel.includes("垃圾广告（含诈骗）") && !panel.includes(`:${id}:scam`),
    );
    await t.callback(1, `rev:1:${id}:scam`);
    assert(t.store.recentReviews(-1)[0].human_label === "advertisement");
  } finally {
    t.store.close();
  }
});

Deno.test("settings 仅提供Web设置与日志入口，inline_settings保留按钮回退", async () => {
  const t = setup();
  try {
    await t.bot.init();
    await t.command(1, "/settings");
    const web = JSON.stringify(t.calls.at(-1));
    assert(
      web.includes("startapp=settings_-1") && web.includes("startapp=logs_-1"),
    );
    assert(!web.includes("cfg:1:"));
    await t.command(1, "/inline_settings");
    assert(JSON.stringify(t.calls.at(-1)).includes("cfg:1:"));
    await t.command(2, "/inline_settings");
    assert(!JSON.stringify(t.calls.at(-1)).includes("cfg:2:"));
  } finally {
    t.store.close();
  }
});

Deno.test("/check 直接返回已记录的正则放行或封禁结果，不读取资料也不再执行处罚", async () => {
  for (
    const action of [
      "rule_allowed",
      "rule_banned",
      "rule_banned_delete_failed",
      "rule_ban_failed",
    ]
  ) {
    const t = setup();
    try {
      await t.bot.init();
      const target = {
        message_id: 5,
        chat,
        from: user(2),
        date: 1,
        text: "test",
      };
      const id = t.store.captureMessage(
        -1,
        5,
        "v1",
        JSON.stringify(target),
        "{}",
      );
      t.store.snapshotResult(id, action, {
        model: "local-regex",
        rule_id: "original",
        reason: "规则：原始规则",
      });
      await t.bot.handleUpdate({
        update_id: 501,
        message: {
          message_id: 0,
          ephemeral_message_id: 9,
          receiver_user: user(1),
          chat,
          from: user(1),
          date: 1,
          text: "/check",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
          reply_to_message: { ...target, reply_to_message: undefined },
        },
      });
      const reply = JSON.stringify(t.calls.at(-1));
      assert(reply.includes("已记录的正则匹配") && reply.includes("原始规则"));
      assert(reply.includes("未调用 AI"));
      assert(
        !t.calls.some((c) =>
          ["getChat", "getUserProfilePhotos", "deleteMessage", "banChatMember"]
            .includes(c.method)
        ),
      );
    } finally {
      t.store.close();
    }
  }
});

Deno.test("/blacklist 按钮绑定本群、操作者及有效期，管理员可用自己媒体添加且不追溯处罚", async () => {
  const t = setup();
  try {
    await t.bot.init();
    await t.bot.handleUpdate({
      update_id: 800,
      message: {
        message_id: 0,
        ephemeral_message_id: 9,
        receiver_user: user(1),
        chat,
        from: user(1),
        date: 1,
        text: "/blacklist",
        entities: [{ type: "bot_command", offset: 0, length: 10 }],
        reply_to_message: {
          message_id: 80,
          chat,
          from: user(1),
          date: 1,
          reply_to_message: undefined,
          sticker: {
            file_id: "file",
            file_unique_id: "unique",
            type: "regular",
            width: 128,
            height: 128,
            is_animated: false,
            is_video: false,
            set_name: "Pack",
          },
        },
      },
    });
    const panel = JSON.stringify(t.calls.at(-1));
    const unique = panel.match(/media:unique:[a-f0-9]{32}/)![0];
    const set = panel.match(/media:set:[a-f0-9]{32}/)![0];
    assert(panel.includes("加入 PDQ Hash"));
    await t.callback(2, unique);
    assert(t.store.media.entries(-1).length === 0);
    await t.callback(1, unique);
    assert(t.store.media.entries(-1)[0].value === "unique");
    await t.callback(1, unique);
    assert(t.store.media.entries(-1).length === 1);
    await t.callback(1, set);
    assert(t.store.media.entries(-1).some((e) => e.value === "pack"));
    assert(
      !t.calls.some((c) =>
        ["deleteMessage", "banChatMember", "getFile"].includes(c.method)
      ),
    );
    t.store.db.prepare("UPDATE media_pending SET expires=0").run();
    await t.callback(1, unique);
    assert(JSON.stringify(t.calls.at(-1)).includes("过期"));
  } finally {
    t.store.close();
  }
});
