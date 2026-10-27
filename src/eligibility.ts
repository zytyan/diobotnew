import type { Api } from "grammy";
import type { Message } from "grammy/types";

export interface Eligibility {
  allowed: boolean;
  reason?: string;
  protectedUser?: number;
}
const roles = new Set([
  "creator",
  "administrator",
  "member",
  "restricted",
  "left",
  "kicked",
]);
export async function moderationEligibility(
  api: Pick<Api, "getChatMember" | "getChat">,
  message: Message,
  self: number,
  owners: Set<number>,
): Promise<Eligibility> {
  // Never infer the real person behind anonymous admin/channel messages.
  if (
    message.sender_chat || message.is_automatic_forward ||
    message.forward_origin?.type === "chat"
  ) {
    return { allowed: false, reason: "channel_or_anonymous" };
  }
  if (
    !message.from || message.from.id === self || owners.has(message.from.id) ||
    message.ephemeral_message_id
  ) return { allowed: false, reason: "protected_sender" };
  try {
    const member = await api.getChatMember(message.chat.id, message.from.id);
    if (!roles.has(member.status)) {
      return { allowed: false, reason: "unknown_role" };
    }
    if (member.status === "creator" || member.status === "administrator") {
      return {
        allowed: false,
        reason: "administrator",
        protectedUser: message.from.id,
      };
    }
    const origin = message.forward_origin;
    if (origin?.type === "channel") {
      const group = await api.getChat(message.chat.id);
      if (!("linked_chat_id" in group)) {
        return { allowed: false, reason: "linked_channel_unknown" };
      }
      if (group.linked_chat_id === origin.chat.id) {
        return { allowed: false, reason: "linked_channel" };
      }
    }
    if (origin?.type === "hidden_user") {
      return { allowed: false, reason: "unattributed_forward" };
    }
    if (origin?.type === "user") {
      if (origin.sender_user.id === self || owners.has(origin.sender_user.id)) {
        return { allowed: false, reason: "forwarded_protected_sender" };
      }
      const author = await api.getChatMember(
        message.chat.id,
        origin.sender_user.id,
      );
      if (!roles.has(author.status)) {
        return { allowed: false, reason: "unknown_forward_role" };
      }
      if (author.status === "creator" || author.status === "administrator") {
        return {
          allowed: false,
          reason: "forwarded_administrator",
          protectedUser: origin.sender_user.id,
        };
      }
    }
    return { allowed: true };
  } catch {
    // An unavailable membership API must not turn into an accidental upload.
    return { allowed: false, reason: "eligibility_unavailable" };
  }
}
