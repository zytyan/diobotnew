/** Read-only Telegram integration; all settings writes use an in-memory database. */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Bot } from "grammy";
import { loadConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { Store } from "../src/store.ts";

const fixture = JSON.parse(
  await Deno.readTextFile("data/test-accounts/test/fixture.json"),
);
const config = loadConfig({
  BOT_TOKEN: fixture.bot_token,
  TELEGRAM_ENV: "test",
});
const bot = new Bot(config.token, { client: { environment: "test" } });
await bot.init();
const store = new Store(":memory:");
const handler = createHandler(config, store, "page", fetch, {
  api: bot.api,
  botId: bot.botInfo.id,
});
const publicMode = Deno.args.includes("--public");
const server = publicMode
  ? Deno.serve({ hostname: "127.0.0.1", port: 18532 }, handler)
  : undefined;
try {
  for (
    const [alias, allowed] of [["account-cn", true], [
      "account-us",
      false,
    ]] as const
  ) {
    const client = new TelegramClient(
      new StringSession(
        await Deno.readTextFile(`data/test-accounts/test/${alias}.session`),
      ),
      Number(Deno.env.get("TELEGRAM_API_ID")),
      Deno.env.get("TELEGRAM_API_HASH")!,
      {
        testServers: true,
        requestRetries: 2,
        connectionRetries: 2,
        autoReconnect: false,
      },
    );
    client.setLogLevel("none" as Parameters<typeof client.setLogLevel>[0]);
    try {
      await client.connect();
      const entity = await client.getEntity(fixture.bot_username);
      if (!(entity instanceof Api.User) || !entity.accessHash) {
        throw new Error("Test bot unavailable");
      }
      const view = await client.invoke(
        new Api.messages.RequestMainWebView({
          peer: await client.getInputEntity(entity),
          bot: new Api.InputUser({
            userId: entity.id,
            accessHash: entity.accessHash,
          }),
          platform: "tdesktop",
          startParam: `settings_${fixture.chat_id}`,
        }),
      );
      const url = new URL(view.url);
      const auth = new URLSearchParams(url.hash.slice(1)).get("tgWebAppData") ??
        url.searchParams.get("tgWebAppData");
      if (!auth) throw new Error("No Telegram signed launch data");
      const call = (data = auth, body?: unknown) => {
        const request = new Request(
          publicMode
            ? "https://tgv-test.zchan.moe/api/settings"
            : "http://localhost/api/settings",
          {
            method: body ? "PUT" : "GET",
            headers: {
              Authorization: "Telegram " + data,
              "User-Agent":
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
        const started = performance.now();
        return (publicMode ? fetch(request) : handler(request)).then(
          (response) => {
            console.log(
              `HTTP ${request.method}: ${response.status}, ${
                Math.round(performance.now() - started)
              }ms`,
            );
            return response;
          },
        );
      };
      const response = await call();
      if (response.status !== (allowed ? 200 : 403)) {
        throw new Error(`Unexpected HTTP ${response.status} for test user`);
      }
      if (allowed) {
        const result = await response.json();
        if (
          result.userId !== Number(fixture.owner_id) ||
          result.chat.id !== Number(fixture.chat_id)
        ) throw new Error("Identity mismatch");
        const saved = await call(auth, {
          ...result.settings,
          aiThreshold: .76,
          uploadAvatar: false,
          rules: [{
            id: "live-check",
            name: "只读联调规则",
            enabled: true,
            action: "allow",
            conditions: [{
              field: "message",
              pattern: "^live_check_only$",
              flags: "u",
            }],
          }],
        });
        if (
          saved.status !== 200 ||
          store.groupThreshold(Number(fixture.chat_id)) !== .76
        ) throw new Error("In-memory save failed");
        const tampered = auth.replace(
          `settings_${fixture.chat_id}`,
          "settings_-1",
        );
        if ((await call(tampered)).status !== 401) {
          throw new Error("Tampered group accepted");
        }
      }
      const base = publicMode
        ? "https://tgv-test.zchan.moe"
        : "http://localhost";
      const dispatch = (request: Request) =>
        publicMode ? fetch(request) : handler(request);
      const headers = {
        Authorization: "Telegram " + auth,
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/json",
      };
      if (allowed) {
        const report = await dispatch(
          new Request(base + "/api/client-logs", {
            method: "POST",
            headers,
            body: JSON.stringify({
              session: crypto.randomUUID(),
              events: [{
                id: crypto.randomUUID(),
                name: "settings_load",
                duration_ms: 200,
                status: 200,
                error: "none",
              }],
            }),
          }),
        );
        if (report.status !== 202) {
          throw new Error("Public client timing report failed");
        }
      }
      const logs = await dispatch(new Request(base + "/api/logs", { headers }));
      if (logs.status !== (allowed ? 200 : 403)) {
        throw new Error("Group log authorization failed");
      }
      if (
        allowed &&
        !(await logs.json()).logs.some((row: { kind: string }) =>
          row.kind === "client"
        )
      ) throw new Error("Reported timings missing from group logs");
      console.log(
        `PASS: real Telegram-signed ${
          allowed
            ? "administrator accepted; user/group verified; in-memory save and tamper rejection verified"
            : "ordinary member rejected"
        }`,
      );
    } finally {
      await client.destroy();
    }
  }
} finally {
  await server?.shutdown();
  store.close();
}
