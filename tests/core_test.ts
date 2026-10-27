import { Store } from "../src/store.ts";
import { telegramAuth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { parseVerdict } from "../src/moderation.ts";
import { createHandler } from "../src/server.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => unknown | Promise<unknown>) {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, "expected rejection");
}
const now = 1_800_000_000_000;
const session = "a".repeat(32);
const token = "123456:test-token-for-unit-tests";
async function signed(user = 42, timestamp = now / 1000, id = session) {
  const params = new URLSearchParams({
    auth_date: String(timestamp),
    user: JSON.stringify({ id: user }),
    start_param: id,
  });
  const encode = new TextEncoder();
  async function mac(key: Uint8Array, value: string) {
    const k = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", k, encode.encode(value)),
    );
  }
  const key = await mac(encode.encode("WebAppData"), token);
  const hash = await mac(
    key,
    [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  params.set(
    "hash",
    [...hash].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  return params.toString();
}
const config = () =>
  loadConfig({
    BOT_TOKEN: token,
    TELEGRAM_ENV: "test",
    TURNSTILE_SITE_KEY: "test-key",
    TURNSTILE_SECRET: "test-secret",
    VERIFY_HOSTNAME: "example.com",
  });

Deno.test("验证签名、过期、未来时间、身份篡改与重复参数", async () => {
  const data = await signed();
  assert((await telegramAuth(data, token, now)).user === 42);
  await rejects(() => telegramAuth(data.replace("42", "43"), token, now));
  await rejects(() => telegramAuth(data, token, now + 301_000));
  await rejects(async () =>
    telegramAuth(await signed(42, now / 1000 + 60), token, now)
  );
  await rejects(() => telegramAuth(data + "&auth_date=1", token, now));
  await rejects(() => telegramAuth("hash=a", token, now));
});
Deno.test("同一用户的不同群申请隔离，重申请淘汰旧链接，终态不可覆盖", () => {
  const store = new Store(":memory:");
  try {
    const a = store.create(-1, 42, "request", {}, now);
    const b = store.create(-2, 42, "request", {}, now);
    assert(!store.resolve(a.id, 43, true, now));
    assert(store.resolve(a.id, 42, true, now));
    assert(!store.resolve(a.id, 42, false, now));
    assert(store.get(b.id)?.state === "pending");
    const c = store.create(-2, 42, "request", {}, now);
    assert(store.get(b.id)?.state === "superseded");
    assert(!store.resolve(b.id, 42, true, now));
    assert(!store.resolve(c.id, 42, true, now + 360_001));
  } finally {
    store.close();
  }
});
Deno.test("验证允许三次失败，群移除能取消超时任务", () => {
  const store = new Store(":memory:");
  try {
    const row = store.create(-1, 42, "direct", {}, now);
    store.resolve(row.id, 42, false, now);
    store.resolve(row.id, 42, false, now);
    assert(store.get(row.id)?.state === "pending");
    store.resolve(row.id, 42, false, now);
    assert(store.get(row.id)?.state === "failed");
    assert(!store.resolve(row.id, 42, true, now));
    store.create(-1, 44, "request", {}, now);
    store.cancel(-1);
    assert(store.active().length === 0);
  } finally {
    store.close();
  }
});
Deno.test("SQLite 重开保留申请、群使用记录和日请求额度", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/bot.sqlite`;
  try {
    let store = new Store(path);
    const row = store.create(-1, 42, "request");
    store.recordChat(-1, "测试群", "supergroup", "administrator");
    assert(store.spend(1));
    store.close();
    store = new Store(path);
    try {
      assert(store.get(row.id)?.state === "pending");
      assert(store.chats()[0].title === "测试群");
      assert(!store.spend(1));
      store.recordChat(-1, "测试群", "supergroup", "left");
      store.recordChat(-1, "测试群", "supergroup");
      assert(store.chats()[0].bot_status === "left");
    } finally {
      store.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
Deno.test("验证配置可整体省略，禁止部分配置与生产测试 key", async () => {
  assert(config().environment === "test");
  assert(loadConfig({ BOT_TOKEN: token }).siteKey === "");
  await rejects(() =>
    loadConfig({ BOT_TOKEN: token, TURNSTILE_SECRET: "partial" })
  );
  await rejects(() =>
    loadConfig({
      BOT_TOKEN: token,
      TURNSTILE_SITE_KEY: "1x00000000000",
      TURNSTILE_SECRET: "secret",
      VERIFY_HOSTNAME: "example.com",
    })
  );
  await rejects(() =>
    loadConfig({
      BOT_TOKEN: token,
      TELEGRAM_ENV: "test",
      TURNSTILE_SITE_KEY: "test-key",
      TURNSTILE_SECRET: "test-secret",
      VERIFY_HOSTNAME: "example.com",
      MODERATION_MODE: "delete",
    })
  );
});
Deno.test("AI 返回严格校验，拒绝异常或缺少字段的结果", async () => {
  assert(
    parseVerdict('{"label":"normal","certainty":"high","reason":"讨论"}')
      .label === "normal",
  );
  await rejects(() =>
    parseVerdict('{"label":"ban","certainty":"high","reason":""}')
  );
  await rejects(() => parseVerdict('{"label":"advertisement"}'));
});
Deno.test("HTTP 不接受未签名身份或其他人的申请，也不会凭空建立申请", async () => {
  const store = new Store(":memory:");
  try {
    const handler = createHandler(config(), store, "test __SITE_KEY__");
    assert(
      (await handler(new Request("http://localhost/healthz"))).status === 200,
    );
    assert(
      (await handler(
        new Request("http://localhost/verify", { method: "POST" }),
      )).status === 401,
    );
    const row = store.create(-1, 42, "request");
    const auth = await signed(43, Math.floor(Date.now() / 1000), row.id);
    const response = await handler(
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { Authorization: `Telegram ${auth}` },
        body: JSON.stringify({ token: "fake" }),
      }),
    );
    assert(response.status === 403);
    assert(
      store.active().length === 1 && store.get(row.id)?.state === "pending",
    );
  } finally {
    store.close();
  }
});

Deno.test("Turnstile 域名/用途/申请绑定；成功不可被重复提交改写", async () => {
  const store = new Store(":memory:");
  try {
    const row = store.create(-1, 42, "request");
    const auth = await signed(42, Math.floor(Date.now() / 1000), row.id);
    let fields = {
      success: true,
      hostname: "wrong.example",
      action: "join",
      cdata: row.id,
    };
    let calls = 0;
    const handler = createHandler(config(), store, "page", () => {
      calls++;
      return Promise.resolve(Response.json(fields));
    });
    const request = () =>
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { Authorization: `Telegram ${auth}` },
        body: JSON.stringify({ token: "test-token" }),
      });
    assert((await handler(request())).status === 400);
    assert(store.get(row.id)?.state === "pending");
    fields = { ...fields, hostname: "example.com", cdata: "b".repeat(32) };
    assert((await handler(request())).status === 400);
    fields = { ...fields, cdata: row.id };
    assert((await handler(request())).status === 200);
    assert(store.get(row.id)?.state === "verified");
    fields = { ...fields, success: false };
    assert((await handler(request())).status === 200);
    assert(calls === 3);
    assert(store.get(row.id)?.state === "verified");
  } finally {
    store.close();
  }
});
Deno.test("验证服务故障不消耗失败次数，过期申请不会调用 Turnstile", async () => {
  const store = new Store(":memory:");
  try {
    const row = store.create(-1, 42, "request");
    const auth = await signed(42, Math.floor(Date.now() / 1000), row.id);
    let calls = 0;
    const handler = createHandler(config(), store, "page", () => {
      calls++;
      return Promise.resolve(
        Response.json({ success: false, "error-codes": ["internal-error"] }),
      );
    });
    const request = () =>
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { Authorization: `Telegram ${auth}` },
        body: JSON.stringify({ token: "test-token" }),
      });
    assert((await handler(request())).status === 503);
    assert(store.get(row.id)?.attempts === 0);
    store.state(row.id, "pending", Date.now() - 1);
    assert((await handler(request())).status === 410);
    assert(calls === 1);
  } finally {
    store.close();
  }
});
