export interface Config {
  token: string;
  environment: "prod" | "test";
  apiRoot: string;
  hostname: string;
  port: number;
  dbPath: string;
  siteKey: string;
  secret: string;
  verifyHostname: string;
  publicChats: Set<number>;
  owners: Set<number>;
  cfAccount: string;
  cfToken: string;
  cfModel: string;
  moderationMode: "off" | "observe" | "delete";
  aiDailyLimit: number;
  aiThreshold: number;
  reviewDays: number;
  reviewPerChat: number;
  reviewMax: number;
}

function ids(value = ""): Set<number> {
  const values = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (
    values.some((s) => !/^-?\d+$/.test(s) || !Number.isSafeInteger(Number(s)))
  ) {
    throw new Error("群 ID / 管理员 ID 必须是逗号分隔的整数");
  }
  return new Set(values.map(Number));
}

export function loadConfig(env = Deno.env.toObject()): Config {
  const environment = env.TELEGRAM_ENV ?? "prod";
  const moderationMode = env.MODERATION_MODE ?? "off";
  const port = Number(env.PORT ?? "8532");
  const aiDailyLimit = Number(env.AI_DAILY_LIMIT ?? "1000");
  const aiThreshold = Number(env.AI_CONFIDENCE_THRESHOLD ?? "0.98");
  if (!Number.isFinite(aiThreshold) || aiThreshold < 0.5 || aiThreshold > 1) {
    throw new Error("AI_CONFIDENCE_THRESHOLD 必须在 0.5 到 1 之间");
  }
  const reviewDays = Number(env.REVIEW_RETENTION_DAYS ?? "7");
  const reviewPerChat = Number(env.REVIEW_MESSAGES_PER_CHAT ?? "1000");
  const reviewMax = Number(env.REVIEW_MAX_MESSAGES ?? "10000");
  if (
    !Number.isInteger(reviewDays) || reviewDays < 0 || reviewDays > 30 ||
    !Number.isInteger(reviewPerChat) || reviewPerChat < 1 ||
    reviewPerChat > 10000 || !Number.isInteger(reviewMax) || reviewMax < 1 ||
    reviewMax > 100000
  ) throw new Error("近期样本保留期限或数量无效");
  if (!env.BOT_TOKEN) throw new Error("必须配置 BOT_TOKEN");
  if (environment !== "prod" && environment !== "test") {
    throw new Error("TELEGRAM_ENV 必须是 prod 或 test");
  }
  if (!["off", "observe", "delete"].includes(moderationMode)) {
    throw new Error("MODERATION_MODE 无效");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 无效");
  }
  if (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 0) {
    throw new Error("AI_DAILY_LIMIT 无效");
  }
  if (
    (env.TURNSTILE_SITE_KEY || env.TURNSTILE_SECRET || env.VERIFY_HOSTNAME) &&
    (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET || !env.VERIFY_HOSTNAME)
  ) {
    throw new Error(
      "必须配置 Turnstile keys 和 VERIFY_HOSTNAME（不自动回退测试 key）",
    );
  }
  if (
    environment === "prod" &&
    (env.TURNSTILE_SITE_KEY?.startsWith("1x000000") ||
      env.TURNSTILE_SECRET?.startsWith("1x000000"))
  ) {
    throw new Error("正式环境不允许使用 Turnstile 测试 key");
  }
  if (moderationMode !== "off" && (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN)) {
    throw new Error("开启 AI 审核需要 CF_ACCOUNT_ID 和 CF_API_TOKEN");
  }
  return {
    token: env.BOT_TOKEN,
    environment,
    apiRoot: env.API_ROOT ?? "https://api.telegram.org",
    hostname: env.HOST ?? "127.0.0.1",
    port,
    dbPath: env.DB_PATH ?? "data/diobot.sqlite",
    siteKey: env.TURNSTILE_SITE_KEY ?? "",
    secret: env.TURNSTILE_SECRET ?? "",
    verifyHostname: env.VERIFY_HOSTNAME ?? "",
    publicChats: ids(env.PUBLIC_CHAT_IDS),
    owners: ids(env.OWNER_IDS),
    cfAccount: env.CF_ACCOUNT_ID ?? "",
    cfToken: env.CF_API_TOKEN ?? "",
    cfModel: env.CF_MODEL ?? "@cf/cloudflare/clef-flash",
    moderationMode: moderationMode as Config["moderationMode"],
    aiDailyLimit,
    aiThreshold,
    reviewDays,
    reviewPerChat,
    reviewMax,
  };
}
