/** Tests the already-running isolated binary; never starts a second poller. */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Store } from "../src/store.ts";
const f = JSON.parse(
  await Deno.readTextFile("data/test-accounts/test/fixture.json"),
);
const c = new TelegramClient(
  new StringSession(
    await Deno.readTextFile("data/test-accounts/test/account-us.session"),
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
try {
  await c.connect();
  const chat = (await c.getDialogs({ limit: 100 })).map((d) => d.entity).find(
    (e) => e instanceof Api.Channel && `-100${e.id}` === f.chat_id,
  );
  if (!chat) throw new Error("Test group unavailable");
  const cases = [{
    text: "这个 TypeScript 库支持 Deno 吗？我想用它管理 Telegram 群。",
    expected: "normal",
  }, {
    text:
      "全网最低价服务器代理热卖！限时促销，批量优惠，立即私聊 @example_sales 下单，欢迎代理加盟！",
    expected: "advertisement",
  }];
  for (const sample of cases) {
    const sent = await c.sendMessage(chat, { message: sample.text });
    let result: Record<string, unknown> | undefined;
    for (let i = 0; i < 50; i++) {
      const row = store.db.prepare(
        "SELECT result FROM moderation WHERE chat_id=? AND message_id=?",
      ).get(Number(f.chat_id), sent.id);
      if (row) {
        result = JSON.parse(String(row.result));
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (
      !result || result.label !== sample.expected ||
      result.model !== "@cf/cloudflare/clef-flash"
    ) throw new Error("Actual Telegram to Clef classification failed");
    console.log(
      JSON.stringify({
        pipeline: "Telegram -> compiled Deno bot -> real Clef Flash -> SQLite",
        label: result.label,
        score: result.score,
        mode: "observe",
      }),
    );
  }
  console.log(
    "PASS: live Telegram messages classified by real Clef Flash through the running binary.",
  );
} finally {
  store.close();
  await c.destroy();
}
