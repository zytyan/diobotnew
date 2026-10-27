/** Stop test:serve first. Uses only the two authorized TEST accounts and isolated bot. */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/uploads";
import { Bot } from "grammy";
import type { Message } from "grammy/types";
import { createBot } from "../src/bot.ts";
import { Store } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
function assert(v: unknown, reason: string): asserts v {
  if (!v) throw new Error(reason);
}
const f = JSON.parse(
  await Deno.readTextFile("data/test-accounts/test/fixture.json"),
);
const runtime = JSON.parse(
  await Deno.readTextFile("data/deploy/cf-runtime.json"),
);
async function client(alias: string) {
  const c = new TelegramClient(
    new StringSession(
      await Deno.readTextFile(`data/test-accounts/test/${alias}.session`),
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
  await c.connect();
  assert(
    (await c.invoke(new Api.help.GetConfig())).testMode,
    "Not test server",
  );
  return c;
}
const cn = await client("account-cn");
const us = await client("account-us");
const store = new Store("data/test-accounts/test/profiles.sqlite");
const config = loadConfig({
  BOT_TOKEN: f.bot_token,
  TELEGRAM_ENV: "test",
  PUBLIC_CHAT_IDS: f.chat_id,
  MODERATION_MODE: "observe",
  CF_ACCOUNT_ID: runtime.account_id,
  CF_API_TOKEN: runtime.token,
});
const { bot } = createBot(config, store);
const panels: Record<string, unknown>[] = [];
bot.api.config.use(async (prev, method, payload) => {
  const result = await prev(method, payload);
  if (method === "sendRichMessage" && result.ok) {
    const m = result.result as Message;
    assert(m.ephemeral_message_id, "Response was not ephemeral");
    panels.push(payload as Record<string, unknown>);
  }
  return result;
});
let offset = 0;
async function receive(id: number) {
  for (let n = 0; n < 15; n++) {
    const updates = await bot.api.getUpdates({
      offset,
      timeout: 2,
      allowed_updates: ["message", "edited_message"],
    });
    let found = false;
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      await bot.handleUpdate(u);
      if (u.message?.message_id === id) found = true;
    }
    if (found) return;
  }
  throw new Error("Test update unavailable");
}
let originalBio: string | undefined;
let originalPhoto: Api.Photo | undefined;
let newPhoto: Api.Photo | undefined;
try {
  await bot.init();
  assert(
    (await new Bot(f.bot_token, { client: { environment: "test" } }).api
      .getMe()).id === bot.botInfo.id,
    "Wrong bot",
  );
  const chat = (await cn.getDialogs({ limit: 100 })).map((d) => d.entity).find(
    (e) => e instanceof Api.Channel && `-100${e.id}` === f.chat_id,
  );
  assert(chat, "Missing test group");
  const usChat = (await us.getDialogs({ limit: 100 })).map((d) => d.entity)
    .find((e) => e instanceof Api.Channel && `-100${e.id}` === f.chat_id);
  assert(usChat, "Missing member group");
  const original = await us.invoke(new Api.users.GetFullUser({ id: "me" }));
  originalBio = original.fullUser.about ?? "";
  const photos = await us.invoke(
    new Api.photos.GetUserPhotos({
      userId: "me",
      offset: 0,
      maxId: (await us.getMe()).id.multiply(0),
      limit: 1,
    }),
  );
  originalPhoto = photos.photos[0] instanceof Api.Photo
    ? photos.photos[0]
    : undefined;
  await Deno.writeTextFile(
    "data/test-accounts/test/profile-backup.json",
    JSON.stringify({ bio: originalBio, photo: originalPhoto?.id.toString() }),
    { mode: 0o600 },
  );
  const path = "data/test-accounts/test/avatar.png";
  const size = (await Deno.stat(path)).size;
  const file = await us.uploadFile({
    file: new CustomFile("avatar.png", size, path),
    workers: 1,
  });
  const uploaded = await us.invoke(new Api.photos.UploadProfilePhoto({ file }));
  assert(uploaded.photo instanceof Api.Photo, "Photo upload failed");
  newPhoto = uploaded.photo;
  await us.invoke(
    new Api.account.UpdateProfile({
      about:
        "Software developer. TypeScript and Deno enthusiast. No promotions.",
    }),
  );
  const pending = await bot.api.getUpdates({
    timeout: 0,
    allowed_updates: ["message", "edited_message"],
  });
  for (const u of pending) offset = Math.max(offset, u.update_id + 1);
  const member = await us.sendMessage(usChat, {
    message: "我是王伟，刚开始学习 TypeScript，请问这个库支持 Deno 吗？",
  });
  await receive(member.id);
  const sample = store.recentReviews(Number(f.chat_id)).find((r) =>
    r.message_id === member.id
  );
  assert(sample, "Member sample not saved");
  const profile = JSON.parse(sample.profile_json);
  assert(
    profile.sender.bio_status === "available" &&
      profile.sender.bio.includes("Software developer"),
    "Actual bio unavailable",
  );
  assert(
    profile.avatar.status === "available" && sample.avatar_hash &&
      store.reviewAvatar(sample.avatar_hash),
    "Actual avatar download failed",
  );
  assert(
    JSON.parse(sample.result_json ?? "{}").label === "normal",
    "Genuine introduction misclassified",
  );
  console.log(
    "PASS: actual TEST profile bio + downloaded avatar -> real Clef multimodal -> normal introduction + local snapshot.",
  );
  const admin = await cn.sendMessage(chat, {
    message: "管理员隐私排除测试，不应上传。",
  });
  await receive(admin.id);
  assert(
    !store.recentReviews(Number(f.chat_id)).some((r) =>
      r.message_id === admin.id
    ),
    "Admin sample recorded",
  );
  assert(
    !store.db.prepare(
      "SELECT 1 FROM moderation WHERE chat_id=? AND message_id=?",
    ).get(Number(f.chat_id), admin.id),
    "Admin uploaded",
  );
  console.log(
    "PASS: actual group creator excluded before recording and AI upload.",
  );
  const cmd = await cn.sendMessage(chat, {
    message: `/check@${f.bot_username}`,
    replyTo: member.id,
  });
  await receive(cmd.id);
  assert(
    JSON.stringify(panels.at(-1)).includes("分类：正常"),
    "Check verdict missing",
  );
  console.log(
    "PASS: actual reply /check returned native ephemeral rich AI probabilities without deletion.",
  );
  const review = await cn.sendMessage(chat, {
    message: `/review@${f.bot_username}`,
  });
  await receive(review.id);
  assert(
    JSON.stringify(panels.at(-1)).includes("近期审核样本"),
    "Review panel missing",
  );
  console.log(
    "PASS: actual /review returned native ephemeral rich sample panel.",
  );
  const blocked = await cn.sendMessage(chat, {
    message: `/check@${f.bot_username}`,
    replyTo: admin.id,
  });
  await receive(blocked.id);
  assert(
    JSON.stringify(panels.at(-1)).includes("未上传"),
    "Admin check did not skip",
  );
  console.log(
    "PASS: manual check also refuses to upload administrator message.",
  );
} finally {
  try {
    if (originalBio !== undefined) {
      await us.invoke(new Api.account.UpdateProfile({ about: originalBio }));
    }
    if (newPhoto) {
      await us.invoke(
        new Api.photos.DeletePhotos({
          id: [
            new Api.InputPhoto({
              id: newPhoto.id,
              accessHash: newPhoto.accessHash,
              fileReference: newPhoto.fileReference,
            }),
          ],
        }),
      );
    }
    if (originalPhoto) {
      await us.invoke(
        new Api.photos.UpdateProfilePhoto({
          id: new Api.InputPhoto({
            id: originalPhoto.id,
            accessHash: originalPhoto.accessHash,
            fileReference: originalPhoto.fileReference,
          }),
        }),
      );
    }
    console.log("TEST profile restored.");
  } finally {
    store.close();
    await Promise.all([cn.destroy(), us.destroy()]);
  }
}
