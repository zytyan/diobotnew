import type { Api } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.ts";
import {
  MEDIA_VERSION,
  type MediaEntry,
  type MediaKind,
  type MediaPolicies,
  type MediaPolicy,
  MediaStore,
} from "./media_store.ts";

export interface MediaSource {
  kind: MediaKind;
  format: "image" | "tgs" | "webm";
  file: string;
  unique: string;
  aliases: string[];
  set?: string;
  size?: number;
  document?: boolean;
}
export interface PdqResult {
  hash: string;
  quality: number;
}
export interface MediaMatch {
  model: "local-media";
  entry_id: number;
  type: MediaEntry["type"];
  kind: MediaKind;
  value: string;
  action: MediaPolicy["action"];
  reason: string;
  distance?: number;
  quality?: number;
  entry_quality?: number;
}
export function mediaSource(message: Message): MediaSource | undefined {
  if (message.sticker) {
    const s = message.sticker;
    return {
      kind: "sticker",
      format: s.is_animated ? "tgs" : s.is_video ? "webm" : "image",
      file: s.file_id,
      unique: s.file_unique_id,
      aliases: [s.file_unique_id],
      set: s.set_name,
      size: s.file_size,
    };
  }
  if (message.photo?.length) {
    const choices = message.photo;
    const p = choices.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b
    );
    return {
      kind: "image",
      format: "image",
      file: p.file_id,
      unique: p.file_unique_id,
      aliases: choices.map((p) => p.file_unique_id),
      size: p.file_size,
    };
  }
  const d = message.document;
  if (
    d &&
    (["image/jpeg", "image/png", "image/webp"].includes(d.mime_type ?? "") ||
      /\.(jpe?g|png|webp)$/i.test(d.file_name ?? ""))
  ) {
    return {
      kind: "image",
      format: "image",
      file: d.file_id,
      unique: d.file_unique_id,
      aliases: [d.file_unique_id],
      size: d.file_size,
      document: true,
    };
  }
}
export function hamming(a: string, b: string): number {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) {
    throw new Error("Invalid PDQ hash");
  }
  let bits = BigInt("0x" + a) ^ BigInt("0x" + b), count = 0;
  while (bits) {
    bits &= bits - 1n;
    count++;
  }
  return count;
}
let active = 0;
const waiters: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
  else active++;
  try {
    return await work();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}
