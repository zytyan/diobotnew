/** Real Clef prompt-only regression; public ad texts and synthetic controls, no profiles/images. */
import type { Message } from "grammy/types";
import {
  buildModerationRequest,
  parseProviderVerdict,
} from "../src/moderation.ts";
import { messageContent } from "../src/message_content.ts";
import { messageEvidence } from "../src/message_evidence.ts";
const legacy = JSON.parse(
  await Deno.readTextFile(
    new URL("fixtures/profile-v1-prompt.json", import.meta.url),
  ),
);
const runtime = JSON.parse(
  await Deno.readTextFile(
    new URL("../data/deploy/cf-runtime.json", import.meta.url),
  ),
);
const linkRule =
  " Telegram invitation links (t.me/, t.me/+invite, t.me/joinchat/), hidden links, 进群/加群/私聊 and arrows toward accounts are active funneling even without sales wording; legitimate project links and reports remain normal.";
const cardRule =
  " GROUP POLICY: a current Telegram contact-card message is contact promotion and advertisement, even a bare name/phone/user ID card without other sales text. The ordinary-name protection does not exempt an actual contact card.";
const replyRule =
  " evidence.replies is OTHER authors' reference_only material: reports/warnings about it remain normal. But 来发财 recruitment directing readers to a contact, via_bot or external-reply source is advertisement; the external reply is a navigable entry even without a body URL. Missing source text is unknown, never invent it.";
const merged = {
  ...legacy.criteria,
  advertisement: legacy.criteria.advertisement + " Also includes scams: " +
    legacy.criteria.scam,
};
delete merged.scam;
const baseInstructions = legacy.instructions.replace(
  "advertisement or scam",
  "advertisement (including scams)",
);
const phase2 = Deno.args.includes("--phase2");
const phase3 = Deno.args.includes("--phase3");
const referenceFix =
  " A contact card ONLY INSIDE evidence.replies is not a card posted by the current author. A current report/warning saying not to contact the referenced advertiser is normal, unless the author separately solicits contact or promotes. Judge this from the current message, not the quoted card text.";
const replayCriteria = {
  ...legacy.criteria,
  advertisement: legacy.criteria.advertisement +
    " Current contact cards and recruitment via external-reply entry points count as contact promotion.",
};
const fixedCriteria = {
  ...replayCriteria,
  normal: legacy.criteria.normal +
    " Reports or warnings against OTHER authors contact cards remain normal, even when reference-only cards contain actionable contact details.",
  advertisement: replayCriteria.advertisement +
    " Excludes OTHER authors cards cited solely to report or warn against them.",
  scam: legacy.criteria.scam +
    " Excludes warnings against or reporting OTHER authors scams.",
};
const variants = phase3
  ? [
    {
      name: "four-plus-reply-repeat",
      instructions: legacy.instructions + linkRule + cardRule + replyRule,
      criteria: replayCriteria,
    },
    {
      name: "four-reference-fix",
      instructions: legacy.instructions + linkRule + cardRule + replyRule +
        referenceFix,
      criteria: fixedCriteria,
    },
    {
      name: "four-reference-first",
      instructions: referenceFix + legacy.instructions + linkRule + cardRule +
        replyRule,
      criteria: fixedCriteria,
    },
  ]
  : phase2
  ? [
    {
      name: "four-plus-links",
      instructions: legacy.instructions + linkRule,
      criteria: legacy.criteria,
    },
    {
      name: "four-plus-card",
      instructions: legacy.instructions + linkRule + cardRule,
      criteria: {
        ...legacy.criteria,
        advertisement: legacy.criteria.advertisement +
          " A current contact card itself is contact promotion, even without other text.",
      },
    },
    {
      name: "four-plus-reply",
      instructions: legacy.instructions + linkRule + cardRule + replyRule,
      criteria: {
        ...legacy.criteria,
        advertisement: legacy.criteria.advertisement +
          " Current contact cards and recruitment via external-reply entry points count as contact promotion.",
      },
    },
    {
      name: "merged-direct",
      instructions: legacy.instructions.replace(
        "advertisement or scam",
        "advertisement",
      ),
      criteria: {
        ...merged,
        advertisement: legacy.criteria.advertisement + " " +
          legacy.criteria.scam,
      },
    },
    { name: "current-compact", compact: true },
    {
      name: "four-all-compact",
      compact: true,
      instructions: legacy.instructions + linkRule + cardRule + replyRule,
      criteria: {
        ...legacy.criteria,
        advertisement: legacy.criteria.advertisement +
          " Current contact cards and recruitment via external-reply entry points count as contact promotion.",
      },
    },
  ]
  : [
    {
      name: "old-four",
      instructions: legacy.instructions,
      criteria: legacy.criteria,
    },
    { name: "old-merged", instructions: baseInstructions, criteria: merged },
    {
      name: "plus-links",
      instructions: baseInstructions + linkRule,
      criteria: merged,
    },
    {
      name: "plus-card",
      instructions: baseInstructions + linkRule + cardRule,
      criteria: {
        ...merged,
        advertisement: merged.advertisement +
          " A current contact card itself counts as contact promotion.",
      },
    },
    {
      name: "plus-reply",
      instructions: baseInstructions + linkRule + cardRule + replyRule,
      criteria: {
        ...merged,
        advertisement: merged.advertisement +
          " A current contact card itself counts as contact promotion; recruitment via external reply entry points also counts.",
      },
    },
    { name: "current-v5" },
  ];
