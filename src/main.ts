import { run } from "@grammyjs/runner";
import { createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { createHandler } from "./server.ts";
import { Store } from "./store.ts";

const version = "0.1.0";
if (Deno.args.includes("--version")) {
  console.log(`diobot ${version}`);
} else if (Deno.args.includes("--help")) {
  console.log(
    "diobot [--help | --version | --check]\n配置使用环境变量，参见 .env.example；--check 仅检查配置，不连接 Telegram。",
  );
} else {
  const config = loadConfig();
  if (Deno.args.includes("--check")) {
    console.log(
      `配置有效：Telegram ${config.environment}；审核 ${config.moderationMode}`,
    );
  } else {
    const store = new Store(config.dbPath);
    const { bot, sweep } = createBot(config, store);
    const page = await Deno.readTextFile(
      new URL("../web/index.html", import.meta.url),
    );
    // Initialize first: no server/worker is left running if the token is invalid.
    await bot.init();
    await bot.api.setMyCommands([
      { command: "settings", description: "配置本群功能", is_ephemeral: true },
      {
        command: "tree",
        description: "处理被封禁成员的直接邀请",
        is_ephemeral: true,
      },
    ], { scope: { type: "all_chat_administrators" } });
    const server = Deno.serve(
      { hostname: config.hostname, port: config.port },
      createHandler(config, store, page),
    );
    const runner = run(bot, {
      runner: {
        fetch: {
          timeout: 15,
          allowed_updates: [
            "message",
            "edited_message",
            "my_chat_member",
            "chat_member",
            "chat_join_request",
            "callback_query",
          ],
        },
      },
      sink: { concurrency: 16 },
    });
    let sweeping: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (sweeping) return;
      sweeping = sweep().catch(() => console.error("申请处理失败，稍后重试"))
        .finally(() => {
          sweeping = undefined;
        });
    }, 2000);
    console.info(
      `@${bot.botInfo.username} 已启动，环境=${config.environment}，审核=${config.moderationMode}`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      await runner.stop();
      await server.shutdown();
      await sweeping;
      store.close();
    };
    Deno.addSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop);
    try {
      await runner.task();
    } finally {
      await stop();
    }
  }
}