async function bounded(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        throw new Error("媒体文件或解码输出过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function pdqRgb(
  frame: { rgb: Uint8Array; width: number; height: number } | {
    json: Uint8Array;
  } | { media: Uint8Array; webm: boolean },
  signal?: AbortSignal,
): Promise<PdqResult> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./pdq_worker.ts", import.meta.url).href, {
    type: "module",
  });
  return await new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new Error("媒体处理超时"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      stop();
      data.error ? reject(new Error(data.error)) : resolve(data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stop();
      reject(new Error("PDQ worker失败"));
    };
    worker.postMessage(frame);
  });
}
export class MediaService {
  constructor(
    private store: MediaStore,
    private api: Pick<Api, "getFile">,
    private config: Config,
    private request: typeof fetch = fetch,
    private compute?: (source: MediaSource) => Promise<PdqResult>,
  ) {}
  async hash(source: MediaSource): Promise<PdqResult> {
    const cached = this.store.cached(source.unique);
    if (cached) return cached;
    const result = await slot(async () => {
      if (this.compute) return await this.compute(source);
      const signal = AbortSignal.timeout(10_000);
      const bytes = await this.download(source, signal);
      if (source.format === "tgs") {
        const json = await bounded(
          new Blob([bytes.slice().buffer]).stream().pipeThrough(
            new DecompressionStream("gzip"),
          ),
          4_194_304,
        );
        return await pdqRgb({ json }, signal);
      }
      if (
        source.document &&
        !(bytes[0] === 0xff && bytes[1] === 0xd8 ||
          bytes[0] === 0x89 && bytes[1] === 0x50 ||
          new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
            new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP")
      ) throw new Error("图片文件格式不支持");
      return await pdqRgb(
        { media: bytes, webm: source.format === "webm" },
        signal,
      );
    });
    this.store.cache(source.unique, result);
    return result;
  }
  private async download(source: MediaSource, signal: AbortSignal) {
    if ((source.size ?? 0) > 20 * 1024 * 1024) {
      throw new Error("媒体文件超过20MiB");
    }
    const file = await this.api.getFile(
      source.file,
      signal as unknown as Parameters<Api["getFile"]>[1],
    );
    if (!file.file_path || (file.file_size ?? 0) > 20 * 1024 * 1024) {
      throw new Error("无法下载媒体或文件超过20MiB");
    }
    if (file.file_path.startsWith("/")) {
      if (
        !this.config.localFileRoot ||
        !["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(this.config.apiRoot).hostname,
        )
      ) throw new Error("本地媒体读取未启用");
      const root = (await Deno.realPath(this.config.localFileRoot)).replace(
        /\/$/,
        "",
      );
      const path = await Deno.realPath(file.file_path);
      if (!path.startsWith(root + "/")) throw new Error("媒体路径越界");
      const handle = await Deno.open(path);
      try {
        const stat = await handle.stat();
        if (!stat.isFile || stat.size > 20 * 1024 * 1024) {
          throw new Error("本地媒体文件无效或超过20MiB");
        }
      } catch (error) {
        handle.close();
        throw error;
      }
      return await bounded(handle.readable, 20 * 1024 * 1024);
    }
    const response = await this.request(
      `${this.config.apiRoot.replace(/\/$/, "")}/file/bot${this.config.token}/${
        this.config.environment === "test" ? "test/" : ""
      }${file.file_path}`,
      { signal, redirect: "error" },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("媒体下载失败");
    }
    return await bounded(response.body, 20 * 1024 * 1024);
  }
  async match(
    chat: number,
    source: MediaSource,
    policies: MediaPolicies,
  ): Promise<MediaMatch | undefined> {
    const policy = policies[source.kind];
    if (!policy.enabled) return;
    const entries = this.store.entries(chat, source.kind);
    return await this.matchEntries(source, entries, policy);
  }
  async matchEntries(
    source: MediaSource,
    entries: MediaEntry[],
    policy: MediaPolicy,
  ): Promise<MediaMatch | undefined> {
    if (!policy.enabled) return;
    const make = (entry: MediaEntry): MediaMatch => ({
      model: "local-media",
      entry_id: entry.id,
      type: entry.type,
      kind: source.kind,
      value: entry.value,
      action: policy.action,
      reason: `媒体黑名单：${entry.type} #${entry.id}${
        entry.note ? "（" + entry.note + "）" : ""
      }`,
    });
    const exact = entries.find((e) =>
      e.type === "unique" &&
      source.aliases.some((id) => e.value === id || e.aliases.includes(id))
    ) ?? entries.find((e) =>
      e.type === "set" && e.value === source.set?.toLowerCase()
    );
    if (exact) return make(exact);
    const hashes = entries.filter((e) =>
      e.type === "pdq" && e.version === MEDIA_VERSION && e.quality !== null &&
      e.quality >= policy.quality
    );
    if (!hashes.length) return;
    const computed = await this.hash(source);
    if (computed.quality < policy.quality) return;
    let closest: { entry: MediaEntry; distance: number } | undefined;
    for (const entry of hashes) {
      const distance = hamming(computed.hash, entry.value);
      if (
        distance <= policy.distance && (!closest || distance < closest.distance)
      ) closest = { entry, distance };
    }
    if (closest) {
      return {
        ...make(closest.entry),
        distance: closest.distance,
        quality: computed.quality,
        entry_quality: closest.entry.quality!,
      };
    }
  }
}
