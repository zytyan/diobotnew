/** Live integration tests, restricted to the separately created TEST fixture. */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import type { Message, Update } from "grammy/types";
function assert(value: unknown, why: string): asserts value {
  if (!value) throw new Error(why);
}
const root = new URL("../data/test-accounts/test/", import.meta.url);
const fixture = JSON.parse(
  await Deno.readTextFile(new URL("fixture.json", root)),
);
const apiId = Number(Deno.env.get("TELEGRAM_API_ID"));
const apiHash = Deno.env.get("TELEGRAM_API_HASH")!;
async function connect(alias: string) {
  let saved: string;
  try {
    saved = await Deno.readTextFile(new URL(`${alias}.dc2.session`, root));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    saved = await Deno.readTextFile(new URL(`${alias}.session`, root));
  }
  const session = new StringSession(saved);
  assert(
    ["149.154.167.40", "149.154.175.10", "149.154.175.40", "149.154.175.117"]
      .includes(
        session.serverAddress,
      ),
    "Not a test session",
  );
  const c = new TelegramClient(session, apiId, apiHash, {
    testServers: true,
    requestRetries: 3,
    connectionRetries: 2,
    autoReconnect: false,
  });
  c.setLogLevel("none" as Parameters<typeof c.setLogLevel>[0]);
  await c.connect();
  const serverConfig = await c.invoke(new Api.help.GetConfig());
  assert(serverConfig.testMode, "Server did not confirm test mode");
  return c;
}
const cn = await connect("account-cn");
const us = await connect("account-us");
const store = new Store(new URL("integration.sqlite", root).pathname);
const config = loadConfig({
  BOT_TOKEN: fixture.bot_token,
  TELEGRAM_ENV: "test",
});
const { bot, sweep } = createBot(config, store);
const panels: Message[] = [];
let publicNotices = 0;
bot.api.config.use(async (prev, method, payload) => {
  const result = await prev(method, payload);
  if (
    method === "sendMessage" && result.ok &&
    String((payload as { chat_id?: number | string }).chat_id) ===
      fixture.chat_id
  ) publicNotices++;
  if (method === "sendRichMessage" && result.ok) {
    panels.push(result.result as Message);
  }
  return result;
});
let offset = 0;
const types = [
  "message",
  "chat_member",
  "my_chat_member",
  "callback_query",
] as const;
async function receive(predicate: (u: Update) => boolean) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const updates = await bot.api.getUpdates({
      offset,
      timeout: 2,
      allowed_updates: [...types],
    });
    let found: Update | undefined;
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      await bot.handleUpdate(update);
      if (predicate(update)) found = update;
    }
    if (found) return found;
  }
  throw new Error("Expected live update did not arrive");
}
try {
  await bot.init();
  await bot.api.setMyCommands(
    [{ command: "settings", description: "群管理设置", is_ephemeral: true }, {
      command: "tree",
      description: "处理直接邀请成员",
      is_ephemeral: true,
    }],
    { scope: { type: "all_chat_administrators" } },
  );
  const commands = await bot.api.getMyCommands({
    scope: { type: "all_chat_administrators" },
  });
  assert(
    commands.length === 2 && commands.every((c) => c.is_ephemeral),
    "Ephemeral commands not registered",
  );
  console.log("PASS: Telegram API registered ephemeral administrator commands");
  const dialogs = await cn.getDialogs({ limit: 100 });
  const chat = dialogs.map((d) => d.entity).find((e) =>
    e instanceof Api.Channel && `-100${e.id}` === fixture.chat_id
  );
  assert(chat, "Missing test group");
  let usChat = (await us.getDialogs({ limit: 100 })).map((d) => d.entity)
    .find((e) => e instanceof Api.Channel && `-100${e.id}` === fixture.chat_id);
  // Only the two explicitly authorized TEST accounts are added, never address books.
  const cnPhone = Deno.env.get("TEST_PHONE_CN");
  const usPhone = Deno.env.get("TEST_PHONE_US");
  assert(
    cnPhone && usPhone,
    "TEST_PHONE_CN / TEST_PHONE_US required for direct invite privacy",
  );
  await cn.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: (await cn.getMe()).id,
          phone: usPhone,
          firstName: "Diobot Test US",
          lastName: "",
        }),
      ],
    }),
  );
  await us.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: (await us.getMe()).id,
          phone: cnPhone,
          firstName: "Diobot Test CN",
          lastName: "",
        }),
      ],
    }),
  );
  if (!usChat) {
    await cn.getMessages(chat, { limit: 50 });
    const target = await cn.getEntity(Number(fixture.other_id));
    await cn.invoke(
      new Api.channels.InviteToChannel({ channel: chat, users: [target] }),
    );
    usChat = (await us.getDialogs({ limit: 100 })).map((d) => d.entity).find(
      (e) => e instanceof Api.Channel && `-100${e.id}` === fixture.chat_id,
    );
  }
  assert(usChat, "Missing second account test group");
  // Consume setup events before testing. No production token or group is used.
  const pending = await bot.api.getUpdates({
    timeout: 0,
    allowed_updates: [...types],
  });
  for (const u of pending) offset = Math.max(offset, u.update_id + 1);
  await us.sendMessage(usChat, {
    message: `/settings@${fixture.bot_username}`,
  });
  await receive((u) => u.message?.from?.id === Number(fixture.other_id));
  const denied = panels.at(-1)!;
  assert(
    denied?.ephemeral_message_id &&
      denied.receiver_user?.id === Number(fixture.other_id) &&
      denied.rich_message,
    "Non-admin reply was not ephemeral rich",
  );
  console.log(
    "PASS: actual non-admin request received only a private rich denial",
  );
  await cn.sendMessage(chat, { message: `/settings@${fixture.bot_username}` });
  await receive((u) => u.message?.from?.id === Number(fixture.owner_id));
  const menu = panels.at(-1)!;
  assert(
    menu.ephemeral_message_id &&
      menu.receiver_user?.id === Number(fixture.owner_id) && menu.rich_message,
    "Admin menu was not ephemeral rich",
  );
  console.log(
    "PASS: actual administrator received an ephemeral rich settings panel",
  );
  // Editing is an actual Bot API call. Callback authorization is covered separately.
  await bot.api.editEphemeralMessageText(
    fixture.chat_id,
    Number(fixture.owner_id),
    menu.ephemeral_message_id,
    { blocks: [{ type: "paragraph", text: "集成测试：私密面板编辑成功" }] },
  );
  console.log("PASS: editEphemeralMessageText accepted the real panel");
  const history = await us.getMessages(usChat, { limit: 30 });
  assert(
    !history.some((m) =>
      (m.message ?? "").includes("只有当前群管理员") ||
      (m.message ?? "").includes("集成测试：私密面板编辑成功")
    ),
    "Ephemeral content leaked to public history",
  );
  // No speech task exists even after a real rejoin.
  const settings = store.settings(Number(fixture.chat_id), {
    verification: false,
    moderation: "off",
    welcome: false,
    kicked: false,
    leave: false,
    tree: true,
  });
  for (const key of ["welcome", "kicked", "leave"] as const) {
    const current = store.settings(Number(fixture.chat_id), settings);
    store.updateSetting(Number(fixture.chat_id), key, false, current.revision!);
  }
  // Kick/unban from the bot's DC: cross-DC LeaveChannel can fail on Telegram's test cluster.
  await cn.getMessages(chat, { limit: 30 });
  const other = await cn.getEntity(Number(fixture.other_id));
  const beforeNotices = publicNotices;
  await bot.api.banChatMember(fixture.chat_id, Number(fixture.other_id));
  await bot.api.unbanChatMember(fixture.chat_id, Number(fixture.other_id), {
    only_if_banned: true,
  });
  await receive((u) =>
    u.chat_member?.new_chat_member.user.id === Number(fixture.other_id) &&
    u.chat_member.new_chat_member.status === "left"
  );
  await cn.invoke(
    new Api.channels.InviteToChannel({ channel: chat, users: [other] }),
  );
  await receive((u) =>
    u.chat_member?.new_chat_member.user.id === Number(fixture.other_id) &&
    u.chat_member.new_chat_member.status === "member"
  );
  const invitees = store.invitees(
    Number(fixture.chat_id),
    Number(fixture.owner_id),
  );
  assert(
    invitees.some((c) => c.user_id === Number(fixture.other_id)),
    "Real direct invitation was not tracked",
  );
  assert(store.active().length === 0, "Unexpected verification or speech task");
  assert(
    publicNotices === beforeNotices,
    "Disabled notices sent public messages",
  );
  await sweep();
  console.log(
    "PASS: real direct invitation tracked; notifications disabled; no speech check",
  );
  const report = {
    environment: "test",
    chat_id: fixture.chat_id,
    bot: fixture.bot_username,
    passed: true,
    time: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    new URL("last-integration.json", root),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replace(/\b\d+:[A-Za-z0-9_-]{25,}\b/g, "[token]")
      : "Integration failed",
  );
  Deno.exitCode = 1;
} finally {
  store.close();
  await cn.destroy();
  await us.destroy();
}
