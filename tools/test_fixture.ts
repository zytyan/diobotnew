/** Creates isolated fixtures only on Telegram TEST servers. */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
const root = new URL("../data/test-accounts/test/", import.meta.url);
const fixturePath = new URL("fixture.json", root);
const apiId = Number(Deno.env.get("TELEGRAM_API_ID"));
const apiHash = Deno.env.get("TELEGRAM_API_HASH")!;
async function connect(alias: string) {
  const client = new TelegramClient(
    new StringSession(
      await Deno.readTextFile(new URL(`${alias}.session`, root)),
    ),
    apiId,
    apiHash,
    {
      testServers: true,
      connectionRetries: 2,
      requestRetries: 3,
      autoReconnect: false,
    },
  );
  client.setLogLevel("none" as Parameters<typeof client.setLogLevel>[0]);
  await client.connect();
  if (!await client.isUserAuthorized()) throw new Error(`${alias} 未授权`);
  return client;
}
async function save(value: unknown) {
  await Deno.writeTextFile(fixturePath, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  await Deno.chmod(fixturePath, 0o600);
}
const cn = await connect("account-cn");
const us = await connect("account-us");
try {
  let fixture: Record<string, string> = {};
  try {
    fixture = JSON.parse(await Deno.readTextFile(fixturePath));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!fixture.bot_token) {
    const exchange = async (text: string) => {
      const sent = await cn.sendMessage("BotFather", { message: text });
      for (let i = 0; i < 30; i++) {
        const messages = await cn.getMessages("BotFather", {
          limit: 5,
          minId: sent.id,
        });
        const reply = messages.find((m) => !m.out && m.id > sent.id);
        if (reply) return reply.message;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("BotFather 回复超时");
    };
    await exchange("/newbot");
    await exchange("Diobot Integration Test");
    const username = `diobot_it_${Date.now()}_bot`;
    const reply = await exchange(username);
    const token = reply.match(/\b\d{5,}:[A-Za-z0-9_-]{25,}\b/)?.[0];
    if (!token) {
      throw new Error(
        "BotFather 未返回新 bot token（未输出回复，避免泄露凭据）",
      );
    }
    fixture = { ...fixture, bot_token: token, bot_username: username };
    await save(fixture);
    console.log("Created dedicated test bot; token saved privately.");
  }
  if (!fixture.chat_id) {
    const result = await cn.invoke(
      new Api.channels.CreateChannel({
        title: `Diobot Integration ${Date.now()}`,
        about: "Isolated bot configuration and moderation tests",
        megagroup: true,
      }),
    );
    if (!(result instanceof Api.Updates)) {
      throw new Error("Unexpected create group response");
    }
    const channel = result.chats.find((c) => c instanceof Api.Channel);
    if (!channel) throw new Error("Missing test channel");
    const input = await cn.getInputEntity(channel);
    const invite = await cn.invoke(
      new Api.messages.ExportChatInvite({ peer: input }),
    );
    if (!(invite instanceof Api.ChatInviteExported)) {
      throw new Error("Missing test invite");
    }
    fixture = {
      ...fixture,
      chat_id: `-100${channel.id}`,
      invite_link: invite.link,
    };
    await save(fixture);
    await us.invoke(
      new Api.messages.ImportChatInvite({
        hash: invite.link.split("/").pop()!.replace(/^\+/, ""),
      }),
    );
    console.log("Created isolated test supergroup and joined second account.");
  }
  const chat = (await cn.getDialogs({ limit: 100 })).map((d) => d.entity).find(
    (e) => e instanceof Api.Channel && `-100${e.id}` === fixture.chat_id,
  );
  const bot = await cn.getEntity(fixture.bot_username);
  if (!(chat instanceof Api.Channel) || !(bot instanceof Api.User)) {
    throw new Error("Unexpected fixture entities");
  }
  try {
    await cn.invoke(
      new Api.channels.InviteToChannel({ channel: chat, users: [bot] }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("USER_ALREADY_PARTICIPANT")
    ) throw error;
  }
  await cn.invoke(
    new Api.channels.EditAdmin({
      channel: chat,
      userId: bot,
      rank: "Diobot test",
      adminRights: new Api.ChatAdminRights({
        changeInfo: true,
        deleteMessages: true,
        banUsers: true,
        inviteUsers: true,
        pinMessages: true,
        addAdmins: false,
        manageCall: true,
        other: true,
      }),
    }),
  );
  const me = await cn.getMe();
  const other = await us.getMe();
  fixture = {
    ...fixture,
    owner_id: me.id.toString(),
    other_id: other.id.toString(),
  };
  await save(fixture);
  console.log(
    JSON.stringify({
      ready: true,
      environment: "test",
      bot: fixture.bot_username,
      chat_id: fixture.chat_id,
      owner_id: fixture.owner_id,
      other_id: fixture.other_id,
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replace(/\b\d+:[A-Za-z0-9_-]{25,}\b/g, "[token]")
      : "Fixture failed",
  );
  Deno.exitCode = 1;
} finally {
  await cn.destroy();
  await us.destroy();
}
