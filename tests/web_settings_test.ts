import type { Api } from "grammy";
import { telegramAuth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { moderate } from "../src/moderation.ts";
import { createHandler } from "../src/server.ts";
import { groupSettings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const token = "99:fake";
async function signed(start = "settings_-1", user = 42, age = 0) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id: user }),
    start_param: start,
  });
  const encode = new TextEncoder();
  async function hmac(key: Uint8Array, text: string) {
    const k = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", k, encode.encode(text)),
    );
  }
  const secret = await hmac(encode.encode("WebAppData"), token);
  const hash = await hmac(
    secret,
    [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  params.set(
    "hash",
    [...hash].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  return params.toString();
}
function setup(
  path = ":memory:",
  env: Record<string, string> = {},
  request?: typeof fetch,
) {
  const config = loadConfig({
    BOT_TOKEN: token,
    TELEGRAM_ENV: "test",
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "secret-ai-token",
    TURNSTILE_SITE_KEY: "key",
    TURNSTILE_SECRET: "secret-turnstile",
    VERIFY_HOSTNAME: "example.com",
    ...env,
  });
  const store = new Store(path);
  const state = {
    role: "administrator",
    botRole: "administrator",
    fail: false,
    delete: true,
    restrict: true,
  };
  const lookups: number[] = [];
  const memberRoles = new Map<number, string>();
  const api = {
    getChatMember(chat: number, user: number) {
      lookups.push(chat);
      if (state.fail) throw new Error("unavailable");
      return Promise.resolve({
        status: user === 99
          ? state.botRole
          : memberRoles.has(user)
          ? memberRoles.get(user)!
          : chat === -1
          ? state.role
          : "member",
        can_delete_messages: state.delete,
        can_restrict_members: state.restrict,
      });
    },
    getChat(chat: number) {
      return Promise.resolve({ id: chat, type: "supergroup", title: "Test" });
    },
  } as unknown as Pick<Api, "getChatMember" | "getChat">;
  const handler = createHandler(config, store, "page", fetch, {
    api,
    botId: 99,
    request,
  });
  async function call(auth: string, body?: unknown) {
    return await handler(
      new Request("http://localhost/api/settings", {
        method: body === undefined ? "GET" : "PUT",
        headers: { Authorization: "Telegram " + auth },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
  }
  return { config, store, state, lookups, handler, call, memberRoles };
}
const values = {
  verification: false,
  welcome: true,
  kicked: true,
  leave: false,
  tree: false,
  review: true,
  moderation: "mute",
  aiThreshold: .75,
  revision: 0,
};

Deno.test("Web 设置验证签名群上下文，拒绝未签名、过期、跨群和普通成员，撤权立即失效", async () => {
  const t = setup();
  try {
    const auth = await signed();
    assert((await t.call("")).status === 401);
    assert((await t.call(await signed("settings_-1", 42, 301))).status === 401);
    assert(
      (await t.call(auth.replace("settings_-1", "settings_-2"))).status === 401,
    );
    assert((await t.call(await signed("a".repeat(32)))).status === 401);
    assert((await t.call(await signed("settings_-2"))).status === 403);
    assert(
      !t.store.db.prepare("SELECT * FROM group_settings WHERE chat_id=-2")
        .get(),
    );
    const response = await t.call(auth);
    assert(
      response.status === 200 &&
        response.headers.get("Cache-Control") === "no-store",
    );
    const data = await response.json();
    assert(
      data.userId === 42 && data.chat.id === -1 &&
        data.settings.aiThreshold === .8,
    );
    assert(!JSON.stringify(data).includes("secret-"));
    t.state.role = "member";
    assert((await t.call(auth, values)).status === 403);
    t.state.role = "administrator";
    t.state.botRole = "left";
    assert((await t.call(auth)).status === 403);
    t.state.botRole = "administrator";
    t.state.fail = true;
    assert((await t.call(auth, values)).status === 503);
    assert(groupSettings(t.config, t.store, -1).moderation === "off");
    let rejected = false;
    try {
      await telegramAuth(auth, token);
    } catch {
      rejected = true;
    }
    assert(rejected); // Settings credentials cannot verify an admission request.
  } finally {
    t.store.close();
  }
});

Deno.test("Web 设置严格校验参数和机器人权限；保存原子生效，陈旧版本不能覆盖", async () => {
  const t = setup();
  try {
    const auth = await signed();
    for (
      const changes of [
        { chat_id: -2 },
        { aiThreshold: .49 },
        { aiThreshold: 1.01 },
        { aiThreshold: "0.8" },
        { welcome: "false" },
        { moderation: "kick" },
        { moderation: ["off"] },
        { revision: -1 },
        { cfToken: "overwrite" },
      ]
    ) {
      assert((await t.call(auth, { ...values, ...changes })).status === 400);
      assert(groupSettings(t.config, t.store, -1).revision === 0);
    }
    assert((await t.call(auth, "{")).status === 400);
    assert((await t.call(auth, "x".repeat(9000))).status === 400);
    t.state.delete = false;
    assert((await t.call(auth, values)).status === 403);
    t.state.delete = true;
    t.state.restrict = false;
    assert((await t.call(auth, values)).status === 403);
    t.state.restrict = true;
    const join = t.store.create(-1, 100, "request");
    const response = await t.call(auth, values);
    assert(response.status === 200);
    const saved = (await response.json()).settings;
    assert(
      saved.revision === 1 && saved.aiThreshold === .75 &&
        saved.moderation === "mute" && !saved.leave,
    );
    assert(t.store.get(join.id)?.state === "verified");
    assert(
      (await t.call(auth, { ...values, aiThreshold: .99 })).status === 409,
    );
    assert(t.store.groupThreshold(-1) === .75);
    t.store.updateSetting(-1, "welcome", false, 1);
    assert((await t.call(auth, { ...values, revision: 1 })).status === 409);
    assert(t.store.groupThreshold(-2) === undefined);
  } finally {
    t.store.close();
  }
});

Deno.test("Web 保存的每群阈值重启保留，审核读取并使旧缓存失效；其他群继续用80%", async () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/db.sqlite`;
  const t = setup(path);
  let reopened: Store | undefined;
  try {
    let calls = 0;
    const request: typeof fetch = () => {
      calls++;
      return Promise.resolve(
        Response.json({
          success: true,
          result: {
            answers: {
              classification: {
                type: "choice",
                choice: "advertisement",
                confidence: .78,
                probabilities: {
                  normal: .2,
                  advertisement: .78,
                  uncertain: .02,
                },
              },
            },
          },
        }),
      );
    };
    assert(
      (await moderate(t.config, t.store, -1, 1, "ad", request))?.certainty ===
        "low",
    );
    assert((await t.call(await signed(), values)).status === 200);
    assert(
      (await moderate(t.config, t.store, -1, 1, "ad", request))?.certainty ===
        "high",
    );
    assert(calls === 2);
    assert(
      (await moderate(t.config, t.store, -2, 1, "ad", request))?.certainty ===
        "low",
    );
    t.store.close();
    reopened = new Store(path);
    const settings = groupSettings(t.config, reopened, -1);
    assert(
      settings.aiThreshold === .75 && settings.moderation === "mute" &&
        !settings.leave,
    );
  } finally {
    (reopened ?? t.store).close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("Web 不允许启用缺少服务端凭据的功能", async () => {
  const t = setup(":memory:", {
    CF_ACCOUNT_ID: "",
    CF_API_TOKEN: "",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET: "",
    VERIFY_HOSTNAME: "",
    REVIEW_RETENTION_DAYS: "0",
  });
  try {
    const auth = await signed();
    for (
      const body of [{ ...values, verification: true }, {
        ...values,
        moderation: "observe",
      }, { ...values, moderation: "off" }]
    ) {
      assert((await t.call(auth, body)).status === 400);
    }
    assert(
      (await t.call(auth, { ...values, moderation: "off", review: false }))
        .status === 200,
    );
  } finally {
    t.store.close();
  }
});

Deno.test("Web 封禁检查权限，头像开关独立保存且旧客户端不会恢复已关闭的头像", async () => {
  const t = setup();
  try {
    const auth = await signed();
    t.state.restrict = false;
    assert(
      (await t.call(auth, {
        ...values,
        moderation: "ban",
        uploadAvatar: false,
      })).status === 403,
    );
    t.state.restrict = true;
    assert(
      (await t.call(auth, {
        ...values,
        moderation: "ban",
        uploadAvatar: false,
      })).status === 200,
    );
    assert(
      t.store.avatarEnabled(-1) === false && t.store.avatarEnabled(-2) === true,
    );
    assert(
      (await t.call(auth, { ...values, moderation: "ban", revision: 1 }))
        .status === 200,
    );
    assert(t.store.avatarEnabled(-1) === false);
    assert(
      (await t.call(auth, { ...values, revision: 2, uploadAvatar: "false" }))
        .status === 400,
    );
  } finally {
    t.store.close();
  }
});

Deno.test("客户端耗时回传验签、去重和限制字段，不执行群设置或暴露凭据", async () => {
  const t = setup();
  try {
    const auth = await signed();
    const event = {
      id: crypto.randomUUID(),
      name: "settings_load",
      duration_ms: 700,
      status: 200,
      error: "none",
      request_id: crypto.randomUUID(),
      metrics: { server_ms: 100, ttfb_ms: 200 },
    };
    const body = { session: crypto.randomUUID(), events: [event] };
    const report = (content: unknown = body, credentials = auth) =>
      t.handler(
        new Request("http://localhost/api/client-logs", {
          method: "POST",
          headers: { Authorization: "Telegram " + credentials },
          body: JSON.stringify(content),
        }),
      );
    assert((await report(body, "invalid")).status === 401);
    assert(
      (await report(body, auth.replace("settings_-1", "settings_-2")))
        .status === 401,
    );
    assert((await report()).status === 202);
    assert((await report()).status === 202);
    assert(
      Number(
        t.store.db.prepare("SELECT COUNT(*) AS total FROM client_timings")
          .get()!.total,
      ) === 1,
    );
    const row = t.store.db.prepare("SELECT * FROM client_timings").get()!;
    assert(row.user_id === 42 && row.chat_id === -1);
    assert(
      !String(row.body).includes("hash") &&
        !String(row.body).includes("Telegram"),
    );
    assert(!t.store.db.prepare("SELECT * FROM group_settings").get());
    for (
      const changes of [
        { duration_ms: -1 },
        { name: "raw_error" },
        { error: "secret-text" },
        { url: "https://example.com/#secret" },
        { metrics: { initData: auth } },
      ]
    ) {
      assert(
        (await report({ ...body, events: [{ ...event, ...changes }] }))
          .status === 400,
      );
    }
    assert(
      (await report({ ...body, events: Array(21).fill(event) })).status === 400,
    );
    t.store.db.prepare("UPDATE client_timings SET seen_at=0").run();
    assert(
      (await report({
        ...body,
        events: [{ ...event, id: crypto.randomUUID() }],
      })).status === 202,
    );
    assert(
      !t.store.db.prepare("SELECT * FROM client_timings WHERE seen_at=0").get(),
    );
    for (let i = 0; i < 5; i++) {
      assert(
        (await report({
          ...body,
          events: Array.from(
            { length: 20 },
            () => ({ ...event, id: crypto.randomUUID() }),
          ),
        })).status === 202,
      );
    }
    assert(
      (await report({
        ...body,
        events: Array.from(
          { length: 20 },
          () => ({ ...event, id: crypto.randomUUID() }),
        ),
      })).status === 429,
    );
  } finally {
    t.store.close();
  }
});

Deno.test("规则组通过Web保存并保留顺序，日志页实时鉴权且严格隔离群", async () => {
  const t = setup();
  try {
    const auth = await signed();
    const rules = [
      {
        id: "trusted",
        name: "可信用户名",
        enabled: true,
        action: "allow",
        conditions: [{ field: "username", pattern: "^trusted$", flags: "iu" }],
      },
      {
        id: "ad",
        name: "引流组",
        enabled: true,
        action: "ban",
        conditions: [{ field: "bio", pattern: "进群", flags: "u" }, {
          field: "message",
          pattern: "t\\.me",
          flags: "iu",
        }],
      },
    ];
    assert((await t.call(auth, { ...values, rules })).status === 200);
    assert(JSON.stringify(t.store.rules(-1)) === JSON.stringify(rules));
    assert((await t.call(auth, { ...values, revision: 1 })).status === 200);
    assert(t.store.rules(-1).length === 2);
    assert(
      (await t.call(auth, {
        ...values,
        revision: 2,
        rules: [{
          ...rules[0],
          conditions: [{ field: "message", pattern: "[", flags: "" }],
        }],
      })).status === 400,
    );
    t.store.groupEvent(-1, { event: "same-group", text: "本群日志" });
    t.store.groupEvent(-2, { event: "other-group", text: "其他群秘密" });
    const logs = (credentials: string) =>
      t.handler(
        new Request("http://localhost/api/logs", {
          headers: { Authorization: "Telegram " + credentials },
        }),
      );
    const signedLogs = await signed("logs_-1");
    const response = await logs(signedLogs);
    assert(response.status === 200);
    const text = await response.text();
    assert(text.includes("本群日志") && !text.includes("其他群秘密"));
    assert(
      (await t.call(signedLogs, { ...values, revision: 2 })).status === 401,
    );
    assert((await logs(await signed("logs_-2"))).status === 403);
    t.state.role = "member";
    assert((await logs(signedLogs)).status === 403);
  } finally {
    t.store.close();
  }
});

Deno.test("逐脚本耗时支持完整与受限明细，拒绝带查询参数或认证信息的资源URL", async () => {
  const t = setup();
  try {
    const auth = await signed();
    const event = {
      id: crypto.randomUUID(),
      name: "script_load",
      duration_ms: 3000,
      status: 0,
      error: "none",
      resource: "https://telegram.org/js/telegram-web-app.js",
      timing_detail: "restricted",
      metrics: {},
    };
    const report = (value: unknown) =>
      t.handler(
        new Request("http://localhost/api/client-logs", {
          method: "POST",
          headers: { Authorization: "Telegram " + auth },
          body: JSON.stringify({
            session: crypto.randomUUID(),
            events: [value],
          }),
        }),
      );
    assert((await report(event)).status === 202);
    const row = t.store.db.prepare("SELECT body FROM client_timings WHERE id=?")
      .get(event.id)!;
    assert(JSON.parse(String(row.body)).resource === event.resource);
    for (
      const resource of [
        event.resource + "?hash=private",
        event.resource + "#token",
        "https://user:password@example.com/sdk.js",
        "javascript:alert(1)",
      ]
    ) {
      assert(
        (await report({ ...event, id: crypto.randomUUID(), resource }))
          .status === 400,
      );
    }
    assert(
      (await report({
        ...event,
        id: crypto.randomUUID(),
        timing_detail: "guessed",
      })).status === 400,
    );
  } finally {
    t.store.close();
  }
});

Deno.test("完整原始消息导出实时检查本群权限，不允许其他群读取", async () => {
  const t = setup();
  try {
    const id = t.store.captureMessage(
      -1,
      7,
      "v1",
      '{"text":"来发财","external_reply":{"message_id":77},"contact":{"user_id":42,"phone_number":"+123"}}',
      '{"update_id":1}',
    );
    const other = t.store.captureMessage(
      -2,
      8,
      "v1",
      '{"text":"other-group"}',
      "{}",
    );
    const auth = await signed("logs_-1");
    const request = (snapshot: number) =>
      t.handler(
        new Request(`http://localhost/api/raw-message?id=${snapshot}`, {
          headers: { Authorization: "Telegram " + auth },
        }),
      );
    const response = await request(id);
    assert(
      response.status === 200 &&
        response.headers.get("Cache-Control") === "no-store",
    );
    const data = await response.json();
    assert(
      data.message.contact.phone_number === "+123" &&
        data.message.external_reply.message_id === 77,
    );
    assert((await request(other)).status === 404);
    t.state.role = "member";
    assert((await request(id)).status === 403);
  } finally {
    t.store.close();
  }
});

