import type { MessageEvidence } from "./message_evidence.ts";
import type { Api } from "grammy";
import type { PhotoSize, User } from "grammy/types";
import { Buffer } from "node:buffer";
import type { Config } from "./config.ts";

export interface SenderProfile {
  is_bot?: boolean;
  display_name: string;
  username: string | null;
  bio: string | null;
  bio_status: "available" | "empty" | "unavailable";
  avatar_status: "available" | "none_or_private" | "unavailable" | "disabled";
}
export interface AvatarImage {
  hash: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
  base64: string;
}
export interface ModerationContext {
  evidence?: MessageEvidence;
  profile?: SenderProfile;
  avatar?: AvatarImage;
  messageKind?: string;
  links?: string[];
}
export function profileState(context?: ModerationContext) {
  if (!context) return null;
  return {
    sender: context.profile ?? null,
    evidence: context.evidence ?? null,
    message_kind: context.messageKind ?? "text",
    links: context.links?.slice(0, 8).map((link) => link.slice(0, 512)) ?? [],
    avatar: context.avatar
      ? { status: "available", sha256: context.avatar.hash }
      : { status: context.profile?.avatar_status ?? "unavailable" },
  };
}
export async function fingerprint(value: unknown): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}
const maxAvatarBytes = 128 * 1024;
interface CachedProfile {
  until: number;
  bio: Pick<SenderProfile, "bio" | "bio_status">;
  avatar?: AvatarImage;
  avatar_status: SenderProfile["avatar_status"];
}
export class Profiles {
  private cache = new Map<string, CachedProfile>();
  private pending = new Map<string, Promise<CachedProfile>>();
  constructor(
    private api: Pick<Api, "getChat" | "getUserProfilePhotos" | "getFile">,
    private config: Pick<
      Config,
      "apiRoot" | "token" | "environment" | "localFileRoot"
    >,
    private request: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  async get(user: User, includeAvatar = true): Promise<ModerationContext> {
    const key = `${user.id}:${includeAvatar}`;
    let cached = this.cache.get(key);
    if (!cached || cached.until <= this.now()) {
      let loading = this.pending.get(key);
      if (!loading) {
        loading = this.load(user.id, includeAvatar);
        this.pending.set(key, loading);
      }
      try {
        cached = await loading;
      } finally {
        if (this.pending.get(key) === loading) this.pending.delete(key);
      }
      this.cache.delete(key);
      this.cache.set(key, cached);
      while (this.cache.size > 128) {
        this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return {
      profile: {
        is_bot: user.is_bot,
        display_name: [user.first_name, user.last_name].filter(Boolean).join(
          " ",
        ).slice(0, 256),
        username: user.username?.slice(0, 64) ?? null,
        ...cached.bio,
        avatar_status: cached.avatar_status,
      },
      ...(cached.avatar ? { avatar: cached.avatar } : {}),
    };
  }
  invalidate(user: number) {
    this.cache.delete(`${user}:true`);
    this.cache.delete(`${user}:false`);
  }
  private async load(
    user: number,
    includeAvatar: boolean,
  ): Promise<CachedProfile> {
    const other = this.cache.get(`${user}:${!includeAvatar}`);
    const [bio, photo] = await Promise.allSettled([
      other && other.until > this.now()
        ? Promise.resolve(other.bio)
        : this.bio(user),
      includeAvatar ? this.avatar(user) : Promise.resolve(undefined),
    ]);
    const avatar = photo.status === "fulfilled" ? photo.value : undefined;
    return {
      until: this.now() + 120_000,
      bio: bio.status === "fulfilled"
        ? bio.value
        : { bio: null, bio_status: "unavailable" },
      ...(avatar ? { avatar } : {}),
      avatar_status: !includeAvatar
        ? "disabled"
        : photo.status === "rejected"
        ? "unavailable"
        : avatar
        ? "available"
        : "none_or_private",
    };
  }
  private async bio(
    user: number,
  ): Promise<Pick<SenderProfile, "bio" | "bio_status">> {
    const chat = await this.api.getChat(user);
    if (!chat || typeof chat !== "object" || chat.type !== "private") {
      return { bio: null, bio_status: "unavailable" };
    }
    const bio = (chat.bio ?? "").slice(0, 1024);
    return { bio, bio_status: bio ? "available" : "empty" };
  }
  private async avatar(user: number): Promise<AvatarImage | undefined> {
    const photos = await this.api.getUserProfilePhotos(user, {
      offset: 0,
      limit: 1,
    });
    if (!photos || !Array.isArray(photos.photos)) {
      throw new Error("Profile photo unavailable");
    }
    const choices = photos.photos[0];
    if (!choices?.length) return;
    const sorted = [...choices].sort((a, b) =>
      Math.max(a.width, a.height) - Math.max(b.width, b.height)
    );
    const photo: PhotoSize =
      sorted.filter((p) => Math.max(p.width, p.height) <= 320).at(-1) ??
        sorted[0];
    if (photo.file_size && photo.file_size > maxAvatarBytes) {
      throw new Error("Profile photo too large");
    }
    const file = await this.api.getFile(photo.file_id);
    if (
      !file.file_path || (file.file_size && file.file_size > maxAvatarBytes)
    ) throw new Error("Profile photo unavailable");
    if (file.file_path.split("/").some((part) => part === "..")) {
      throw new Error("Unsupported profile file path");
    }
    let body: ReadableStream<Uint8Array> | null;
    if (file.file_path.startsWith("/")) {
      const host = new URL(this.config.apiRoot).hostname;
      if (
        !this.config.localFileRoot ||
        !["127.0.0.1", "localhost", "[::1]"].includes(host)
      ) {
        throw new Error("Local profile file access disabled");
      }
      const root = (await Deno.realPath(this.config.localFileRoot)).replace(
        /\/$/,
        "",
      );
      const path = await Deno.realPath(file.file_path);
      if (!path.startsWith(root + "/")) {
        throw new Error("Profile file outside configured directory");
      }
      const local = await Deno.open(path, { read: true });
      try {
        const info = await local.stat();
        if (!info.isFile || info.size > maxAvatarBytes) {
          throw new Error("Profile photo too large or invalid");
        }
        body = local.readable;
      } catch (error) {
        local.close();
        throw error;
      }
    } else {
      const url = `${
        this.config.apiRoot.replace(/\/$/, "")
      }/file/bot${this.config.token}/${
        this.config.environment === "test" ? "test/" : ""
      }${file.file_path}`;
      const response = await this.request(url, {
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Profile download unavailable");
      }
      body = response.body;
    }
    const reader = body?.getReader();
    if (!reader) throw new Error("Empty profile photo");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > maxAvatarBytes) {
          await reader.cancel();
          throw new Error("Profile photo too large");
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let mime: AvatarImage["mime"];
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      mime = "image/jpeg";
    } else if (
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) mime = "image/png";
    else if (
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
    ) mime = "image/webp";
    else throw new Error("Unsupported profile photo format");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return { hash, mime, bytes, base64: Buffer.from(bytes).toString("base64") };
  }
}
