/** Run the compiled binary against the isolated test fixture only. */
const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../data/test-accounts/test/fixture.json", import.meta.url),
  ),
);
const executable = new URL("../dist/diobot", import.meta.url).pathname;
const cloudflare: Record<string, string> = {};
try {
  const text = await Deno.readTextFile(
    new URL("../.env.cloudflare.test", import.meta.url),
  );
  const allowed = new Set([
    "CF_ACCOUNT_ID",
    "CF_API_TOKEN",
    "CF_MODEL",
    "AI_DAILY_LIMIT",
    "AI_CONFIDENCE_THRESHOLD",
    "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET",
    "VERIFY_HOSTNAME",
  ]);
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0 && allowed.has(line.slice(0, index))) {
      cloudflare[line.slice(0, index)] = line.slice(index + 1);
    }
  }
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
const child = new Deno.Command(executable, {
  clearEnv: true,
  env: {
    ...cloudflare,
    BOT_TOKEN: fixture.bot_token,
    TELEGRAM_ENV: "test",
    API_ROOT: "https://api.telegram.org",
    HOST: "127.0.0.1",
    PORT: "18532",
    DB_PATH:
      new URL("../data/test-accounts/test/manual.sqlite", import.meta.url)
        .pathname,
    PUBLIC_CHAT_IDS: fixture.chat_id,
    OWNER_IDS: fixture.owner_id,
    MODERATION_MODE: cloudflare.CF_API_TOKEN ? "observe" : "off",
  },
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
let stopping = false;
const stop = () => {
  if (!stopping) {
    stopping = true;
    try {
      child.kill("SIGTERM");
    } catch { /* Already exited. */ }
  }
};
Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);
try {
  Deno.exitCode = (await child.status).code;
} finally {
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
}
