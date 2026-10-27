/** Run the compiled binary against the isolated test fixture only. */
const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../data/test-accounts/test/fixture.json", import.meta.url),
  ),
);
const executable = new URL("../dist/diobot", import.meta.url).pathname;
const child = new Deno.Command(executable, {
  clearEnv: true,
  env: {
    BOT_TOKEN: fixture.bot_token,
    TELEGRAM_ENV: "test",
    API_ROOT: "https://api.telegram.org",
    HOST: "127.0.0.1",
    PORT: "18532",
    DB_PATH:
      new URL("../data/test-accounts/test/manual.sqlite", import.meta.url)
        .pathname,
    PUBLIC_CHAT_IDS: fixture.chat_id,
    OWNER_IDS: `${fixture.owner_id},${fixture.other_id}`,
    MODERATION_MODE: "off",
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