const base = {
  message_id: 1,
  date: 1,
  chat: { id: -1, type: "supergroup", title: "Group" },
  from: { id: 42, is_bot: false, first_name: "Member" },
} as const;
const card = {
  ...base,
  contact: {
    first_name: "联系人",
    phone_number: "+12025550123",
    user_id: 999999999999,
  },
} as Message;
const external = {
  origin: {
    type: "channel",
    date: 1,
    chat: { id: -2, type: "channel", title: "发财交流" },
    message_id: 9,
  },
  contact: card.contact,
} as const;
const cases: {
  name: string;
  group: string;
  expected: "advertisement" | "normal";
  message: Message;
}[] = [];
const text = (
  name: string,
  value: string,
  expected: "advertisement" | "normal",
  group = "history",
) =>
  cases.push({
    name,
    expected,
    group,
    message: { ...base, text: value } as Message,
  });
text("洗米九千", "有码干洗米 赚九千", "advertisement");
text("洗资八千", "替我洗资 日八千", "advertisement");
text(
  "足球荐群",
  "⚽五大联赛足球红单推荐群⚽天天收米🐛日赚一万 @ydjfh1028bot",
  "advertisement",
);
text("收款八千", "有码来帮我收款 赚8千", "advertisement");
text("短句收益", "几分钟搞1k", "advertisement");
text("谐音戏钱", "有码来替我戏钱 赚9千", "advertisement");
text(
  "箭头加群",
  "👇进群 https://t.me/+syntheticInvite",
  "advertisement",
  "new",
);
text(
  "举报广告",
  "举报这条广告，请管理员处理，不要联系他。",
  "normal",
  "control",
);
text("技术讨论", "这个 TypeScript 库支持 Deno 吗？", "normal", "control");
text(
  "项目链接",
  "Deno 的源码在 https://github.com/denoland/deno",
  "normal",
  "control",
);
text("普通姓名", "张伟", "normal", "control");
text("祝福发财", "祝大家新年快乐，恭喜发财！", "normal", "control");
cases.push({
  name: "直接名片",
  group: "new",
  expected: "advertisement",
  message: card,
});
cases.push({
  name: "跨频道招揽",
  group: "new",
  expected: "advertisement",
  message: { ...base, text: "来发财", external_reply: external } as Message,
});
cases.push({
  name: "回复名片招揽",
  group: "new",
  expected: "advertisement",
  message: {
    ...base,
    text: "来发财，联系这个人",
    reply_to_message: card,
  } as Message,
});
cases.push({
  name: "举报引用名片",
  group: "control",
  expected: "normal",
  message: {
    ...base,
    text: "举报这条‘来发财’广告，不要联系他，请管理员处理。",
    reply_to_message: card,
  } as Message,
});
cases.push({
  name: "投票推广",
  group: "new",
  expected: "advertisement",
  message: {
    ...base,
    poll: {
      id: "synthetic",
      question: "日赚一万，联系 @example_profit_bot 进群参与",
      options: [{ text: "进群", voter_count: 0 }, {
        text: "私聊",
        voter_count: 0,
      }],
      total_voter_count: 0,
      is_closed: false,
      is_anonymous: true,
      type: "regular",
      allows_multiple_answers: false,
    },
  } as Message,
});
if (phase3) {
  cases.push({
    name: "求助举报名片",
    group: "holdout",
    expected: "normal",
    message: {
      ...base,
      text: "这个人在发赌博广告，怎么举报？别加他。",
      reply_to_message: card,
    } as Message,
  });
  cases.push({
    name: "跨频道举报",
    group: "holdout",
    expected: "normal",
    message: {
      ...base,
      text: "这条日赚一万是骗局，大家不要联系。",
      external_reply: external,
    } as Message,
  });
  cases.push({
    name: "名片求助",
    group: "holdout",
    expected: "normal",
    message: {
      ...base,
      text: "我收到了这人的诈骗消息，怎么屏蔽这个人？",
      reply_to_message: card,
    } as Message,
  });
  text(
    "正常产品讨论",
    "我最近买了一个机械键盘，声音有点大，有什么办法改善？",
    "normal",
    "holdout",
  );
  text(
    "推广伪装举报",
    "举报骗子没用，来找我稳赚，充值100每天返30，联系 @example_profit_bot",
    "advertisement",
    "holdout",
  );
  text(
    "谐音招募",
    "缺几个兄弟帮忙走账，有收款码的来，一天八千，私聊我",
    "advertisement",
    "holdout",
  );
}
const quotedPromotion = {
  text: "日赚一万，联系 @example_profit_bot 进群参与",
  position: 0,
};
cases.push({
  name: "跨频道招揽含引用文字",
  group: "quoted_pair",
  expected: "advertisement",
  message: {
    ...base,
    text: "来发财",
    external_reply: external,
    quote: quotedPromotion,
  } as Message,
});
cases.push({
  name: "跨频道举报含引用文字",
  group: "quoted_pair",
  expected: "normal",
  message: {
    ...base,
    text: "这条日赚一万是骗局，大家不要联系。",
    external_reply: external,
    quote: quotedPromotion,
  } as Message,
});
const results: Record<string, unknown>[] = [];
for (const variant of variants) {
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < cases.length) {
      const sample = cases[cursor++], content = messageContent(sample.message);
      const payload = buildModerationRequest(
        content.text,
        "@cf/cloudflare/clef-flash",
        {
          messageKind: content.kind,
          links: content.links,
          evidence: messageEvidence(sample.message, content),
        },
      );
      if (
        sample.message.quote &&
        (!("state" in payload) ||
          payload.state.evidence?.replies.at(-1)?.quote_text !==
            sample.message.quote.text)
      ) throw new Error("Quote missing from outgoing AI request");
      if (!("questions" in payload)) throw new Error("Expected Clef payload");
      if ("compact" in variant && variant.compact) {
        if (!payload.state.sender) {
          delete (payload.state as Record<string, unknown>).sender;
        }
        if (
          !payload.state.evidence?.contacts.length &&
          !payload.state.evidence?.replies.length &&
          !payload.state.evidence?.via_bot &&
          !payload.state.evidence?.forwarded_from
        ) delete (payload.state as Record<string, unknown>).evidence;
        if (!payload.state.links.length) {
          delete (payload.state as Record<string, unknown>).links;
        }
      }
      if (variant.instructions) {
        payload.questions.classification.instructions = variant.instructions;
        payload.questions.classification.criteria = variant.criteria;
      }
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${
            encodeURIComponent(runtime.account_id)
          }/ai/run/@cf/cloudflare/clef-flash`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${runtime.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("HTTP " + response.status);
        }
        const verdict = parseProviderVerdict(await response.json(), .8);
        results.push({
          variant: variant.name,
          sample: sample.name,
          group: sample.group,
          expected: sample.expected,
          label: verdict.label,
          advertisement: verdict.probabilities?.advertisement,
          normal: verdict.probabilities?.normal,
          uncertain: verdict.probabilities?.uncertain,
        });
      } catch (error) {
        results.push({
          variant: variant.name,
          sample: sample.name,
          error: String(error),
        });
      }
    }
  }));
  console.log(JSON.stringify({ completed: variant.name, cases: cases.length }));
}
const output =
  Deno.args.find((arg) => arg !== "--phase2" && arg !== "--phase3") ??
    (phase3
      ? "/tmp/diobot-prompt-regression-phase3.json"
      : phase2
      ? "/tmp/diobot-prompt-regression-phase2.json"
      : "/tmp/diobot-prompt-regression.json");
await Deno.writeTextFile(
  output,
  JSON.stringify(
    {
      created: new Date().toISOString(),
      model: "@cf/cloudflare/clef-flash",
      notes:
        "Same structured message evidence for every variant; no profiles, avatars or production writes. Historical labels inferred from clear promotion; controls synthetic. Old-four ad and scam probabilities combined.",
      variants,
      cases: cases.map((c) => ({
        name: c.name,
        group: c.group,
        expected: c.expected,
      })),
      results,
    },
    null,
    2,
  ),
);
for (const variant of variants) {
  const rows = results.filter((r) => r.variant === variant.name);
  const ads = rows.filter((r) => r.expected === "advertisement"),
    normal = rows.filter((r) => r.expected === "normal");
  console.log(JSON.stringify({
    variant: variant.name,
    errors: rows.filter((r) => r.error).length,
    ad_count: ads.length,
    ad_at80: ads.filter((r) => Number(r.advertisement) >= .8).length,
    ad_at85: ads.filter((r) => Number(r.advertisement) >= .85).length,
    false_positive_at80: normal.filter((r) =>
      Number(r.advertisement) >= .8
    ).length,
    normal_labels: normal.filter((r) => r.label === "normal").length,
    normal_count: normal.length,
  }));
}
console.log("Report: " + output);
