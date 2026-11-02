import { Bot, type Context, InputFile } from "grammy";
import type {
  InputRichBlock,
  InputRichMessage,
  RichMessageButton,
} from "grammy/types";
import type { Config } from "./config.ts";
import type { ReviewRow, Store } from "./store.ts";
interface Helpers {
  panel: (ctx: Context, rich: InputRichMessage) => Promise<void>;
  isAdmin: (chat: number, user: number) => Promise<boolean>;
}
const names: Record<string, string> = {
  normal: "正常",
  advertisement: "垃圾广告（含诈骗）",
  scam: "垃圾广告（含诈骗）",
  uncertain: "不确定",
};
const paragraph = (text: string): InputRichBlock => ({
  type: "paragraph",
  text,
});
function button(text: string, data: string): RichMessageButton {
  return { text, callback_data: data };
}
export function createReview(
  bot: Bot,
  config: Config,
  store: Store,
  helpers: Helpers,
) {
  async function show(ctx: Context, notice?: string) {
    if (!ctx.chat || !ctx.from) return;
    store.pruneReview(config);
    const rows = store.recentReviews(ctx.chat.id, 5);
    const blocks: InputRichBlock[] = [
      { type: "heading", size: 2, text: "近期审核样本" },
      paragraph(
        `本地保留 ${config.reviewDays} 天，每群最多 ${config.reviewPerChat} 条。标注仅用于人工复核，不会自动训练或上传历史。`,
      ),
    ];
    if (notice) blocks.push(paragraph(notice));
    for (const sample of rows) {
      const data = JSON.parse(sample.profile_json);
      const sender = data.sender ?? {};
      const result = sample.result_json ? JSON.parse(sample.result_json) : null;
      blocks.push(
        paragraph(
          `#${sample.id} · ${new Date(sample.seen_at).toISOString()}\n${
            sender.display_name ?? sample.sender_id
          }${sender.username ? " @" + sender.username : ""}\n消息：${
            sample.text.slice(0, 450) || `[${sample.kind}，无文字]`
          }\nbio：${
            sender.bio === null || sender.bio === undefined
              ? "不可见"
              : String(sender.bio).slice(0, 200) || "空"
          }\n模型：${
            result
              ? `${names[result.label] ?? result.label} ${
                typeof result.score === "number"
                  ? (result.score * 100).toFixed(1) + "%"
                  : ""
              }`
              : "未调用"
          }；处理：${sample.action}\n人工标注：${
            sample.human_label ? names[sample.human_label] : "未标注"
          }`,
        ),
      );
      const options: RichMessageButton[] = [
        button("正常/误判", `rev:${ctx.from.id}:${sample.id}:normal`),
        button(
          "垃圾广告（含诈骗）",
          `rev:${ctx.from.id}:${sample.id}:advertisement`,
        ),
        button("不确定", `rev:${ctx.from.id}:${sample.id}:uncertain`),
      ];
      if (sample.avatar_hash) {
        options.push(
          button("查看当时头像", `rev:${ctx.from.id}:${sample.id}:avatar`),
        );
      }
      blocks.push({ type: "buttons", buttons: options });
    }
    if (!rows.length) {
      blocks.push(
        paragraph(
          "还没有可复核的普通成员样本。管理员、匿名消息、关联频道不采集。",
        ),
      );
    }
    blocks.push({
      type: "buttons",
      buttons: [button("刷新", `rev:${ctx.from.id}:0:refresh`)],
    });
    await helpers.panel(ctx, { blocks, skip_entity_detection: true });
  }
  bot.command("review", async (ctx) => {
    if (
      !ctx.chat || !["group", "supergroup"].includes(ctx.chat.type) || !ctx.from
    ) return;
    if (!await helpers.isAdmin(ctx.chat.id, ctx.from.id)) {
      await helpers.panel(ctx, {
        blocks: [paragraph("只有本群管理员可以查看样本。")],
      });
      return;
    }
    await show(ctx);
  });
  bot.on("callback_query:data", async (ctx, next) => {
    if (!ctx.callbackQuery.data.startsWith("rev:")) return await next();
    await ctx.answerCallbackQuery().catch(() => {});
    const message = ctx.callbackQuery.message;
    if (
      !ctx.chat || !message || !("ephemeral_message_id" in message) ||
      !message.ephemeral_message_id || !("receiver_user" in message) ||
      message.receiver_user?.id !== ctx.from.id
    ) return;
    if (!await helpers.isAdmin(ctx.chat.id, ctx.from.id)) return;
    const [, actor, id, action] = ctx.callbackQuery.data.split(":");
    if (Number(actor) !== ctx.from.id || !/^\d+$/.test(id ?? "")) return;
    if (action === "refresh") {
      await show(ctx);
      return;
    }
    const sample = store.db.prepare(
      "SELECT * FROM review_messages WHERE id=? AND chat_id=?",
    ).get(Number(id), ctx.chat.id) as unknown as ReviewRow | undefined;
    if (!sample) {
      await show(ctx, "样本已过期或已移除。");
      return;
    }
    if (action === "avatar") {
      const avatar = sample.avatar_hash
        ? store.reviewAvatar(sample.avatar_hash)
        : undefined;
      if (!avatar) {
        await show(ctx, "该头像已清理或未留存。");
        return;
      }
      await bot.api.sendPhoto(
        ctx.chat.id,
        new InputFile(
          avatar.bytes,
          "avatar." +
            (avatar.mime === "image/png"
              ? "png"
              : avatar.mime === "image/webp"
              ? "webp"
              : "jpg"),
        ),
        {
          caption: `样本 #${sample.id} 当时的头像缩略图`,
          ephemeral_message_parameters: {
            receiver_user_id: ctx.from.id,
            callback_query_id: ctx.callbackQuery.id,
          },
        },
      );
      return;
    }
    if (!Object.hasOwn(names, action)) return;
    store.labelReview(sample.id, ctx.chat.id, action, ctx.from.id);
    await show(ctx, `样本 #${sample.id} 已标记为${names[action]}。`);
  });
}
