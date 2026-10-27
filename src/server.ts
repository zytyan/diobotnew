import type { Config } from "./config.ts";
import { telegramAuth } from "./auth.ts";
import type { Store } from "./store.ts";

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function createHandler(
  config: Config,
  store: Store,
  page: string,
  verifyFetch: typeof fetch = fetch,
) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/healthz") {
      return json(200, { ok: true });
    }
    if (request.method === "GET" && path === "/") {
      const key = config.siteKey.replaceAll("&", "&amp;").replaceAll(
        '"',
        "&quot;",
      ).replaceAll("<", "&lt;").replaceAll("'", "&#39;");
      return new Response(page.replace("__SITE_KEY__", key), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (path !== "/verify" || request.method !== "POST") {
      return json(404, { error: "Not found" });
    }
    try {
      const header = request.headers.get("Authorization") ?? "";
      if (!header.startsWith("Telegram ") || header.length > 16384) {
        return json(401, { error: "请在 Telegram 中打开验证链接" });
      }
      const auth = await telegramAuth(header.slice(9), config.token);
      const join = store.get(auth.session);
      if (!join || join.user_id !== auth.user) {
        return json(403, { error: "没有对应的入群申请" });
      }
      if (
        join.state === "verified" || join.state === "speech" ||
        join.state === "done"
      ) return json(200, { success: true });
      if (join.state !== "pending" || join.expires <= Date.now()) {
        return json(410, { error: "申请已失效，请重新申请入群" });
      }
      // Stream with a bound: Content-Length alone cannot limit chunked bodies.
      const reader = request.body?.getReader();
      if (!reader) return json(400, { error: "缺少验证码" });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) {
          await reader.cancel();
          return json(413, { error: "请求过大" });
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const token = JSON.parse(new TextDecoder().decode(body)).token;
      if (typeof token !== "string" || !token || token.length > 2048) {
        return json(400, { error: "无效验证码" });
      }
      const response = await verifyFetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          body: new URLSearchParams({ secret: config.secret, response: token }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        return json(503, { error: "验证服务暂时不可用，请重试" });
      }
      const result = await response.json();
      if (
        result["error-codes"]?.includes("internal-error") ||
        result["error-codes"]?.some((c: string) =>
          ["invalid-input-secret", "missing-input-secret"].includes(c)
        )
      ) {
        return json(503, { error: "验证服务暂时不可用，请重试" });
      }
      const success = result.success === true &&
        result.hostname === config.verifyHostname && result.action === "join" &&
        result.cdata === join.id;
      const changed = store.resolve(join.id, auth.user, success);
      if (!changed) {
        const current = store.get(join.id);
        if (current && ["verified", "speech", "done"].includes(current.state)) {
          return json(200, { success: true });
        }
        return json(410, { error: "申请已失效，请重新申请入群" });
      }
      return success
        ? json(200, { success: true })
        : json(400, { error: "验证未通过，请重试；最多尝试三次" });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return json(400, { error: "请求格式错误" });
      }
      if (error instanceof DOMException || error instanceof TypeError) {
        return json(503, { error: "网络异常，请重试" });
      }
      return json(401, { error: "身份信息无效或已过期，请重新打开验证链接" });
    }
  };
}
