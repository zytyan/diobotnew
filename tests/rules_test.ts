import { matchRules, type RegexRule, validateRules } from "../src/rules.ts";
import { messageContent } from "../src/message_content.ts";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import type { Message, Update } from "grammy/types";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const allow: RegexRule = {
  id: "allow",
  name: "白名单",
  enabled: true,
  action: "allow",
  conditions: [{ field: "message", pattern: "t\\.me", flags: "iu" }],
};
const ban: RegexRule = {
  id: "ban",
  name: "黑名单组",
  enabled: true,
  action: "ban",
  conditions: [{ field: "message", pattern: "t\\.me", flags: "iu" }, {
    field: "username",
    pattern: "sales",
    flags: "iu",
  }, { field: "bio", pattern: "进群", flags: "u" }],
};
Deno.test("规则按顺序首个命中，组内所有字段AND匹配，禁用和不可见bio不命中", async () => {
  const fields = {
    message: "点击 T.ME/test",
    username: "sales_bot",
    bio: "进群咨询",
  };
  assert((await matchRules([allow, ban], fields)).rule?.action === "allow");
  assert((await matchRules([ban, allow], fields)).rule?.action === "ban");
  assert(
    (await matchRules([ban], { ...fields, bio: "开发者" })).rule === undefined,
  );
  assert(
    (await matchRules([ban], { ...fields, bio: undefined })).rule === undefined,
  );
  assert(
    (await matchRules([{ ...ban, enabled: false }], fields)).rule === undefined,
  );
});
Deno.test("正则校验拒绝错误表达式；回溯超时被隔离，不阻塞主线程", async () => {
  let rejected = false;
  try {
    validateRules([{
      ...allow,
      conditions: [{ field: "message", pattern: "[", flags: "u" }],
    }]);
  } catch {
    rejected = true;
  }
  assert(rejected);
  const result = await matchRules(
    [{
      ...allow,
      conditions: [{ field: "message", pattern: "(a+)+$", flags: "" }],
    }],
    { message: "a".repeat(5000) + "!" },
    100,
  );
  assert(result.failed && !result.rule);
});
Deno.test("提取caption、隐藏链接、投票、清单、新增任务、文件名；不混入回复和其他人添加的选项", () => {
  const base = {
    message_id: 1,
    date: 1,
    chat: { id: -1, type: "supergroup", title: "T" },
    from: { id: 42, first_name: "A", is_bot: false },
  };
  const content = (fields: Record<string, unknown>) =>
    messageContent({ ...base, ...fields } as unknown as Message);
  const photo = content({
    photo: [],
    caption: "进群",
    caption_entities: [{
      type: "text_link",
      offset: 0,
      length: 2,
      url: "https://t.me/+invite",
    }],
  });
  assert(
    photo.text.includes("进群") && photo.text.includes("t.me/+invite") &&
      photo.kind === "photo",
  );
  const poll = content({
    poll: {
      question: "题目",
      description: "进群",
      options: [{ text: "t.me/test" }, {
        text: "other-user-ad",
        added_by_user: { id: 7 },
      }],
    },
  });
  assert(
    poll.text.includes("题目") && poll.text.includes("t.me/test") &&
      !poll.text.includes("other-user-ad"),
  );
  assert(
    content({ checklist: { title: "清单", tasks: [{ text: "t.me/test" }] } })
      .text.includes("t.me/test"),
  );
  const added = content({
    checklist_tasks_added: {
      tasks: [{ text: "新增广告" }],
      checklist_message: { text: "原作者内容" },
    },
  });
  assert(added.text === "新增广告");
  assert(
    content({ poll_option_added: { option_text: "进群" } }).text === "进群",
  );
  assert(
    content({ document: { file_name: "t.me-ad.pdf" } }).text.includes(
      "t.me-ad.pdf",
    ),
  );
  assert(
    content({ text: "正常消息", reply_to_message: { text: "被回复广告" } })
      .text === "正常消息",
  );
});
Deno.test("完整链路：本地黑白规则在AI关闭时也生效，按序放行或封禁且不调用AI", async () => {
  for (const rules of [[allow, ban], [ban, allow]]) {
    const config = loadConfig({
      BOT_TOKEN: "99:fake",
      TELEGRAM_ENV: "test",
      AI_DAILY_LIMIT: "0",
    });
    const store = new Store(":memory:");
    const initial = store.settings(-1, {
      verification: false,
      moderation: "off",
      welcome: true,
      kicked: true,
      leave: true,
      tree: true,
    });
    store.saveSettings(-1, {
      ...initial,
      rules,
      aiThreshold: .8,
      review: false,
      uploadAvatar: false,
    }, 0);
    let uploads = 0;
    const calls: string[] = [];
    const { bot } = createBot(config, store, {
      request: () => {
        uploads++;
        return Promise.reject(new Error("AI must not run"));
      },
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push(method);
      const p = payload as Record<string, unknown>;
      const result = method === "getMe"
        ? { id: 99, is_bot: true, first_name: "Bot", username: "bot" }
        : method === "getChatMember"
        ? {
          status: "member",
          user: { id: p.user_id, is_bot: false, first_name: "A" },
        }
        : method === "getChat"
        ? (Number(p.chat_id) > 0
          ? { id: 42, type: "private", first_name: "A", bio: "进群咨询" }
          : { id: -1, type: "supergroup", title: "T" })
        : true;
      return Promise.resolve({ ok: true, result }) as ReturnType<
        typeof _prev<typeof method>
      >;
    });
    try {
      await bot.init();
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -1, type: "supergroup", title: "T" },
          from: {
            id: 42,
            is_bot: false,
            first_name: "A",
            username: "sales_bot",
          },
          photo: [],
          caption: "t.me/test",
        },
      } as Update);
      assert(uploads === 0 && !calls.includes("getUserProfilePhotos"));
      assert(calls.includes("banChatMember") === (rules[0].action === "ban"));
      const log = store.groupLogs(-1).find((row) => row.kind === "action");
      assert(
        log?.data.action ===
          (rules[0].action === "ban" ? "rule_banned" : "rule_allowed"),
      );
    } finally {
      store.close();
    }
  }
});
