import {
  moderationCriteria,
  moderationInstructions,
} from "./moderation_policy.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import {
  fingerprint,
  type ModerationContext,
  profileState,
} from "./profiles.ts";

const labels = ["normal", "advertisement", "uncertain"] as const;
const legacyLabels = ["normal", "advertisement", "scam", "uncertain"] as const;
type Label = typeof labels[number];
type Probabilities =
  & Record<"normal" | "advertisement", number>
  & Partial<Record<"uncertain", number>>;
const binaryLabels = ["normal", "advertisement"] as const;
const policyVersion = "2026-10-binary-reply-v6";
export interface Verdict {
  label: Label;
  certainty: "high" | "low";
  reason: string;
  score?: number;
  probabilities?: Probabilities;
  model?: string;
  policy?: string;
}
export function parseVerdict(value: string): Verdict {
  const parsed = JSON.parse(value);
  if (
    !parsed ||
    !["normal", "advertisement", "scam", "uncertain"].includes(parsed.label) ||
    !["high", "low"].includes(parsed.certainty) ||
    typeof parsed.reason !== "string" || parsed.reason.length > 500
  ) {
    throw new Error("模型返回结构无效");
  }
  return {
    label: parsed.label === "scam" ? "advertisement" : parsed.label,
    certainty: parsed.certainty,
    reason: parsed.reason,
    ...(parsed.score === undefined ? {} : { score: probability(parsed.score) }),
    ...(parsed.probabilities === undefined
      ? {}
      : { probabilities: distribution(parsed.probabilities) }),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    ...(typeof parsed.policy === "string" ? { policy: parsed.policy } : {}),
  };
}
export async function moderate(
  config: Config,
  store: Store,
  chat: number,
  message: number,
  text: string,
  request: typeof fetch = fetch,
  context?: ModerationContext,
  options: { force?: boolean } = {},
): Promise<Verdict | undefined> {
  if (!store.avatarEnabled(chat) && context?.avatar) {
    context = { ...context, avatar: undefined };
  }
  const threshold = store.groupThreshold(chat) ?? config.aiThreshold;
  const cachePolicy = `${policyVersion}:${threshold}`;
  const inputHash = await fingerprint({ text, context: profileState(context) });
  const cached = store.cached(chat, message, inputHash);
  if (cached && !options.force) {
    const previous = parseVerdict(cached);
    if (
      previous.model === config.cfModel && previous.policy === cachePolicy
    ) return previous;
  }
  if (!store.spend(config.aiDailyLimit)) return;
  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(config.cfAccount)
    }/ai/run/${config.cfModel}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${config.cfToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildModerationRequest(text, config.cfModel, context),
      ),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`AI HTTP ${response.status}`);
  }
  const body = await response.json();
  const verdict = {
    ...parseProviderVerdict(body, threshold),
    model: config.cfModel,
    policy: cachePolicy,
  };
  store.audit(chat, message, inputHash, JSON.stringify(verdict));
  return verdict;
}

const instructions =
  `${moderationInstructions}\nOnly output JSON: {"label":"normal|advertisement","certainty":"high|low","reason":"20字以内理由"}.`;
