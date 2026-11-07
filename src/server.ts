import { validateMediaPolicies } from "./media_store.ts";
import { validateRules } from "./rules.ts";
import { telemetryHandler } from "./telemetry.ts";
import { type SettingsDependencies, settingsHandler } from "./web_settings.ts";
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
  dependencies?: SettingsDependencies,
) {
  const key = config.siteKey.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll("'", "&#39;");
  // The validator is self-contained; embed its runtime JavaScript so browser and
  // server enforce exactly the same rule schema and RegExp syntax.
  const publicPage = page.replace("__SITE_KEY__", key).replace(
    "/*__RULE_VALIDATOR__*/ null",
    () => validateRules.toString(),
  ).replace(
    "/*__MEDIA_VALIDATOR__*/ null",
    () => validateMediaPolicies.toString(),
  );
  let pageTag: Promise<string> | undefined;
  const telemetry = telemetryHandler(config, store);
  const settings = dependencies
    ? settingsHandler(config, store, dependencies)
    : undefined;
  const media = dependencies
    ? settingsHandler(config, store, dependencies, "media")
    : undefined;
  const logs = dependencies
    ? settingsHandler(config, store, dependencies, "logs")
    : undefined;
  const raw = dependencies
    ? settingsHandler(config, store, dependencies, "raw")
    : undefined;
  const replay = dependencies
    ? settingsHandler(config, store, dependencies, "reanalyze")
    : undefined;
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/api/media-blacklist") {
      return media
        ? await media(request)
        : json(503, { error: "媒体黑名单服务不可用" });
    }
    if (path === "/api/reanalyze") {
      return replay
        ? await replay(request)
        : json(503, { error: "重新分析服务不可用" });
    }
    if (path === "/api/raw-message") {
      return raw ? await raw(request) : json(503, { error: "样本服务不可用" });
    }
    if (path === "/api/logs") {
      return logs
        ? await logs(request)
        : json(503, { error: "日志服务不可用" });
    }
    if (path === "/api/client-logs") return await telemetry(request);
    if (path === "/api/settings") {
      const started = performance.now();
      const response = settings
        ? await settings(request)
        : json(503, { error: "设置服务不可用" });
      const elapsed = Math.round(performance.now() - started);
      const id = crypto.randomUUID();
      response.headers.set("X-Request-ID", id);
      response.headers.set("Server-Timing", `settings;dur=${elapsed}`);
      console.info(
        JSON.stringify({
          event: "web_settings_request",
          id,
          method: request.method,
          status: response.status,
          duration_ms: elapsed,
        }),
      );
      return response;
    }
    if (request.method === "GET" && path === "/healthz") {
      return json(200, { ok: true });
    }
    if (request.method === "GET" && path === "/") {
      const etag = await (pageTag ??= crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(publicPage),
      ).then((bytes) =>
        'W/"' + Array.from(new Uint8Array(bytes), (value) =>
          value.toString(16).padStart(2, "0")).join("") +
        '"'
      ));
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, no-cache",
        "ETag": etag,
      };
      if (
        request.headers.get("If-None-Match")?.split(",").map((value) =>
          value.trim()
        ).includes(etag)
      ) return new Response(null, { status: 304, headers });
      return new Response(publicPage, { headers });
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
        join.state === "verified" ||
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
        await response.body?.cancel();
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
        if (current && ["verified", "done"].includes(current.state)) {
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
