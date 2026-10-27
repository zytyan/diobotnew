/** Real Workers AI smoke test. Uses private deployment credentials, never Telegram messages. */
import { loadConfig } from "../src/config.ts";
import { moderate } from "../src/moderation.ts";
import { Store } from "../src/store.ts";
const runtime = JSON.parse(
  await Deno.readTextFile(
    new URL("../data/deploy/cf-runtime.json", import.meta.url),
  ),
);
const config = loadConfig({
  BOT_TOKEN: "0:cloudflare-smoke",
  TELEGRAM_ENV: "test",
  MODERATION_MODE: "observe",
  CF_ACCOUNT_ID: runtime.account_id,
  CF_API_TOKEN: runtime.token,
  AI_DAILY_LIMIT: "10",
  CF_MODEL: "@cf/cloudflare/clef-flash",
});
const store = new Store(":memory:");
const samples = [
  {
    name: "正常讨论",
    text: "这个 TypeScript 库支持 Deno 吗？我想用它管理 Telegram 群。",
    expected: ["normal"],
  },
  {
    name: "举报广告",
    text: "刚才那个日赚一万的广告明显是骗局，大家不要转账，请管理员处理。",
    expected: ["normal"],
  },
  {
    name: "商业引流",
    text:
      "全网最低价服务器代理热卖！限时促销，批量优惠，立即私聊 @example_sales 下单，欢迎代理加盟！",
    expected: ["advertisement", "scam"],
  },
  {
    name: "诈骗推广",
    text:
      "内部稳赚项目，充值100 USDT每天返利30 USDT，保证零风险，联系 @example_profit 立即进群赚钱！",
    expected: ["scam", "advertisement"],
  },
];
try {
  for (const [index, sample] of samples.entries()) {
    const start = performance.now();
    const result = await moderate(config, store, -1, index + 1, sample.text);
    console.log(
      JSON.stringify({
        sample: sample.name,
        label: result?.label,
        certainty: result?.certainty,
        score: result?.score,
        elapsed_ms: Math.round(performance.now() - start),
      }),
    );
    if (!result || !sample.expected.includes(result.label)) {
      throw new Error(`Unexpected classification: ${sample.name}`);
    }
  }
  console.log(
    "PASS: real Cloudflare Workers AI classification through the production adapter",
  );
} finally {
  store.close();
}