export function buildModerationRequest(
  text: string,
  model: string,
  context?: ModerationContext,
) {
  const multimodal = model === "@cf/cloudflare/clef-flash" ||
    model === "@cf/cloudflare/clef";
  const profile = context?.profile;
  const state = {
    sender: profile
      ? {
        display_name: profile.display_name,
        is_bot: profile.is_bot,
        username: profile.username,
        bio: profile.bio,
        bio_status: profile.bio_status,
      }
      : null,
    message_kind: context?.messageKind ?? "text",
    links: context?.links?.slice(0, 8).map((link) => link.slice(0, 512)) ?? [],
    message: text.slice(0, 8000),
    evidence: context?.evidence ?? null,
    ...(multimodal && context?.avatar
      ? { avatar: { status: "image_attached", image_index: 0 } }
      : {}),
  };
  if (multimodal) {
    return {
      model: model.endsWith("clef-flash") ? "clef-flash" : "clef",
      state,
      ...(context?.avatar
        ? {
          images: [{
            content_type: context.avatar.mime,
            base64: context.avatar.base64,
          }],
        }
        : {}),
      questions: {
        classification: {
          type: "choice",
          instructions: moderationInstructions,
          criteria: moderationCriteria,
        },
      },
    };
  }
  const data = JSON.stringify(state).replaceAll(
    "<",
    "\\u003c",
  ).replaceAll(">", "\\u003e");
  const options = {
    max_tokens: 160,
    temperature: 0,
    response_format: { type: "json_object" },
  };
  if (model.startsWith("@cf/qwen/qwen3-")) {
    // The Workers AI schema does not expose enable_thinking. Close the thinking
    // prefix in Qwen's documented raw template and require final JSON output.
    return {
      ...options,
      raw: true,
      prompt:
        `<|im_start|>system\n${instructions}<|im_end|>\n<|im_start|>user\n${data} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`,
    };
  }
  return {
    ...options,
    messages: [{ role: "system", content: instructions }, {
      role: "user",
      content: data,
    }],
  };
}
export function parseProviderVerdict(body: unknown, threshold = 0.80): Verdict {
  if (
    !body || typeof body !== "object" || !("success" in body) ||
    body.success !== true || !("result" in body) || !body.result ||
    typeof body.result !== "object"
  ) throw new Error("AI 返回无效");
  if ("answers" in body.result) {
    return parseClefVerdict(body.result.answers, threshold);
  }
  const result = body.result as {
    response?: unknown;
    choices?: { finish_reason?: string; message?: { content?: unknown } }[];
  };
  const choice = result.choices?.[0];
  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    throw new Error("AI 输出未完整结束");
  }
  const output = result.response ?? choice?.message?.content;
  if (typeof output === "string") return parseVerdict(output);
  if (output && typeof output === "object") {
    return parseVerdict(JSON.stringify(output));
  }
  // Never treat hidden reasoning as the final moderation decision.
  throw new Error("AI 没有返回最终分类");
}

function probability(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > 1
  ) throw new Error("AI 分类概率无效");
  return value;
}
function distribution(value: unknown): Probabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 分类概率缺失");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const expected: readonly string[] = Object.hasOwn(input, "scam")
    ? legacyLabels
    : Object.hasOwn(input, "uncertain")
    ? labels
    : binaryLabels;
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new Error("AI 分类选项不匹配");
  }
  const values = Object.fromEntries(
    expected.map((label) => [label, probability(input[label])]),
  );
  const probabilities: Probabilities = {
    normal: values.normal,
    advertisement: values.advertisement + (values.scam ?? 0),
    ...(Object.hasOwn(input, "uncertain")
      ? { uncertain: values.uncertain }
      : {}),
  };
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 0.01) throw new Error("AI 分类概率总和无效");
  return probabilities;
}
function parseClefVerdict(value: unknown, threshold: number): Verdict {
  if (
    !value || typeof value !== "object" || !("classification" in value) ||
    !value.classification || typeof value.classification !== "object"
  ) throw new Error("Clef 分类结果缺失");
  const answer = value.classification as {
    type?: string;
    choice?: unknown;
    probabilities?: unknown;
    confidence?: unknown;
  };
  if (
    answer.type !== "choice" ||
    !legacyLabels.includes(answer.choice as typeof legacyLabels[number])
  ) {
    throw new Error("Clef 分类结果无效");
  }
  const raw = answer.probabilities as Record<string, unknown>;
  const probabilities = distribution(raw);
  const selected = probability(raw[String(answer.choice)]);
  if (Object.values(raw).some((p) => probability(p) > selected + 1e-8)) {
    throw new Error("Clef 分类与概率不一致");
  }
  // Legacy four-way results are combined before selecting the winning category.
  const label = labels.reduce(
    (best, next) =>
      (probabilities[next] ?? 0) > (probabilities[best] ?? 0) ? next : best,
    answer.choice === "scam" ? "advertisement" : answer.choice as Label,
  );

  probability(answer.confidence);
  const score = probabilities[label] ?? 0;
  if (Object.values(probabilities).some((p) => p > score + 1e-8)) {
    throw new Error("Clef 分类与概率不一致");
  }
  return {
    label,
    certainty: score >= threshold ? "high" : "low",
    score,
    probabilities,
    reason: `Clef 分类 ${label}，模型概率 ${(score * 100).toFixed(1)}%`,
  };
}
