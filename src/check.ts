import type { Bot, Context } from "grammy";
import type { InputRichMessage } from "grammy/types";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { Profiles } from "./profiles.ts";
import { moderate } from "./moderation.ts";
import { moderationEligibility } from "./eligibility.ts";
const statusNames: Record<string, string> = {
  available: "可见",
  empty: "为空",
  unavailable: "不可见",
  none_or_private: "无头像或不可见",
};
const names: Record<string, string> = {
  normal: "正常",
  advertisement: "广告",
  scam: "诈骗/非法资金推广",
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
    const target = ctx.message?.reply_to_message;
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
    const text = target.text ?? target.caption;
    if (!text?.trim() || !target.from) {
      await reply("该消息没有可审核的文字或媒体说明。");
      return;
    }
    if (!config.cfAccount || !config.cfToken) {
      await reply("服务器尚未配置 Cloudflare AI。");
      return;
    }
    try {
      const context = await profiles.get(target.from);
      context.messageKind = target.text !== undefined ? "text" : "caption";
      context.links = (target.entities ?? target.caption_entities)?.flatMap(
        (e) => e.type === "text_link" ? [e.url] : [],
      ).slice(0, 8);
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
          (config.aiThreshold * 100).toFixed(1)
        }%）\n${probabilities}\n模型结果：${verdict.reason}\n消息：${
          text.slice(0, 400)
        }\n显示名：${context.profile?.display_name}\n用户名：${
          context.profile?.username ? "@" + context.profile.username : "无"
        }\nbio：${
          context.profile?.bio?.slice(0, 200) ||
          statusNames[context.profile?.bio_status ?? "unavailable"]
        }\n头像：${
          statusNames[context.profile?.avatar_status ?? "unavailable"]
        }\n当前群模式：${helpersMode()}。本次仅检查，未删除消息。模型概率不代表实际正确率。`,
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