Deno.test("历史原始消息重新分析使用完整回复与名片，保留原判断且绝不调用处罚API", async () => {
  let calls = 0;
  const t = setup(":memory:", {}, (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert(payload.state.evidence.replies[0].contacts[0].user_id === 123);
    assert(
      payload.state.evidence.replies[0].source.origin.chat.username ===
        "example_ad_channel",
    );
    return Promise.resolve(
      Response.json({
        success: true,
        result: {
          response: {
            label: "advertisement",
            certainty: "high",
            reason: "收益招揽及联系人引流",
          },
        },
      }),
    );
  });
  try {
    t.memberRoles.set(88, "member");
    const raw = {
      message_id: 7,
      date: 1,
      chat: { id: -1, type: "supergroup", title: "G" },
      from: { id: 88, is_bot: false, first_name: "A" },
      text: "来发财",
      external_reply: {
        origin: {
          type: "channel",
          date: 1,
          chat: {
            id: -2,
            type: "channel",
            title: "Ad",
            username: "example_ad_channel",
          },
          message_id: 9,
        },
        contact: {
          first_name: "客服",
          phone_number: "+000000000",
          user_id: 123,
        },
      },
    };
    const id = t.store.captureMessage(
      -1,
      7,
      "raw-v1",
      JSON.stringify(raw),
      JSON.stringify({ update_id: 1, message: raw }),
    );
    t.store.snapshotResult(id, "kept", { score: .572 });
    const auth = await signed("logs_-1");
    const run = () =>
      t.handler(
        new Request("http://localhost/api/reanalyze", {
          method: "POST",
          headers: { Authorization: "Telegram " + auth },
          body: JSON.stringify({ snapshot_id: id }),
        }),
      );
    const response = await run();
    assert(response.status === 200);
    const result = await response.json();
    assert(
      result.action_applied === false &&
        result.verdict.label === "advertisement",
    );
    assert(
      t.store.rawMessage(-1, id)?.action === "kept" &&
        JSON.parse(t.store.rawMessage(-1, id)!.result_json!).score === .572,
    );
    assert(
      calls === 1 &&
        t.store.groupLogs(-1).some((row) =>
          row.kind === "action" && row.data.event === "reanalysis"
        ),
    );
    t.memberRoles.set(88, "administrator");
    assert((await run()).status === 403 && calls === 1);
    t.state.role = "member";
    assert((await run()).status === 403 && calls === 1);
  } finally {
    t.store.close();
  }
});
