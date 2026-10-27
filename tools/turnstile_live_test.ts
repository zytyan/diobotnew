/** Real Telegram-signed launch data + real Turnstile negative-path integration. */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Store } from "../src/store.ts";
const f = JSON.parse(
  await Deno.readTextFile("data/test-accounts/test/fixture.json"),
);
const c = new TelegramClient(
  new StringSession(
    await Deno.readTextFile("data/test-accounts/test/account-cn.session"),
  ),
  Number(Deno.env.get("TELEGRAM_API_ID")),
  Deno.env.get("TELEGRAM_API_HASH")!,
  {
    testServers: true,
    requestRetries: 3,
    connectionRetries: 2,
    autoReconnect: false,
  },
);
c.setLogLevel("none" as Parameters<typeof c.setLogLevel>[0]);
const store = new Store("data/test-accounts/test/manual.sqlite");
const join = store.create(Number(f.chat_id), Number(f.owner_id), "request");
try {
  await c.connect();
  const bot = await c.getEntity(f.bot_username);
  if (!(bot instanceof Api.User) || !bot.accessHash) {
    throw new Error("Test bot unavailable");
  }
  const view = await c.invoke(
    new Api.messages.RequestMainWebView({
      peer: await c.getInputEntity(bot),
      bot: new Api.InputUser({ userId: bot.id, accessHash: bot.accessHash }),
      platform: "tdesktop",
      startParam: join.id,
    }),
  );
  const launch = new URL(view.url);
  const fragment = new URLSearchParams(launch.hash.slice(1));
  const data = fragment.get("tgWebAppData") ??
    launch.searchParams.get("tgWebAppData");
  if (launch.hostname !== "tgv-test.zchan.moe" || !data) {
    throw new Error("Test Main Mini App not configured as expected");
  }
  const response = await fetch("https://tgv-test.zchan.moe/verify", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/json",
      Authorization: "Telegram " + data,
    },
    body: JSON.stringify({ token: "invalid-integration-test-token" }),
  });
  const result = await response.json();
  if (response.status !== 400 || store.get(join.id)?.attempts !== 1) {
    throw new Error(
      `Expected real captcha rejection, got HTTP ${response.status}: ${result.error}`,
    );
  }
  console.log(
    "PASS: real Telegram-signed Mini App launch accepted; real Cloudflare Turnstile rejected invalid captcha through public HTTPS backend.",
  );
  console.log(
    "A successful human challenge must still be completed in a Telegram client; this test does not fake a successful token.",
  );
} finally {
  store.state(join.id, "superseded");
  store.close();
  await c.destroy();
}
