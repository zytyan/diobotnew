import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
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
try {
  await c.connect();
  await c.sendMessage("BotFather", { message: "/mybots" });
  await new Promise((r) => setTimeout(r, 1000));
  let m = (await c.getMessages("BotFather", { limit: 1 }))[0];
  const buttons = m.replyMarkup instanceof Api.ReplyInlineMarkup
    ? m.replyMarkup.rows.flatMap((r) => r.buttons)
    : [];
  const b = buttons.find((b) => b.text.includes(f.bot_username));
  if (b instanceof Api.KeyboardButtonCallback) {
    await c.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: await c.getInputEntity("BotFather"),
        msgId: m.id,
        data: b.data,
      }),
    );
    await new Promise((r) => setTimeout(r, 1000));
    m = (await c.getMessages("BotFather", { limit: 1 }))[0];
  }
  const urlIndex = Deno.args.indexOf("--url");
  const steps = urlIndex < 0 ? Deno.args : Deno.args.slice(0, urlIndex);
  for (const step of steps) {
    const allowed = [
      "Bot Settings",
      "Configure Mini App",
      "Configure Main Mini App",
      "Edit Mini App URL",
      "Enable Mini App",
      "Set URL",
    ];
    if (!allowed.includes(step)) throw new Error("Unsupported setup action");
    const current = m.replyMarkup instanceof Api.ReplyInlineMarkup
      ? m.replyMarkup.rows.flatMap((r) => r.buttons)
      : [];
    const selected = current.find((b) => b.text === step);
    if (!(selected instanceof Api.KeyboardButtonCallback)) {
      throw new Error("Setup button unavailable: " + step);
    }
    await c.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: await c.getInputEntity("BotFather"),
        msgId: m.id,
        data: selected.data,
      }),
    );
    await new Promise((r) => setTimeout(r, 1000));
    m = (await c.getMessages("BotFather", { limit: 1 }))[0];
  }
  if (urlIndex >= 0) {
    const url = Deno.args[urlIndex + 1];
    if (url !== "https://tgv-test.zchan.moe/") {
      throw new Error("Only isolated test Mini App URL is allowed");
    }
    await c.sendMessage("BotFather", { message: url });
    await new Promise((r) => setTimeout(r, 1000));
    m = (await c.getMessages("BotFather", { limit: 1 }))[0];
  }
  console.log("Test BotFather screen:", m.message.slice(0, 400));
  console.log(
    "Available buttons:",
    m.replyMarkup instanceof Api.ReplyInlineMarkup
      ? m.replyMarkup.rows.flatMap((r) => r.buttons.map((b) => b.text))
      : [],
  );
} finally {
  await c.destroy();
}
