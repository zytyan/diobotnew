import { reanalyze } from "./reanalyze.ts";
import { validateRules } from "./rules.ts";
import type { Api } from "grammy";
import { telegramIdentity } from "./auth.ts";
import type { Config } from "./config.ts";
import { groupSettings } from "./settings.ts";
import type { GroupSettings, Store } from "./store.ts";

export interface SettingsDependencies {
  request?: typeof fetch;
  api: Pick<Api, "getChatMember" | "getChat">;
  botId: number;
}
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const booleanKeys = [
  "verification",
  "welcome",
  "kicked",
  "leave",
  "tree",
  "review",
] as const;

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("缺少设置内容");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 131072) {
      await reader.cancel();
      throw new Error("请求内容过大");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function settingsHandler(
  config: Config,
  store: Store,
  dependencies: SettingsDependencies,
  mode: "settings" | "logs" | "raw" | "reanalyze" = "settings",
) {
  return async (request: Request): Promise<Response> => {
    if (
      !(mode === "reanalyze" ? ["POST"] : ["GET", "PUT"]).includes(
        request.method,
      )
    ) {
      return json(405, { error: "不支持的请求方式" });
    }
    const header = request.headers.get("Authorization") ?? "";
    let user: number, chat: number;
    try {
      if (!header.startsWith("Telegram ") || header.length > 16384) {
        throw new Error();
      }
      const auth = await telegramIdentity(header.slice(9), config.token);
      const context = /^(settings|logs)_(-[1-9]\d*)$/.exec(auth.start);
      if (!context || (mode === "settings" && context[1] !== "settings")) {
        throw new Error();
      }
      user = auth.user;
      chat = Number(context[2]);
      if (!Number.isSafeInteger(chat)) throw new Error();
    } catch {
      return json(401, {
        error: "身份信息无效或已过期，请返回群内 /settings 重新打开",
      });
    }
    try {
      // Both identity and target group come from signed Telegram initData.
      // Always refresh roles: an old open page must not retain revoked privileges.
      // grammY's npm typings use the abort-controller polyfill; node-fetch also
      // accepts Deno's native AbortSignal at runtime.
      const signal = AbortSignal.timeout(8_000) as unknown as NonNullable<
        Parameters<Api["getChatMember"]>[2]
      >;
      const [member, bot, info] = await Promise.all([
        dependencies.api.getChatMember(chat, user, signal),
        dependencies.api.getChatMember(chat, dependencies.botId, signal),
        dependencies.api.getChat(chat, signal),
      ]);
      if (
        !["creator", "administrator"].includes(member.status) ||
        bot.status !== "administrator" ||
        !["group", "supergroup"].includes(info.type)
      ) {
        return json(403, {
          error: "仅本群管理员可管理，且机器人必须是本群管理员",
        });
      }
      if (mode === "reanalyze") {
        let body: unknown;
        try {
          body = await readBody(request);
        } catch {
          return json(400, { error: "请求格式错误" });
        }
        if (
          !body || typeof body !== "object" || Object.keys(body).length !== 1 ||
          !("snapshot_id" in body) || !Number.isSafeInteger(body.snapshot_id) ||
          Number(body.snapshot_id) <= 0
        ) return json(400, { error: "样本编号无效" });
        return await reanalyze(
          config,
          store,
          dependencies,
          chat,
          user,
          Number(body.snapshot_id),
        );
      }
      if (mode === "raw") {
        if (request.method !== "GET") {
          return json(405, { error: "原始消息仅支持读取" });
        }
        const id = Number(new URL(request.url).searchParams.get("id"));
        if (!Number.isSafeInteger(id) || id <= 0) {
          return json(400, { error: "样本编号无效" });
        }
        const snapshot = store.rawMessage(chat, id);
        if (!snapshot) return json(404, { error: "原始消息不存在或已过期" });
        return json(200, {
          id: snapshot.id,
          chat_id: chat,
          message_id: snapshot.message_id,
          captured_at: snapshot.seen_at,
          version_hash: snapshot.version_hash,
          message: JSON.parse(snapshot.message_json),
          update: JSON.parse(snapshot.update_json),
          context: JSON.parse(snapshot.context_json),
          original_result: snapshot.result_json
            ? JSON.parse(snapshot.result_json)
            : null,
          original_action: snapshot.action,
        });
      }
      if (mode === "logs") {
        if (request.method !== "GET") {
          return json(405, { error: "日志页面只支持读取" });
        }
        return json(200, {
          userId: user,
          chat: { id: chat, title: "title" in info ? info.title : "" },
          logs: store.groupLogs(chat),
        });
      }
      const current = groupSettings(config, store, chat);
      if (request.method === "PUT") {
        let value: Record<string, unknown>;
        try {
          const body = await readBody(request);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("设置格式无效");
          }
          value = body as Record<string, unknown>;
          const allowed = [
            ...booleanKeys,
            "rules",
            "uploadAvatar",
            "moderation",
            "aiThreshold",
            "revision",
          ];
          if (
            Object.keys(value).some((key) =>
              !allowed.includes(key as typeof allowed[number])
            )
          ) throw new Error("含有不支持的参数");
          if (
            booleanKeys.some((key) => typeof value[key] !== "boolean") ||
            (value.uploadAvatar !== undefined &&
              typeof value.uploadAvatar !== "boolean") ||
            typeof value.moderation !== "string" ||
            !["off", "observe", "delete", "mute", "ban"].includes(
              String(value.moderation),
            ) ||
            typeof value.aiThreshold !== "number" ||
            !Number.isFinite(value.aiThreshold) || value.aiThreshold < .5 ||
            value.aiThreshold > 1 ||
            !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
          ) throw new Error("参数无效：阈值须为50%至100%，开关须为布尔值");
          if (value.rules !== undefined) {
            value.rules = validateRules(value.rules);
          }
          if (
            value.verification &&
            (!config.siteKey || !config.secret || !config.verifyHostname)
          ) throw new Error("服务端尚未配置入群验证");
          if (
            value.moderation !== "off" && (!config.cfAccount || !config.cfToken)
          ) throw new Error("服务端尚未配置 AI 凭据");
          if (value.review && config.reviewDays === 0) {
            throw new Error("服务端已关闭样本留存");
          }
        } catch (error) {
          return json(400, {
            error: error instanceof SyntaxError
              ? "请求格式错误"
              : error instanceof Error
              ? error.message
              : "参数无效",
          });
        }
        if (value.revision !== current.revision) {
          return json(409, {
            error: "设置已被其他管理员修改，请重新加载后保存",
          });
        }
        if (
          value.rules !== undefined &&
          JSON.stringify(value.rules) !== JSON.stringify(current.rules) &&
          (value.rules as { enabled: boolean; action: string }[]).some((rule) =>
            rule.enabled && rule.action === "ban"
          ) && !bot.can_restrict_members
        ) return json(403, { error: "黑名单封禁需要机器人限制成员权限" });
        const changes = value.moderation !== current.moderation ||
          value.aiThreshold !== (current.aiThreshold ?? config.aiThreshold);
        if (
          changes &&
          ["delete", "mute", "ban"].includes(String(value.moderation)) &&
          !bot.can_delete_messages
        ) return json(403, { error: "机器人缺少删除消息权限" });
        if (
          changes && value.moderation === "ban" && !bot.can_restrict_members
        ) return json(403, { error: "封禁模式需要机器人限制成员权限" });
        if (
          changes && value.moderation === "mute" &&
          (info.type !== "supergroup" || !bot.can_restrict_members)
        ) return json(403, { error: "禁言模式需要超级群及机器人限制成员权限" });
        if (
          !store.saveSettings(
            chat,
            value as unknown as GroupSettings,
            Number(value.revision),
          )
        ) return json(409, { error: "设置已变更，请重新加载" });
      }
      if (request.method === "PUT") {
        store.groupEvent(chat, {
          event: "settings_saved",
          actor_id: user,
          revision: groupSettings(config, store, chat).revision,
        });
      }
      const updated = groupSettings(config, store, chat);
      return json(200, {
        userId: user,
        chat: { id: chat, title: "title" in info ? info.title : "" },
        settings: {
          ...updated,
          aiThreshold: updated.aiThreshold ?? config.aiThreshold,
        },
        capabilities: {
          verification: !!config.siteKey && !!config.secret &&
            !!config.verifyHostname,
          ai: !!config.cfAccount && !!config.cfToken,
          review: config.reviewDays > 0,
        },
        limits: {
          dailyRequests: config.aiDailyLimit,
          reviewDays: config.reviewDays,
          reviewPerChat: config.reviewPerChat,
        },
      });
    } catch {
      return json(503, {
        error: mode === "logs"
          ? "暂时无法确认群权限或读取日志，请稍后重试"
          : mode === "reanalyze"
          ? "AI重新分析失败，原始消息和历史判断已保留，请稍后重试"
          : "暂时无法确认群权限或保存设置，请稍后重试",
      });
    }
  };
}
