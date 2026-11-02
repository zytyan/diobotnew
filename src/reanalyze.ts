import { Buffer } from "node:buffer";
import type { Message } from "grammy/types";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { SettingsDependencies } from "./web_settings.ts";
import type {
  AvatarImage,
  ModerationContext,
  SenderProfile,
} from "./profiles.ts";
import { moderationEligibility } from "./eligibility.ts";
import { messageContent } from "./message_content.ts";
import { messageEvidence } from "./message_evidence.ts";
import { moderate } from "./moderation.ts";

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function reanalyze(
  config: Config,
  store: Store,
  dependencies: SettingsDependencies,
  chat: number,
  actor: number,
  id: number,
): Promise<Response> {
  const snapshot = store.rawMessage(chat, id);
  if (!snapshot) return json(404, { error: "原始消息不存在或已过期" });
  if (!config.cfAccount || !config.cfToken) {
    return json(400, { error: "尚未配置 Cloudflare AI" });
  }
  const message = JSON.parse(snapshot.message_json) as Message;
  const eligible = await moderationEligibility(
    dependencies.api,
    message,
    dependencies.botId,
    config.owners,
  );
  if (!eligible.allowed) {
    return json(403, {
      error: "该原始消息当前受保护，未上传 AI：" + eligible.reason,
    });
  }
  const content = messageContent(message);
  const saved = JSON.parse(snapshot.context_json);
  const profile: SenderProfile = saved.sender ?? {
    display_name: [message.from?.first_name, message.from?.last_name].filter(
      Boolean,
    ).join(" "),
    username: message.from?.username ?? null,
    is_bot: message.from?.is_bot,
    bio: null,
    bio_status: "unavailable",
    avatar_status: "unavailable",
  };
  const context: ModerationContext = {
    profile,
    messageKind: content.kind,
    links: content.links,
    evidence: messageEvidence(message, content, profile.bio ?? undefined),
  };
  if (store.avatarEnabled(chat)) {
    const avatar = store.db.prepare(
      "SELECT a.hash,a.mime,a.bytes FROM snapshot_reviews s JOIN review_messages m ON m.id=s.review_id JOIN review_avatars a ON a.hash=m.avatar_hash WHERE s.snapshot_id=? LIMIT 1",
    ).get(id);
    if (
      avatar &&
      ["image/jpeg", "image/png", "image/webp"].includes(String(avatar.mime))
    ) {
      const bytes = avatar.bytes as Uint8Array;
      context.avatar = {
        hash: String(avatar.hash),
        mime: avatar.mime as AvatarImage["mime"],
        bytes,
        base64: Buffer.from(bytes).toString("base64"),
      };
    }
  }
  const verdict = await moderate(
    config,
    store,
    chat,
    message.message_id,
    content.text,
    dependencies.request ?? fetch,
    context,
    { force: true },
  );
  if (!verdict) return json(429, { error: "今日 AI 调用额度已用完" });
  store.groupEvent(chat, {
    event: "reanalysis",
    actor_id: actor,
    snapshot_id: id,
    message_id: message.message_id,
    result: verdict,
    action_applied: false,
  });
  return json(200, {
    snapshot_id: id,
    verdict,
    threshold: store.groupThreshold(chat) ?? config.aiThreshold,
    action_applied: false,
    message: "重新分析完成，仅检查，未执行处罚；原始判断仍保留。",
  });
}
