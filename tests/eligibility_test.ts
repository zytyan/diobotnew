import { moderationEligibility } from "../src/eligibility.ts";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
function assert(v: unknown): asserts v {
  if (!v) throw new Error("assertion failed");
}
const user = { id: 42, is_bot: false, first_name: "Member" };
const message: Message = {
  message_id: 1,
  date: 1,
  chat: { id: -1, type: "supergroup", title: "Group" },
  from: user,
  text: "test",
};
function api(status: string, linked: number | undefined = -100) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      getChatMember: () => {
        calls.push("role");
        return Promise.resolve({ status, user });
      },
      getChat: () => {
        calls.push("group");
        return Promise.resolve({ linked_chat_id: linked });
      },
    } as unknown as Pick<Api, "getChatMember" | "getChat">,
  };
}
Deno.test("上传前排除人类/bot 管理员，权限查询失败也不放行", async () => {
  for (const status of ["creator", "administrator"]) {
    const t = api(status);
    assert(
      !(await moderationEligibility(t.api, message, 99, new Set())).allowed,
    );
    assert(
      !(await moderationEligibility(
        t.api,
        { ...message, from: { ...user, is_bot: true } },
        99,
        new Set(),
      )).allowed,
    );
  }
  const broken = {
    getChatMember: () => Promise.reject(new Error("network")),
  } as unknown as Pick<Api, "getChatMember" | "getChat">;
  assert(
    !(await moderationEligibility(broken, message, 99, new Set())).allowed,
  );
  assert(
    (await moderationEligibility(api("member").api, message, 99, new Set()))
      .allowed,
  );
});
Deno.test("关联频道自动转发、匿名发送者和关联频道手动转发不上传", async () => {
  const t = api("member");
  assert(
    !(await moderationEligibility(
      t.api,
      { ...message, is_automatic_forward: true },
      99,
      new Set(),
    )).allowed,
  );
  assert(
    !(await moderationEligibility(
      t.api,
      {
        ...message,
        sender_chat: { id: -1, type: "supergroup", title: "Group" },
      },
      99,
      new Set(),
    )).allowed,
  );
  assert(t.calls.length === 0);
  const forward = {
    ...message,
    forward_origin: {
      type: "channel" as const,
      date: 1,
      chat: { id: -100, type: "channel" as const, title: "Linked" },
      message_id: 1,
    },
  };
  assert(!(await moderationEligibility(t.api, forward, 99, new Set())).allowed);
  assert(
    (await moderationEligibility(
      api("member", -200).api,
      forward,
      99,
      new Set(),
    )).allowed,
  );
});

Deno.test("转发匿名管理员或受保护账号也不得上传", async () => {
  const t = api("member");
  for (
    const forward_origin of [{
      type: "chat",
      date: 1,
      sender_chat: { id: -2, type: "supergroup", title: "Source" },
    }, {
      type: "user",
      date: 1,
      sender_user: { id: 7, is_bot: false, first_name: "Owner" },
    }] as const
  ) {
    assert(
      !(await moderationEligibility(
        t.api,
        { ...message, forward_origin },
        99,
        new Set([7]),
      )).allowed,
    );
  }
});
