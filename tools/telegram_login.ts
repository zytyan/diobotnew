/** Separate MTProto test tool. Never import account sessions into the bot. */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index < 0 ? undefined : Deno.args[index + 1];
}
async function readLine(): Promise<string> {
  const bytes: number[] = [];
  const byte = new Uint8Array(1);
  while (await Deno.stdin.read(byte) !== null) {
    if (byte[0] === 10) {
      return new TextDecoder().decode(new Uint8Array(bytes)).trim();
    }
    if (byte[0] !== 13) bytes.push(byte[0]);
    if (bytes.length > 4096) throw new Error("输入过长");
  }
  throw new Error("输入已关闭");
}
async function privateFile(path: string, content: string) {
  await Deno.writeTextFile(path, content, { mode: 0o600 });
  await Deno.chmod(path, 0o600);
}

async function main() {
  if (Deno.args.includes("--help")) {
    console.log(
      "测试账号登录：--environment prod|test --alias account-name --phone +123...\n需要环境变量 TELEGRAM_API_ID / TELEGRAM_API_HASH。验证码从标准输入读取，session 保存到被 Git 忽略的 data/test-accounts/，不会输出 session。仅登录，不发送消息、不修改群组。",
    );
    return;
  }
  const environment = argument("--environment");
  const alias = argument("--alias");
  const phone = argument("--phone");
  const apiId = Number(Deno.env.get("TELEGRAM_API_ID"));
  const apiHash = Deno.env.get("TELEGRAM_API_HASH");
  if (environment !== "prod" && environment !== "test") {
    throw new Error("请显式指定 --environment prod 或 test");
  }
  if (!alias || !/^[a-z0-9-]{1,40}$/.test(alias)) {
    throw new Error("请指定安全的 --alias");
  }
  if (!phone || !/^\+\d{7,15}$/.test(phone)) {
    throw new Error("--phone 必须为国际格式");
  }
  if (
    !Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash ||
    !/^[a-f0-9]{32}$/i.test(apiHash)
  ) {
    throw new Error(
      "缺少有效的 TELEGRAM_API_ID / TELEGRAM_API_HASH，尚未请求验证码",
    );
  }
  const dir = new URL(`../data/test-accounts/${environment}/`, import.meta.url);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.chmod(dir, 0o700);
  const path = new URL(`${alias}.session`, dir).pathname;
  let saved = "";
  try {
    saved = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const session = new StringSession(saved);
  // A separate test DC is required; the production session is never reused.
  if (!saved && environment === "test") session.setDC(2, "149.154.167.40", 80);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 2,
    requestRetries: 3,
    autoReconnect: false,
    testServers: environment === "test",
    deviceModel: "Diobot API integration tests",
    appVersion: "0.1.0",
  });
  client.setLogLevel("none" as Parameters<typeof client.setLogLevel>[0]);
  try {
    await client.start({
      phoneNumber: phone,
      phoneCode: async () => {
        // Persist the auth key before waiting: no secret is printed to stdout.
        await privateFile(path, session.save());
        console.log(
          `${alias} (${environment}，尾号 ${
            phone.slice(-4)
          }) 已请求验证码，请提供验证码。`,
        );
        return await readLine();
      },
      password: async () => {
        console.log(`${alias} 需要两步验证密码，请输入后继续。`);
        return await readLine();
      },
      onError: (error: Error) => {
        throw error;
      },
    });
    await privateFile(path, session.save());
    const me = await client.getMe();
    console.log(
      JSON.stringify({
        account: alias,
        environment,
        authorized: true,
        user_id: me.id.toString(),
      }),
    );
  } finally {
    await client.disconnect();
    await client.destroy();
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Do not print exception stacks, request bodies, codes or session strings.
    const text = error instanceof Error ? error.message : "未知错误";
    console.error(text.replace(/\+\d{7,15}/g, "[phone]"));
    Deno.exitCode = 1;
  }
}
