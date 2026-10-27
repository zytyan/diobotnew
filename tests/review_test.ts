import { type ReviewInput, Store } from "../src/store.ts";
function assert(v: unknown): asserts v {
  if (!v) throw new Error("assertion failed");
}
const limits = { reviewDays: 7, reviewPerChat: 2, reviewMax: 3 };
const sample = (id: number, chat = -1): ReviewInput => ({
  chat,
  message: id,
  sender: 2,
  kind: "text",
  text: "Alice",
  profile: '{"sender":{"display_name":"Alice"}}',
  fingerprint: String(id),
  date: 1000,
  mode: "observe",
});
Deno.test("样本按版本去重、限制群/全局数量、清理过期数据和孤立头像", () => {
  const s = new Store(":memory:");
  const now = Date.now();
  try {
    const a = sample(1);
    a.avatar = {
      hash: "hash",
      mime: "image/jpeg",
      bytes: new Uint8Array([255, 216, 255]),
      base64: "/9j/",
    };
    const id = s.recordReview(a, limits, now)!;
    assert(
      s.recordReview(a, limits, now + 1) === id &&
        s.recentReviews(-1).length === 1,
    );
    assert(s.reviewAvatar("hash"));
    s.recordReview(sample(2), limits, now + 2);
    s.recordReview(sample(3), limits, now + 3);
    assert(s.recentReviews(-1).length === 2 && !s.reviewAvatar("hash"));
    s.recordReview(sample(4, -2), limits, now + 4);
    s.recordReview(sample(5, -2), limits, now + 5);
    assert(
      s.db.prepare("SELECT COUNT(*) AS n FROM review_messages").get()!.n === 3,
    );
    s.pruneReview(limits, now + 8 * 86400000);
    assert(!s.recentReviews(-1).length && !s.recentReviews(-2).length);
  } finally {
    s.close();
  }
});
Deno.test("标注绑定群、保留结果；管理员升权清理旧资料和缓存", () => {
  const s = new Store(":memory:");
  try {
    const id = s.recordReview(sample(1), limits)!;
    assert(!s.labelReview(id, -2, "normal", 1));
    assert(!s.labelReview(id, -1, "invalid", 1));
    assert(s.labelReview(id, -1, "normal", 1));
    s.reviewResult(id, "observed", { label: "advertisement" });
    assert(s.recentReviews(-1)[0].human_label === "normal");
    s.audit(-1, 1, "hash", "{}");
    s.forgetReviewSender(-1, 2);
    assert(!s.recentReviews(-1).length && !s.cached(-1, 1, "hash"));
    assert(
      s.recordReview(sample(2), { ...limits, reviewDays: 0 }) === undefined,
    );
  } finally {
    s.close();
  }
});
