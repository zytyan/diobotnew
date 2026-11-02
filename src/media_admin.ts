import type { Bot, Context } from "grammy";
import type { InputRichMessage } from "grammy/types";
import type { Store } from "./store.ts";
import { MediaService, type MediaSource, mediaSource } from "./media.ts";
import type { MediaEntry } from "./media_store.ts";

export function createMediaAdmin(
  bot: Bot,
  store: Store,
  service: MediaService,
  helpers: {
    panel: (ctx: Context, rich: InputRichMessage) => Promise<void>;
    isAdmin: (chat: number, user: number) => Promise<boolean>;
    settings: (chat: number) => { revision?: number };
  },
) {
  const reply = (ctx: Context, text: string) =>
    helpers.panel(ctx, {
      blocks: [{ type: "paragraph", text }],
      skip_entity_detection: true,
    });
  bot.command("blacklist", async (ctx) => {
    if (
      !["group", "supergroup"].includes(ctx.chat.type) || !ctx.from ||
      !await helpers.isAdmin(ctx.chat.id, ctx.from.id)
    ) return;
    const source = ctx.message?.reply_to_message &&
      mediaSource(ctx.message.reply_to_message);
    if (!source) {
      await reply(
        ctx,
        "请回复图片、图片文件或 sticker，再使用 /blacklist。查看和删除名单、启用及配置动作请打开 /settings。添加仅影响后续消息，不追溯处罚。",
      );
      return;
    }
    const id = crypto.randomUUID().replaceAll("-", "");
    store.db.prepare("DELETE FROM media_pending WHERE expires<=?").run(
      Date.now(),
    );
    store.db.prepare("INSERT INTO media_pending VALUES(?,?,?,?,?)").run(
      id,
      ctx.chat.id,
      ctx.from.id,
      JSON.stringify(source),
      Date.now() + 360_000,
    );
    const choices: [MediaEntry["type"], string][] = [[
      "unique",
      "加入 unique ID",
    ], ["pdq", "加入 PDQ Hash"]];
    if (source.kind === "sticker" && source.set) {
      choices.push(["set", "加入整个 sticker 组"]);
    }
    await helpers.panel(ctx, {
      blocks: [
        {
          type: "paragraph",
          text:
            "选择添加方式。仅添加本群名单，不立即处罚；默认关闭，请在 /settings 启用并选择动作。按钮六分钟内有效。",
        },
        ...choices.map(([type, text]) => ({
          type: "buttons" as const,
          buttons: [{ text, callback_data: `media:${type}:${id}` }],
        })),
      ],
    });
  });
  bot.on("callback_query:data", async (ctx, next) => {
    const match = /^media:(unique|pdq|set):([a-f0-9]{32})$/.exec(
      ctx.callbackQuery.data,
    );
    if (!match) return await next();
    await ctx.answerCallbackQuery().catch(() => {});
    if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
    const message = ctx.callbackQuery.message;
    if (
      !message || !("receiver_user" in message) ||
      message.receiver_user?.id !== ctx.from.id ||
      !("ephemeral_message_id" in message) || !message.ephemeral_message_id
    ) return;
    const pending = store.db.prepare("SELECT * FROM media_pending WHERE id=?")
      .get(match[2]);
    if (
      !pending || pending.chat_id !== ctx.chat.id ||
      pending.actor !== ctx.from.id || Number(pending.expires) <= Date.now()
    ) {
      await reply(ctx, "按钮已过期或不属于您，请重新回复媒体使用 /blacklist。");
      return;
    }
    if (!await helpers.isAdmin(ctx.chat.id, ctx.from.id)) {
      await reply(ctx, "您的群管理员权限已失效。");
      return;
    }
    const source = JSON.parse(String(pending.source)) as MediaSource;
    const type = match[1] as MediaEntry["type"];
    try {
      const computed = type === "pdq"
        ? await service.hash(source).catch(() => {
          throw new Error("媒体下载、首帧渲染或PDQ计算失败，请重试。");
        })
        : undefined;
      if (type === "set" && !source.set) throw new Error("该sticker没有所属组");
      if (!await helpers.isAdmin(ctx.chat.id, ctx.from.id)) {
        throw new Error("您的群管理员权限已失效");
      }
      if (Number(pending.expires) <= Date.now()) {
        throw new Error("按钮已过期，请重新使用 /blacklist");
      }
      const revision = helpers.settings(ctx.chat.id).revision!;
      const result = store.media.add(ctx.chat.id, ctx.from.id, {
        kind: source.kind,
        type,
        value: type === "pdq"
          ? computed!.hash
          : type === "set"
          ? source.set!
          : source.unique,
        aliases: source.aliases,
        quality: computed?.quality,
      }, revision);
      store.groupEvent(ctx.chat.id, {
        event: "media_blacklist_added",
        actor_id: ctx.from.id,
        entry_id: result.entry.id,
        type,
      });
      const policy = store.media.policies(ctx.chat.id)[source.kind];
      await reply(
        ctx,
        `${
          result.duplicate ? "该条目已存在" : "已加入本群黑名单"
        }：#${result.entry.id}\n${result.entry.type}：${result.entry.value}${
          computed
            ? "\nQuality：" + computed.quality +
              (computed.quality < policy.quality
                ? "，低于当前门槛，不参与匹配"
                : "")
            : ""
        }\n${
          policy.enabled ? "已启用；" : "当前尚未启用，请到 /settings 启用；"
        }仅影响后续消息。`,
      );
    } catch (error) {
      await reply(
        ctx,
        error instanceof Error ? error.message : "添加失败，请重试",
      );
    }
  });
}
