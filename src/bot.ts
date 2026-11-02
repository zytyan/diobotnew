import { MediaService, mediaSource } from "./media.ts";
import { createMediaAdmin } from "./media_admin.ts";
import { messageEvidence } from "./message_evidence.ts";
import { messageContent } from "./message_content.ts";
import { matchRules } from "./rules.ts";
import { Bot, GrammyError } from "grammy";
import type { ChatPermissions, User } from "grammy/types";
import { ChatQueue } from "./queue.ts";
import type { Config } from "./config.ts";
import type { Join, Store } from "./store.ts";
import { moderate } from "./moderation.ts";
import { createCheck } from "./check.ts";
import { createAdmin } from "./admin.ts";
import { moderationEligibility } from "./eligibility.ts";
import { fingerprint, Profiles, profileState } from "./profiles.ts";

const fullName = (user: User) =>
  [user.first_name, user.last_name].filter(Boolean).join(" ");
export function createBot(
  config: Config,
  store: Store,
  dependencies: { request?: typeof fetch; media?: MediaService } = {},
) {
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
  const request = dependencies.request ?? fetch;
  const profiles = new Profiles(bot.api, config, request);
  const admin = createAdmin(bot, config, store);
  const media = dependencies.media ??
    new MediaService(store.media, bot.api, config, request);
  createMediaAdmin(bot, store, media, admin);
  createCheck(bot, config, store, profiles, request, admin, media);
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
    if (after.status === "administrator" || after.status === "creator") {
      store.forgetReviewSender(event.chat.id, user.id);
      profiles.invalidate(user.id);
    }
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
        const message = await ctx.reply(
          `${name}，请在六分钟内验证您是人类：\nhttps://t.me/${bot.botInfo.username}?startapp=${join.id}`,
        );
        store.joinMessage(join.id, message.message_id);
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
    const content = messageContent(msg);
    const kind = content.kind;
    if (!msg.from) return;
    const eligibility = await moderationEligibility(
      bot.api,
      msg,
      bot.botInfo.id,
      config.owners,
    );
    if (!eligibility.allowed) {
      if (eligibility.protectedUser) {
        store.forgetReviewSender(ctx.chat.id, eligibility.protectedUser);
      }
      return;
    }
    let settings = admin.settings(ctx.chat.id);
    let recording = settings.review !== false && config.reviewDays > 0;
    if (
      settings.moderation === "off" && !recording &&
      !settings.rules?.some((rule) => rule.enabled) &&
      !settings.media?.image.enabled && !settings.media?.sticker.enabled
    ) return;
    const snapshotId = store.captureMessage(
      ctx.chat.id,
      msg.message_id,
      await fingerprint(msg),
      JSON.stringify(msg),
      JSON.stringify(ctx.update),
    );
    if (!kind) return;
    const text = content.text;
    const source = mediaSource(msg);
    if (source && settings.media?.[source.kind].enabled) {
      try {
        const match = await media.match(ctx.chat.id, source, settings.media);
        if (match) {
          const protectedNow = await moderationEligibility(
            bot.api,
            msg,
            bot.botInfo.id,
            config.owners,
          );
          if (!protectedNow.allowed) {
            if (protectedNow.protectedUser) {
              store.forgetReviewSender(ctx.chat.id, protectedNow.protectedUser);
            }
            return;
          }
          if (admin.settings(ctx.chat.id).revision !== settings.revision) {
            store.snapshotResult(snapshotId, "settings_changed");
            return;
          }
          let action = "media_observed";
          if (match.action !== "observe") {
            try {
              await ctx.deleteMessage();
              action = "media_deleted";
            } catch {
              action = "media_delete_failed";
            }
            if (match.action === "ban" || match.action === "mute") {
              const deleted = action === "media_deleted";
              try {
                if (match.action === "ban") {
                  await bot.api.banChatMember(ctx.chat.id, msg.from.id, {
                    until_date: 0,
                  });
                } else {
                  await bot.api.restrictChatMember(
                    ctx.chat.id,
                    msg.from.id,
                    {},
                    { use_independent_chat_permissions: true, until_date: 0 },
                  );
                }
                action = `media_${match.action === "ban" ? "banned" : "muted"}${
                  deleted ? "" : "_delete_failed"
                }`;
              } catch {
                action = `media_${
                  deleted ? "deleted_" : "delete_failed_"
                }${match.action}_failed`;
              }
            }
          }
          store.snapshotResult(snapshotId, action, match);
          store.groupEvent(ctx.chat.id, {
            event: "moderation",
            snapshot_id: snapshotId,
            message_id: msg.message_id,
            sender_id: msg.from.id,
            action,
            result: match,
          });
          return;
        }
      } catch {
        store.groupEvent(ctx.chat.id, {
          event: "media_error",
          message_id: msg.message_id,
          action: "fallback",
          reason: "媒体下载、首帧解码或PDQ计算失败；继续现有审核",
        });
      }
    }
    const hasRules = settings.rules?.some((rule) => rule.enabled);
    let context = await profiles.get(
      msg.from,
      !hasRules && settings.uploadAvatar !== false,
    );
    context.messageKind = kind;
    context.links = content.links;
    context.evidence = messageEvidence(
      msg,
      content,
      context.profile?.bio ?? undefined,
    );
    // Recheck after profile/file I/O: a newly promoted administrator is protected.
    const latest = await moderationEligibility(
      bot.api,
      msg,
      bot.botInfo.id,
      config.owners,
    );
    if (!latest.allowed) {
      if (latest.protectedUser) {
        store.forgetReviewSender(ctx.chat.id, latest.protectedUser);
      }
      return;
    }
    settings = admin.settings(ctx.chat.id);
    recording = settings.review !== false && config.reviewDays > 0;
    if (settings.uploadAvatar === false) {
      delete context.avatar;
      if (context.profile) context.profile.avatar_status = "disabled";
    }
    const ruleResult = await matchRules(settings.rules ?? [], {
      username: context.profile?.username ?? "",
      bio: context.profile?.bio_status === "unavailable"
        ? undefined
        : context.profile?.bio ?? "",
      message: text,
    });
    if (ruleResult.failed) {
      store.groupEvent(ctx.chat.id, {
        event: "rules_error",
        message_id: msg.message_id,
        action: "fallback_ai",
        reason: "正则执行超时或失败",
      });
    }
    if (
      !ruleResult.rule && hasRules && settings.uploadAvatar !== false &&
      settings.moderation !== "off" && text
    ) {
      context = {
        ...await profiles.get(msg.from, true),
        messageKind: kind,
        links: content.links,
      };
      context.evidence = messageEvidence(
        msg,
        content,
        context.profile?.bio ?? undefined,
      );
      const protectedNow = await moderationEligibility(
        bot.api,
        msg,
        bot.botInfo.id,
        config.owners,
      );
      if (!protectedNow.allowed) {
        if (protectedNow.protectedUser) {
          store.forgetReviewSender(ctx.chat.id, protectedNow.protectedUser);
        }
        return;
      }
    }
    const inputHash = await fingerprint({
      text,
      context: profileState(context),
    });
    const sample = recording
      ? store.recordReview({
        chat: ctx.chat.id,
        message: msg.message_id,
        sender: msg.from.id,
        kind,
        text,
        profile: JSON.stringify(profileState(context)),
        avatar: context.avatar,
        fingerprint: inputHash,
        date: msg.date * 1000,
        mode: settings.moderation,
      }, config)
      : undefined;
    store.snapshotContext(
      snapshotId,
      JSON.stringify(profileState(context)),
      sample,
    );
    const recordResult = (action: string, result?: unknown) => {
      store.reviewResult(sample, action, result);
      store.snapshotResult(snapshotId, action, result);
      store.groupEvent(ctx.chat.id, {
        event: "moderation",
        snapshot_id: snapshotId,
        action,
        message_id: msg.message_id,
        sender_id: msg.from!.id,
        text: text.slice(0, 500),
        ...(result ? { result } : {}),
      });
    };
    if (ruleResult.rule) {
      const member = await ctx.getChatMember(msg.from.id);
      if (["administrator", "creator"].includes(member.status)) {
        store.forgetReviewSender(ctx.chat.id, msg.from.id);
        return;
      }
      if (admin.settings(ctx.chat.id).revision !== settings.revision) {
        recordResult("settings_changed");
        return;
      }
      const rule = ruleResult.rule;
      const verdict = {
        label: rule.action === "allow" ? "normal" : "advertisement",
        certainty: "high",
        reason: `规则：${rule.name || rule.id}`,
        model: "local-regex",
        rule_id: rule.id,
      };
      if (rule.action === "allow") {
        recordResult("rule_allowed", verdict);
        return;
      }
      let deleted = true;
      try {
        await ctx.deleteMessage();
      } catch {
        deleted = false;
      }
      try {
        await bot.api.banChatMember(ctx.chat.id, msg.from.id, {
          until_date: 0,
        });
        recordResult(
          deleted ? "rule_banned" : "rule_banned_delete_failed",
          verdict,
        );
      } catch {
        recordResult("rule_ban_failed", verdict);
      }
      return;
    }
    if (admin.settings(ctx.chat.id).revision !== settings.revision) {
      recordResult("settings_changed");
      return;
    }
    if (
      settings.moderation === "off" ||
      (!text && !context.evidence?.contacts.length &&
        !context.evidence?.replies.length)
    ) return;
    try {
      const verdict = await moderate(
        config,
        store,
        ctx.chat.id,
        msg.message_id,
        text,
        request,
        context,
      );
      if (!verdict) {
        recordResult("quota_skipped");
        return;
      }
      recordResult(
        settings.moderation === "observe" ? "observed" : "kept",
        verdict,
      );
      if (verdict.label === "normal") return;
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
        ["delete", "mute", "ban"].includes(settings.moderation) &&
        verdict.certainty === "high" && verdict.label === "advertisement"
      ) {
        const member = await ctx.getChatMember(msg.from.id);
        if (["administrator", "creator"].includes(member.status)) {
          store.forgetReviewSender(ctx.chat.id, msg.from.id);
          return;
        }
        if (admin.settings(ctx.chat.id).revision !== settings.revision) {
          recordResult("settings_changed");
          return;
        }
        await ctx.deleteMessage();
        recordResult("deleted");
        if (settings.moderation === "ban") {
          try {
            await bot.api.banChatMember(ctx.chat.id, msg.from.id, {
              until_date: 0,
            });
            recordResult("banned");
          } catch {
            recordResult("deleted_ban_failed");
            console.error("广告已删除，封禁失败");
          }
        }
        if (settings.moderation === "mute") {
          try {
            await bot.api.restrictChatMember(ctx.chat.id, msg.from.id, {}, {
              use_independent_chat_permissions: true,
              until_date: 0,
            });
            recordResult("muted");
          } catch {
            recordResult("deleted_mute_failed");
            console.error("广告已删除，禁言失败");
          }
        }
      }
    } catch (error) {
      recordResult("provider_error");
      console.error(
        "审核未完成，保留消息",
        error instanceof Error ? error.name : "unknown error",
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
    store.pruneReview(config);
    store.pruneRawMessages();
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
    if (join.state === "done") {
      await cleanupJoinMessage(join);
      return;
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
        error instanceof GrammyError && [400, 403].includes(error.error_code) &&
        store.get(id)?.state !== "done"
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
    const completed = store.get(id);
    if (completed?.state === "done") await cleanupJoinMessage(completed);
  }
  async function cleanupJoinMessage(join: Join) {
    if (join.kind !== "direct" || join.message_id === null) return;
    try {
      await bot.api.deleteMessage(join.chat_id, join.message_id);
      store.joinMessage(join.id, null);
    } catch (error) {
      // Retry transient failures without restoring permissions or welcoming twice.
      if (
        error instanceof GrammyError && [400, 403].includes(error.error_code)
      ) {
        store.joinMessage(join.id, null);
      }
      console.error(JSON.stringify({
        event: "join_message_delete_failed",
        chat: join.chat_id,
        message: join.message_id,
        error: safeError(error),
      }));
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
