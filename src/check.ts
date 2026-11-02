import { messageEvidence } from "./message_evidence.ts";
import type { Message } from "grammy/types";
import { messageContent } from "./message_content.ts";
import { matchRules } from "./rules.ts";
import type { Bot, Context } from "grammy";
import type { InputRichMessage } from "grammy/types";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { Profiles } from "./profiles.ts";
import { moderate } from "./moderation.ts";
import { moderationEligibility } from "./eligibility.ts";
const statusNames: Record<string, string> = {
  available: "可见",
  disabled: "本群已关闭头像上传",
  empty: "为空",
  unavailable: "不可见",
  none_or_private: "无头像或不可见",
};
const names: Record<string, string> = {
  normal: "正常",
  advertisement: "垃圾广告（含诈骗）",
  scam: "垃圾广告（含诈骗）",
  uncertain: "不确定",
};
export function createCheck(
  bot: Bot,
  config: Config,
  store: Store,
  profiles: Profiles,
  request: typeof fetch,
  helpers: {
    panel: (ctx: Context, rich: InputRichMessage) => Promise<void>;
    isAdmin: (chat: number, user: number) => Promise<boolean>;
  },
) {
  bot.command("check", async (ctx) => {
    if (!["group", "supergroup"].includes(ctx.chat.type) || !ctx.from) return;
    const reply = (text: string) =>
      helpers.panel(ctx, {
        blocks: [{ type: "heading", size: 2, text: "AI 判断检查" }, {
          type: "paragraph",
          text,
        }],
        skip_entity_detection: true,
      });
    if (!await helpers.isAdmin(ctx.chat.id, ctx.from.id)) {
      await reply("只有本群管理员可以检查 AI 判断。");
      return;
    }
    let target: Message | undefined = ctx.message?.reply_to_message;
    if (!target || target.chat.id !== ctx.chat.id) {
      await reply(
        "请回复一条普通成员消息，再使用 /check。只检查判断，不执行删除；管理员、匿名及关联频道消息不上传。",
      );
      return;
    }
    const eligible = await moderationEligibility(
      bot.api,
      target,
      bot.botInfo.id,
      config.owners,
    );
    if (!eligible.allowed) {
      if (eligible.protectedUser) {
        store.forgetReviewSender(ctx.chat.id, eligible.protectedUser);
      }
      await reply(`已跳过，未上传。原因：${eligible.reason}。`);
      return;
    }
    const savedRaw = store.latestRawMessage(ctx.chat.id, target.message_id);
    if (savedRaw) {
      const saved = JSON.parse(savedRaw.message_json) as Message;
      if (
        saved.from?.id === target.from?.id && saved.text === target.text &&
        saved.caption === target.caption && saved.edit_date === target.edit_date
      ) {
        target = saved;
        const result = savedRaw.result_json
          ? JSON.parse(savedRaw.result_json)
          : undefined;
        if (result?.model === "local-regex" && result.rule_id) {
          const actions: Record<string, string> = {
            rule_allowed: "保留消息（直接放行）",
            rule_banned: "删除消息并封禁成员",
            rule_banned_delete_failed: "已封禁成员，消息删除失败",
            rule_ban_failed: "封禁失败",
          };
          if (actions[savedRaw.action]) {
            await reply(
              `已记录的正则匹配：${result.reason}\n规则 ID：${result.rule_id}\n处理结果：${
                actions[savedRaw.action]
              }\n未调用 AI。本次仅检查，未执行处罚。`,
            );
            return;
          }
        }
      }
    }
    const content = messageContent(target);
    const text = content.text;
    if (!content.kind || !target.from) {
      await reply("该消息没有可审核的文字或媒体说明。");
      return;
    }
    try {
      const rules = store.rules(ctx.chat.id);
      const hasRules = rules.some((rule) => rule.enabled);
      const context = await profiles.get(
        target.from,
        !hasRules && store.avatarEnabled(ctx.chat.id),
      );
      context.messageKind = content.kind;
      context.links = content.links;
      context.evidence = messageEvidence(
        target,
        content,
        context.profile?.bio ?? undefined,
      );
      const latest = await moderationEligibility(
        bot.api,
        target,
        bot.botInfo.id,
        config.owners,
      );
      if (!latest.allowed) {
        if (latest.protectedUser) {
          store.forgetReviewSender(ctx.chat.id, latest.protectedUser);
        }
        await reply(`已跳过，未上传。原因：${latest.reason}。`);
        return;
      }
      const local = await matchRules(rules, {
        username: context.profile?.username ?? "",
        bio: context.profile?.bio_status === "unavailable"
          ? undefined
          : context.profile?.bio ?? "",
        message: text,
      });
      if (local.rule) {
        await reply(
          `命中规则：${local.rule.name || local.rule.id}\n动作：${
            local.rule.action === "allow" ? "直接放行" : "直接封禁"
          }\n组内条件全部满足。未调用 AI。本次仅检查，未执行处罚。`,
        );
        return;
      }
      if (
        !text && !context.evidence.contacts.length &&
        !context.evidence.replies.length
      ) {
        await reply(
          "没有可审核的文字内容，且未命中自定义规则。图片本身不进行识图。",
        );
        return;
      }
      if (!config.cfAccount || !config.cfToken) {
        await reply("服务器尚未配置 Cloudflare AI。");
        return;
      }
      if (hasRules && store.avatarEnabled(ctx.chat.id)) {
        const withAvatar = await profiles.get(target.from, true);
        context.profile = withAvatar.profile;
        context.avatar = withAvatar.avatar;
        const latest = await moderationEligibility(
          bot.api,
          target,
          bot.botInfo.id,
          config.owners,
        );
        if (!latest.allowed) {
          if (latest.protectedUser) {
            store.forgetReviewSender(ctx.chat.id, latest.protectedUser);
          }
          await reply(`已跳过，未上传。原因：${latest.reason}。`);
          return;
        }
      }
      const verdict = await moderate(
        config,
        store,
        ctx.chat.id,
        target.message_id,
        text,
        request,
        context,
      );
      if (!verdict) {
        await reply("今日本地 AI 调用额度已用完，未取得判断。");
        return;
      }
      const probabilities = verdict.probabilities
        ? Object.entries(verdict.probabilities).map(([key, p]) =>
          `${names[key]}：${(p * 100).toFixed(1)}%`
        ).join("\n")
        : "该模型不返回各项概率。";
      await reply(
        `分类：${names[verdict.label]}\n置信级别：${
          verdict.certainty === "high" ? "达到处理阈值" : "低于处理阈值"
        }（阈值 ${
          ((store.groupThreshold(ctx.chat.id) ?? config.aiThreshold) * 100)
            .toFixed(1)
        }%）\n${probabilities}\n模型结果：${verdict.reason}\n消息：${
          text.slice(0, 400)
        }\n显示名：${context.profile?.display_name}\n用户名：${
          context.profile?.username ? "@" + context.profile.username : "无"
        }\nbio：${
          context.profile?.bio?.slice(0, 200) ||
          statusNames[context.profile?.bio_status ?? "unavailable"]
        }\n头像：${
          statusNames[context.profile?.avatar_status ?? "unavailable"]
        }\n回复上下文：${context.evidence.replies.length} 项；当前消息联系人：${context.evidence.contacts.length} 项\n当前群模式：${helpersMode()}。本次仅检查，未删除消息。模型概率不代表实际正确率。`,
      );
    } catch {
      await reply("AI 检查暂时失败，消息保留；请稍后重试。");
    }
    function helpersMode() {
      return store.db.prepare(
        "SELECT moderation FROM group_settings WHERE chat_id=?",
      ).get(ctx.chat.id)?.moderation ?? "off";
    }
  });
}
