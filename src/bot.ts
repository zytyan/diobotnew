import { Bot, GrammyError } from "grammy";
import type { ChatPermissions, User } from "grammy/types";
import { ChatQueue } from "./queue.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { moderate } from "./moderation.ts";
import { createAdmin } from "./admin.ts";

const fullName = (user: User) =>
  [user.first_name, user.last_name].filter(Boolean).join(" ");
export function createBot(config: Config, store: Store) {
  const bot = new Bot(config.token, {
    client: {
      apiRoot: config.apiRoot,
      environment: config.environment,
      timeoutSeconds: 20,
    },
  });
  // Only updates that share a chat serialize. An AI request in one group cannot block all groups.
  const queue = new ChatQueue();
  bot.use((ctx, next) => ctx.chat ? queue.run(ctx.chat.id, next) : next());
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (
      chat &&
      (chat.type === "group" || chat.type === "supergroup" ||
        chat.type === "channel")
    ) {
      const status = ctx.myChatMember?.new_chat_member.status;
      store.recordChat(chat.id, chat.title, chat.type, status);
      if (status === "left" || status === "kicked") store.cancel(chat.id);
    }
    await next();
  });
  const admin = createAdmin(bot, config, store);
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await ctx.reply("我是群管理 bot。入群验证请使用申请入群后收到的专属链接。");
  });
  bot.command("stats", async (ctx) => {
    if (ctx.chat.type !== "private" || !config.owners.has(ctx.from!.id)) return;
    const chats = store.chats();
    const active = chats.filter((c) =>
      c.bot_status !== "left" && c.bot_status !== "kicked"
    );
    await ctx.reply(
      `已观察到 ${chats.length} 个群/频道，其中 ${active.length} 个未记录移除。\n只统计本版本启动后收到过更新的群，无法列出 Telegram 上的全部群。`,
    );
    for (let i = 0; i < chats.length; i += 15) {
      await ctx.reply(
        chats.slice(i, i + 15).map((c) =>
          `${c.title} (${c.id})\n状态：${c.bot_status ?? "未知"}；最近活动：${
            new Date(Number(c.last_seen)).toISOString()
          }`
        ).join("\n\n"),
      );
    }
  });
  bot.on("my_chat_member", () => {});
  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.chatJoinRequest;
    if (!admin.settings(req.chat.id).verification) {
      await ctx.approveChatJoinRequest(req.from.id);
      return;
    }
    const join = store.create(req.chat.id, req.from.id, "request");
    await bot.api.sendMessage(
      req.user_chat_id,
      `请在六分钟内完成入群验证：\nhttps://t.me/${bot.botInfo.username}?startapp=${join.id}`,
    );
  });
  bot.on("chat_member", async (ctx) => {
    const event = ctx.chatMember;
    const before = event.old_chat_member;
    const after = event.new_chat_member;
    const user = after.user;
    const name = fullName(user);
    if (after.status === "left") {
      store.cancel(event.chat.id, user.id);
      store.memberLeft(event.chat.id, user.id);
      const wasPresent =
        ["member", "administrator", "creator"].includes(before.status) ||
        (before.status === "restricted" && before.is_member);
      if (!wasPresent) return; // Unbanning an absent user is not a new departure.
      const notices = admin.settings(event.chat.id);
      if (event.from.id !== user.id) {
        if (notices.kicked) await ctx.reply(`${name}被管理员移出了本群。`);
      } else if (notices.leave) {
        await ctx.reply(`${name}先生好走！`);
      }
      return;
    }
    if (after.status === "kicked") {
      store.cancel(event.chat.id, user.id);
      store.memberLeft(event.chat.id, user.id);
      if (admin.settings(event.chat.id).kicked) {
        await ctx.reply(
          after.until_date === 0
            ? `${name}被管理的大手处理，永远离开了我们`
            : `${name}被管理的大手处理，暂时离开了我们`,
        );
      }
      if (
        after.until_date === 0 &&
        !(before.status === "kicked" && before.until_date === 0) &&
        !event.from.is_bot
      ) {
        await admin.offer(
          event.chat.id,
          event.from.id,
          user.id,
          `${event.chat.id}:${user.id}:${event.date}`,
        );
      }
      return;
    }
    const wasMember =
      ["member", "administrator", "creator"].includes(before.status) ||
      (before.status === "restricted" && before.is_member);
    const isMember =
      ["member", "administrator", "creator"].includes(after.status) ||
      (after.status === "restricted" && after.is_member);
    if (wasMember || !isMember || user.id === bot.botInfo.id) return;
    store.memberLeft(event.chat.id, user.id);
    const directlyInvited = !event.invite_link && !event.via_join_request &&
      event.from.id !== user.id;
    if (directlyInvited) {
      store.invited(event.chat.id, event.from.id, user.id, name, event.date);
    }
    const settings = admin.settings(event.chat.id);
    if (
      !settings.verification || event.invite_link?.creates_join_request ||
      event.via_join_request
    ) {
      if (settings.welcome) await ctx.reply(`欢迎${name}加入本群！`);
      return;
    }
    if (event.invite_link) {
      const chat = await bot.api.getChat(event.chat.id);
      const permissions = "permissions" in chat ? chat.permissions ?? {} : {};
      // Persist before restricting: a failed network operation remains recoverable.
      const join = store.create(event.chat.id, user.id, "direct", permissions);
      try {
        await bot.api.restrictChatMember(event.chat.id, user.id, {}, {
          use_independent_chat_permissions: true,
        });
        await ctx.reply(
          `${name}，请在六分钟内验证您是人类：\nhttps://t.me/${bot.botInfo.username}?startapp=${join.id}`,
        );
      } catch (error) {
        // Keep the deadline: a failed send must not strand a restricted member.
        throw error;
      }
      return;
    }
    if (!settings.welcome) return;
    if (event.from.id !== user.id) {
      await ctx.reply(
        user.is_bot
          ? `原来是${
            fullName(event.from)
          }先生请来的打工bot ${name}，这里打工007的！`
          : `原来是${fullName(event.from)}先生请来的贵客，${name}先生您也请。`,
      );
    } else {
      await ctx.reply(`欢迎${name}先生加入本群！`);
    }
  });
  bot.on(["message", "edited_message"], async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;
    const msg = ctx.message ?? ctx.editedMessage!;
    if (
      msg.new_chat_members || msg.left_chat_member || !msg.from ||
      msg.from.is_bot
    ) return;
    const settings = admin.settings(ctx.chat.id);
    if (
      settings.moderation === "off" || config.owners.has(msg.from.id) ||
      msg.ephemeral_message_id
    ) return;
    const text = msg.text ?? msg.caption;
    if (!text) return;
    try {
      const verdict = await moderate(
        config,
        store,
        ctx.chat.id,
        msg.message_id,
        text,
      );
      if (!verdict || verdict.label === "normal") return;
      console.info(
        JSON.stringify({
          event: "moderation",
          chat: ctx.chat.id,
          message: msg.message_id,
          mode: settings.moderation,
          ...verdict,
        }),
      );
      if (
        settings.moderation === "delete" && verdict.certainty === "high" &&
        ["advertisement", "scam"].includes(verdict.label)
      ) {
        const member = await ctx.getChatMember(msg.from.id);
        if (["administrator", "creator"].includes(member.status)) return;
        await ctx.deleteMessage();
      }
    } catch (error) {
      // API failure, malformed output, or quota exhaustion never causes a deletion.
      console.error(
        "审核未完成，保留消息",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  });
  bot.catch((error) =>
    console.error(
      JSON.stringify({
        event: "bot_error",
        update: error.ctx.update.update_id,
        error: safeError(error.error),
      }),
    )
  );

  async function sweep() {
    for (const item of store.active()) {
      await queue.run(item.chat_id, () => processJoin(item.id));
    }
    for (const job of store.treeJobs()) {
      await queue.run(job.chat_id, () => admin.processTree(job));
    }
  }
  async function processJoin(id: string) {
    // Pending joins use durable deadlines. Never hold an update handler for minutes.
    let join = store.get(id);
    if (!join) return;
    if (join.state === "pending") {
      if (join.expires > Date.now()) return;
      store.state(join.id, "failed");
      join = store.get(join.id)!;
    }
    if (join.state !== "verified" && join.state !== "failed") return;
    try {
      if (join.state === "failed") {
        if (join.kind === "request") {
          await bot.api.declineChatJoinRequest(join.chat_id, join.user_id);
        } else await bot.api.banChatMember(join.chat_id, join.user_id);
        store.state(join.id, "rejected");
      } else if (join.kind === "request") {
        await bot.api.approveChatJoinRequest(join.chat_id, join.user_id);
        store.state(join.id, "done");
      } else {
        await bot.api.restrictChatMember(
          join.chat_id,
          join.user_id,
          JSON.parse(join.permissions) as ChatPermissions,
          { use_independent_chat_permissions: true },
        );
        store.state(join.id, "done");
        if (admin.settings(join.chat_id).welcome) {
          await bot.api.sendMessage(join.chat_id, `欢迎新成员加入本群！`);
        }
      }
    } catch (error) {
      // Permanent permission/invalid-chat errors cannot succeed by retrying forever.
      if (
        error instanceof GrammyError && [400, 403].includes(error.error_code)
      ) store.state(join.id, "rejected");
      console.error(
        JSON.stringify({
          event: "join_action_failed",
          chat: join.chat_id,
          user: join.user_id,
          error: safeError(error),
        }),
      );
    }
  }
  return { bot, sweep };
}
function safeError(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.error_code}: ${error.description}`;
  }
  // Network exception messages may contain Bot API URLs, including tokens.
  return error instanceof Error ? error.name : "UnknownError";
}
