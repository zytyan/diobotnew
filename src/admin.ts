import { Bot, type Context, GrammyError } from "grammy";
import type {
  InputRichBlock,
  InputRichMessage,
  RichMessageButton,
} from "grammy/types";
import type { Config } from "./config.ts";
import type { GroupSettings, SettingKey, Store, TreeAction } from "./store.ts";

const paragraph = (text: string): InputRichBlock => ({
  type: "paragraph",
  text,
});
const button = (
  text: string,
  data: string,
  danger = false,
): RichMessageButton => ({
  text,
  callback_data: data,
  style: danger ? "danger" : "primary",
});
const row = (...buttons: RichMessageButton[]): InputRichBlock => ({
  type: "buttons",
  buttons,
});
const labels: Record<SettingKey, string> = {
  verification: "入群人机验证",
  moderation: "AI 广告审核",
  welcome: "欢迎消息",
  kicked: "移出/封禁消息",
  leave: "离开消息",
  tree: "砍树提示",
};
export function createAdmin(bot: Bot, config: Config, store: Store) {
  function settings(chat: number): GroupSettings {
    return store.settings(chat, {
      verification: !!config.siteKey && !config.publicChats.has(chat),
      moderation: config.publicChats.has(chat) ? config.moderationMode : "off",
      welcome: true,
      kicked: true,
      leave: true,
      tree: true,
    });
  }
  async function isAdmin(chat: number, user: number, restrict = false) {
    const member = await bot.api.getChatMember(chat, user);
    return member.status === "creator" ||
      (member.status === "administrator" &&
        (!restrict || member.can_restrict_members));
  }
  async function panel(ctx: Context, rich: InputRichMessage) {
    if (
      !ctx.chat || !ctx.from || !["group", "supergroup"].includes(ctx.chat.type)
    ) return;
    const message = ctx.callbackQuery?.message;
    if (
      message && "ephemeral_message_id" in message &&
      message.ephemeral_message_id && "receiver_user" in message &&
      message.receiver_user?.id === ctx.from.id
    ) {
      await bot.api.editEphemeralMessageText(
        ctx.chat.id,
        ctx.from.id,
        message.ephemeral_message_id,
        rich,
      );
    } else {
      await bot.api.sendRichMessage(ctx.chat.id, rich, {
        ephemeral_message_parameters: {
          receiver_user_id: ctx.from.id,
          callback_query_id: ctx.callbackQuery?.id,
        },
        ...(ctx.message?.ephemeral_message_id
          ? {
            reply_parameters: {
              ephemeral_message_id: ctx.message.ephemeral_message_id,
            },
          }
          : {}),
      });
    }
  }
  function menu(
    chat: number,
    actor: number,
    notice?: string,
  ): InputRichMessage {
    const current = settings(chat);
    const blocks: InputRichBlock[] = [{
      type: "heading",
      size: 2,
      text: "群管理设置",
    }];
    if (notice) blocks.push(paragraph(notice));
    for (const key of Object.keys(labels) as SettingKey[]) {
      const value = key === "moderation"
        ? {
          off: "关闭",
          observe: "仅观察",
          delete: "自动删除",
        }[current.moderation]
        : current[key]
        ? "开启"
        : "关闭";
      blocks.push(
        row(
          button(
            `${labels[key]}：${value}`,
            `cfg:${actor}:${key}:${current.revision}`,
          ),
        ),
      );
    }
    blocks.push(
      paragraph(
        "点击切换，立即保存。AI 审核依次切换：关闭 → 仅观察 → 自动删除。没有发言检查。",
      ),
    );
    return { blocks, skip_entity_detection: true };
  }
  bot.command("settings", async (ctx) => {
    if (!["group", "supergroup"].includes(ctx.chat.type) || !ctx.from) return;
    if (!await isAdmin(ctx.chat.id, ctx.from.id)) {
      await panel(ctx, {
        blocks: [paragraph("只有当前群管理员可以配置本群。")],
      });
      return;
    }
    await panel(ctx, menu(ctx.chat.id, ctx.from.id));
  });
  bot.command("tree", async (ctx) => {
    if (!["group", "supergroup"].includes(ctx.chat.type) || !ctx.from) return;
    if (!await isAdmin(ctx.chat.id, ctx.from.id, true)) {
      await panel(ctx, { blocks: [paragraph("需要本群封禁成员权限。")] });
      return;
    }
    const root = Number(ctx.match.trim());
    if (!Number.isSafeInteger(root) || root <= 0) {
      await panel(ctx, {
        blocks: [
          paragraph(
            "用法：/tree 被永久封禁成员的用户ID。只处理其直接邀请的在群成员。",
          ),
        ],
      });
      return;
    }
    await offer(
      ctx.chat.id,
      ctx.from.id,
      root,
      `manual:${crypto.randomUUID()}`,
      ctx,
    );
  });
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("cfg:") && !data.startsWith("tree:")) {
      return await next();
    }
    await ctx.answerCallbackQuery().catch(() => {});
    if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
    const message = ctx.callbackQuery.message;
    if (
      !message || !("ephemeral_message_id" in message) ||
      !message.ephemeral_message_id || !("receiver_user" in message) ||
      message.receiver_user?.id !== ctx.from.id
    ) return;
    if (!await isAdmin(ctx.chat.id, ctx.from.id)) {
      await panel(ctx, { blocks: [paragraph("您的群管理员权限已失效。")] });
      return;
    }
    if (data.startsWith("cfg:")) {
      const [, actor, key, revision] = data.split(":");
      if (
        Number(actor) !== ctx.from.id || !Object.hasOwn(labels, key) ||
        !/^\d+$/.test(revision ?? "")
      ) return;
      const current = settings(ctx.chat.id);
      if (Number(revision) !== current.revision) {
        await panel(
          ctx,
          menu(ctx.chat.id, ctx.from.id, "设置已变更，已刷新，请重新操作。"),
        );
        return;
      }
      const field = key as SettingKey;
      const value = field === "moderation"
        ? ({ off: "observe", observe: "delete", delete: "off" } as const)[
          current.moderation
        ]
        : !current[field];
      if (
        field === "moderation" && value !== "off" &&
        (!config.cfAccount || !config.cfToken)
      ) {
        await panel(
          ctx,
          menu(
            ctx.chat.id,
            ctx.from.id,
            "服务端尚未配置 AI 凭据，无法开启审核。",
          ),
        );
        return;
      }
      if (
        field === "verification" && value &&
        (!config.siteKey || !config.secret || !config.verifyHostname)
      ) {
        await panel(
          ctx,
          menu(ctx.chat.id, ctx.from.id, "服务端尚未配置人机验证，无法开启。"),
        );
        return;
      }
      store.updateSetting(ctx.chat.id, field, value, Number(revision));
      await panel(ctx, menu(ctx.chat.id, ctx.from.id, "已保存。"));
      return;
    }
    const [, operation, id] = data.split(":");
    const action = store.treeAction(id);
    if (
      !action || action.chat_id !== ctx.chat.id ||
      action.actor_id !== ctx.from.id || action.expires <= Date.now()
    ) {
      await panel(ctx, {
        blocks: [paragraph("操作已过期或不属于您，请重新使用 /tree。")],
      });
      return;
    }
    if (!await isAdmin(ctx.chat.id, ctx.from.id, true)) {
      await panel(ctx, { blocks: [paragraph("您没有封禁成员权限。")] });
      return;
    }
    if (operation === "cancel") {
      store.treeState(id, "offered", "cancelled");
      store.treeState(id, "confirm", "cancelled");
      await panel(ctx, { blocks: [paragraph("已取消，不会封禁邀请成员。")] });
      return;
    }
    if (operation === "preview" && store.previewTree(id)) {
      const children = store.invitees(action.chat_id, action.root_id);
      await panel(ctx, {
        blocks: [
          paragraph(
            `确认永久封禁 ${children.length} 位直接邀请的在群成员？不递归处理下一层，不处理群管理员。`,
          ),
          paragraph(
            children.slice(0, 20).map((c) => `${c.name} (${c.user_id})`).join(
              "\n",
            ) || "当前没有符合条件的成员。",
          ),
          row(
            button("确认封禁", `tree:run:${id}`, true),
            button("取消", `tree:cancel:${id}`),
          ),
        ],
        skip_entity_detection: true,
      });
      return;
    }
    if (operation === "run" && action.state === "confirm") {
      if (
        !await permanentlyBanned(action.chat_id, action.root_id) ||
        !settings(action.chat_id).tree
      ) {
        await panel(ctx, {
          blocks: [
            paragraph("原成员已解除永久封禁，或砍树功能已关闭；未执行。"),
          ],
        });
        return;
      }
      if (store.startTree(id)) {
        await panel(ctx, {
          blocks: [
            paragraph("已加入处理队列。执行前会再次检查权限和成员身份。"),
            row(button("查看进度", `tree:status:${id}`)),
          ],
        });
        return;
      }
    }
    const counts = store.treeCounts(id);
    await panel(ctx, {
      blocks: [
        paragraph(
          `状态：${store.treeAction(id)?.state}；已封禁 ${
            counts.banned ?? 0
          }，跳过 ${counts.skipped ?? 0}，失败 ${counts.failed ?? 0}，待处理 ${
            counts.pending ?? 0
          }。`,
        ),
        row(button("刷新进度", `tree:status:${id}`)),
      ],
    });
  });
  async function permanentlyBanned(chat: number, user: number) {
    const member = await bot.api.getChatMember(chat, user);
    return member.status === "kicked" && member.until_date === 0;
  }
  async function offer(
    chat: number,
    actor: number,
    root: number,
    event: string,
    ctx?: Context,
  ) {
    if (!settings(chat).tree) {
      if (ctx) {
        await panel(ctx, {
          blocks: [paragraph("砍树提示已关闭，请先通过 /settings 开启。")],
        });
      }
      return;
    }
    if (!await isAdmin(chat, actor, true)) return;
    if (!await permanentlyBanned(chat, root)) {
      if (ctx) {
        await panel(ctx, {
          blocks: [paragraph("该成员当前不是永久封禁状态，未执行。")],
        });
      }
      return;
    }
    const children = store.invitees(chat, root);
    if (!children.length) {
      if (ctx) {
        await panel(ctx, {
          blocks: [
            paragraph(
              "未记录到该成员直接邀请的在群成员。只能追踪本版本运行后观察到的直接邀请。",
            ),
          ],
        });
      }
      return;
    }
    const action = store.offerTree(chat, actor, root, event);
    if (!action) return;
    const rich: InputRichMessage = {
      blocks: [
        paragraph(
          `成员 ${root} 已被永久封禁。记录到其直接邀请的 ${children.length} 位成员仍在本群，是否查看并处理？`,
        ),
        row(
          button("查看名单", `tree:preview:${action.id}`),
          button("忽略", `tree:cancel:${action.id}`),
        ),
      ],
      skip_entity_detection: true,
    };
    if (ctx) await panel(ctx, rich);
    else {await bot.api.sendRichMessage(chat, rich, {
        ephemeral_message_parameters: { receiver_user_id: actor },
      });}
  }
  async function processTree(action: TreeAction) {
    if (
      !settings(action.chat_id).tree ||
      !await isAdmin(action.chat_id, action.actor_id, true) ||
      !await permanentlyBanned(action.chat_id, action.root_id)
    ) {
      store.finishTree(action.id, "cancelled");
      return;
    }
    const current = new Set(
      store.invitees(action.chat_id, action.root_id).map((c) => c.user_id),
    );
    for (const user of store.treePending(action.id)) {
      if (
        !current.has(user) || user === bot.botInfo.id ||
        user === action.actor_id
      ) {
        store.treeResult(action.id, user, "skipped");
        continue;
      }
      try {
        const member = await bot.api.getChatMember(action.chat_id, user);
        if (
          ["creator", "administrator", "left", "kicked"].includes(
            member.status,
          ) || (member.status === "restricted" && !member.is_member)
        ) {
          store.treeResult(action.id, user, "skipped");
          continue;
        }
        await bot.api.banChatMember(action.chat_id, user);
        store.treeResult(action.id, user, "banned");
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 429) return;
        if (
          error instanceof GrammyError && [400, 403].includes(error.error_code)
        ) {
          store.treeResult(action.id, user, "failed");
          continue;
        }
        return;
      }
    }
    if (!store.treePending(action.id).length) store.finishTree(action.id);
  }
  return { settings, offer, processTree };
}
