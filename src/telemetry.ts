import { telegramIdentity } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const idPattern = /^[a-f0-9-]{16,64}$/;
const names = [
  "bootstrap_ready",
  "script_load",
  "page_ready",
  "navigation",
  "sdk_ready",
  "settings_load",
  "settings_save",
  "logs_load",
];
const errors = ["none", "network", "timeout", "http", "format", "unknown"];
const metrics = [
  "dns_ms",
  "connect_ms",
  "tls_ms",
  "ttfb_ms",
  "download_ms",
  "dom_ms",
  "load_ms",
  "server_ms",
];
function number(value: unknown, max: number): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > max
  ) throw new Error();
  return Math.round(value);
}
export function telemetryHandler(config: Config, store: Store) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: "不支持的请求方式" });
    }
    let user: number, chat: number;
    try {
      const header = request.headers.get("Authorization") ?? "";
      if (!header.startsWith("Telegram ") || header.length > 16384) {
        throw new Error();
      }
      const auth = await telegramIdentity(header.slice(9), config.token);
      const context = /^(settings|logs)_(-[1-9]\d*)$/.exec(auth.start);
      if (!context) throw new Error();
      user = auth.user;
      chat = Number(context[2]);
      if (!Number.isSafeInteger(chat)) throw new Error();
    } catch {
      return json(401, { error: "日志身份凭据无效或已过期" });
    }
    try {
      const reader = request.body?.getReader();
      if (!reader) return json(400, { error: "日志内容为空" });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) {
          await reader.cancel();
          return json(413, { error: "日志内容过大" });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (
        !body || typeof body !== "object" || Object.keys(body).some((k) =>
          !["session", "events"].includes(k)
        ) || typeof body.session !== "string" ||
        !idPattern.test(body.session) || !Array.isArray(body.events) ||
        body.events.length < 1 || body.events.length > 20
      ) throw new Error();
      const events = body.events.map((event: Record<string, unknown>) => {
        if (
          !event || typeof event !== "object" || Array.isArray(event) ||
          Object.keys(event).some((k) =>
            ![
              "id",
              "name",
              "duration_ms",
              "status",
              "error",
              "request_id",
              "resource",
              "timing_detail",
              "metrics",
            ].includes(k)
          )
        ) throw new Error();
        if (
          typeof event.id !== "string" || !idPattern.test(event.id) ||
          (typeof event.name !== "string" || !names.includes(event.name)) ||
          (typeof event.error !== "string" || !errors.includes(event.error))
        ) throw new Error();
        const status = number(event.status, 599);
        const duration_ms = number(event.duration_ms, 86400_000);
        if (
          event.request_id !== undefined &&
          (typeof event.request_id !== "string" ||
            (event.request_id !== "" && !idPattern.test(event.request_id)))
        ) throw new Error();
        if (event.resource !== undefined) {
          if (
            typeof event.resource !== "string" || event.resource.length > 512 ||
            !["full", "restricted"].includes(String(event.timing_detail))
          ) throw new Error();
          const resource = new URL(event.resource);
          if (
            !["http:", "https:"].includes(resource.protocol) ||
            resource.username || resource.password || resource.search ||
            resource.hash
          ) throw new Error();
        } else if (
          event.timing_detail !== undefined || event.name === "script_load"
        ) throw new Error();
        const timing: Record<string, number> = {};
        if (event.metrics !== undefined) {
          if (
            !event.metrics || typeof event.metrics !== "object" ||
            Array.isArray(event.metrics)
          ) throw new Error();
          for (const [key, value] of Object.entries(event.metrics)) {
            if (!metrics.includes(key)) throw new Error();
            timing[key] = number(value, 86400_000);
          }
        }
        return {
          id: event.id,
          name: event.name,
          duration_ms,
          status,
          error: event.error,
          request_id: event.request_id ?? "",
          metrics: timing,
          ...(event.resource !== undefined
            ? { resource: event.resource, timing_detail: event.timing_detail }
            : {}),
        };
      });
      if (!store.clientTimings(user, chat, body.session, events)) {
        return json(429, { error: "日志提交过于频繁，请稍后重试" });
      }
      console.info(
        JSON.stringify({
          event: "web_client_timings",
          user_id: user,
          chat_id: chat,
          session: body.session,
          accepted: events.length,
          max_duration_ms: Math.max(
            ...events.map((event: { duration_ms: number }) =>
              event.duration_ms
            ),
          ),
          failures: events.filter((event: { error: string }) =>
            event.error !== "none"
          ).length,
        }),
      );
      return json(202, { accepted: events.length });
    } catch {
      return json(400, { error: "日志格式无效" });
    }
  };
}
