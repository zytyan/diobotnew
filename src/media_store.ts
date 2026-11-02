import type { DatabaseSync } from "node:sqlite";

export type MediaKind = "image" | "sticker";
export type MediaMode = "off" | "observe" | "delete" | "mute" | "ban";
export interface MediaPolicy {
  enabled: boolean;
  action: Exclude<MediaMode, "off">;
  distance: number;
  quality: number;
}
export type MediaPolicies = Record<MediaKind, MediaPolicy>;
export interface MediaEntry {
  id: number;
  chat_id: number;
  kind: MediaKind;
  type: "unique" | "set" | "pdq";
  value: string;
  aliases: string[];
  quality: number | null;
  note: string;
  actor: number;
  created: number;
  version: string;
}
export const MEDIA_VERSION = "pdq-rgb-white-v1";
export function validateMediaPolicies(value: unknown): MediaPolicies {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["image", "sticker"].includes(key))
  ) {
    throw new Error("媒体策略格式无效");
  }
  const result = {} as MediaPolicies;
  for (const kind of ["image", "sticker"] as const) {
    const p = (value as MediaPolicies)[kind];
    if (
      !p || typeof p !== "object" || Array.isArray(p) ||
      Object.keys(p).some((key) =>
        !["enabled", "action", "distance", "quality"].includes(key)
      ) ||
      typeof p.enabled !== "boolean" ||
      !["observe", "delete", "mute", "ban"].includes(p.action) ||
      !Number.isInteger(p.distance) || p.distance < 0 || p.distance > 256 ||
      !Number.isInteger(p.quality) || p.quality < 0 || p.quality > 100
    ) {
      throw new Error("媒体策略无效：距离须为0至256，Quality须为0至100的整数");
    }
    result[kind] = {
      enabled: p.enabled,
      action: p.action,
      distance: p.distance,
      quality: p.quality,
    };
  }
  return result;
}
export function defaultMediaPolicies(): MediaPolicies {
  const policy = () => ({
    enabled: false,
    action: "delete" as const,
    distance: 31,
    quality: 50,
  });
  return { image: policy(), sticker: policy() };
}
export interface MediaEntryInput {
  kind: MediaKind;
  type: MediaEntry["type"];
  value: string;
  aliases?: string[];
  quality?: number;
  note?: string;
}
export function validateMediaEntry(value: unknown): MediaEntryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("黑名单参数无效");
  }
  const input = value as MediaEntryInput;
  const { kind, type } = input;
  const entryValue = input.value;
  if (
    !["image", "sticker"].includes(kind) ||
    !["unique", "set", "pdq"].includes(type) ||
    typeof entryValue !== "string" || !entryValue || entryValue.length > 256 ||
    /[\s\0]/.test(entryValue) ||
    typeof (input.note ?? "") !== "string" ||
    (input.note?.length ?? 0) > 200 ||
    (type === "set" &&
      (kind !== "sticker" || !/^[A-Za-z0-9_]{1,64}$/.test(entryValue))) ||
    (type === "pdq" &&
      (!/^[a-fA-F0-9]{64}$/.test(entryValue) ||
        !Number.isInteger(input.quality) ||
        input.quality! < 0 || input.quality! > 100)) ||
    (input.aliases !== undefined &&
      (!Array.isArray(input.aliases) || input.aliases.length > 20 ||
        input.aliases.some((a) =>
          typeof a !== "string" || !a || a.length > 256 || /[\s\0]/.test(a)
        )))
  ) {
    throw new Error(
      "黑名单参数无效；PDQ须为64位十六进制并提供0至100的Quality",
    );
  }
  return {
    kind,
    type,
    value: type === "pdq" || type === "set"
      ? entryValue.toLowerCase()
      : entryValue,
    aliases: input.aliases,
    quality: input.quality,
    note: input.note ?? "",
  };
}
export class MediaStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_policies(chat_id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_blacklist(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, aliases TEXT NOT NULL, quality INTEGER, note TEXT NOT NULL, actor INTEGER NOT NULL, created INTEGER NOT NULL, version TEXT NOT NULL, UNIQUE(chat_id,kind,type,value));
      CREATE INDEX IF NOT EXISTS media_blacklist_chat ON media_blacklist(chat_id,kind);
      CREATE TABLE IF NOT EXISTS media_hash_cache(unique_id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, quality INTEGER NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(unique_id,version));
      CREATE TABLE IF NOT EXISTS media_pending(id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, actor INTEGER NOT NULL, source TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }
  policies(chat: number): MediaPolicies {
    const row = this.db.prepare(
      "SELECT body FROM media_policies WHERE chat_id=?",
    ).get(chat);
    return row ? JSON.parse(String(row.body)) : defaultMediaPolicies();
  }
  savePolicies(chat: number, value: MediaPolicies) {
    this.db.prepare("INSERT OR REPLACE INTO media_policies VALUES(?,?)").run(
      chat,
      JSON.stringify(validateMediaPolicies(value)),
    );
  }
  entries(chat: number, kind?: MediaKind): MediaEntry[] {
    const rows = kind
      ? this.db.prepare(
        "SELECT * FROM media_blacklist WHERE chat_id=? AND kind=? ORDER BY id DESC",
      ).all(chat, kind)
      : this.db.prepare(
        "SELECT * FROM media_blacklist WHERE chat_id=? ORDER BY id DESC",
      ).all(chat);
    return rows.map((row) => ({
      ...row,
      aliases: JSON.parse(String(row.aliases)),
    })) as unknown as MediaEntry[];
  }
  add(
    chat: number,
    actor: number,
    input: {
      kind: MediaKind;
      type: MediaEntry["type"];
      value: string;
      aliases?: string[];
      quality?: number;
      note?: string;
    },
    revision: number,
  ) {
    const { kind, type } = input;
    let { value } = input;
    input = validateMediaEntry(input);
    value = input.value;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db.prepare("SELECT revision FROM group_settings WHERE chat_id=?")
          .get(chat)?.revision !== revision
      ) throw new Error("conflict");
      const entries = this.entries(chat, kind);
      const old = entries.find((e) =>
        e.type === type &&
        (e.value === value || (type === "unique" && e.aliases.some((id) =>
          [value, ...(input.aliases ?? [])].includes(id)
        )))
      );
      if (old) {
        this.db.exec("COMMIT");
        return { entry: old, duplicate: true, revision };
      }
      if (entries.length >= 1000) throw new Error("每类最多1000条黑名单");
      const inserted = this.db.prepare(
        "INSERT INTO media_blacklist(chat_id,kind,type,value,aliases,quality,note,actor,created,version) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        chat,
        kind,
        type,
        value,
        JSON.stringify(
          type === "unique"
            ? [...new Set([value, ...(input.aliases ?? [])])]
            : [],
        ),
        type === "pdq" ? input.quality! : null,
        input.note ?? "",
        actor,
        Date.now(),
        MEDIA_VERSION,
      );
      this.db.prepare(
        "UPDATE group_settings SET revision=revision+1 WHERE chat_id=?",
      ).run(chat);
      this.db.exec("COMMIT");
      return {
        entry: this.entries(chat, kind).find((e) =>
          e.id === Number(inserted.lastInsertRowid)
        )!,
        duplicate: false,
        revision: revision + 1,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  remove(chat: number, id: number, revision: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db.prepare("SELECT revision FROM group_settings WHERE chat_id=?")
          .get(chat)?.revision !== revision
      ) throw new Error("conflict");
      const changed =
        this.db.prepare("DELETE FROM media_blacklist WHERE chat_id=? AND id=?")
          .run(chat, id).changes > 0;
      if (changed) {
        this.db.prepare(
          "UPDATE group_settings SET revision=revision+1 WHERE chat_id=?",
        ).run(chat);
      }
      this.db.exec("COMMIT");
      return revision + Number(changed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  cached(unique: string): { hash: string; quality: number } | undefined {
    const row = this.db.prepare(
      "SELECT hash,quality FROM media_hash_cache WHERE unique_id=? AND version=?",
    ).get(unique, MEDIA_VERSION);
    return row as { hash: string; quality: number } | undefined;
  }
  cache(unique: string, result: { hash: string; quality: number }) {
    this.db.prepare("INSERT OR REPLACE INTO media_hash_cache VALUES(?,?,?,?,?)")
      .run(unique, MEDIA_VERSION, result.hash, result.quality, Date.now());
    this.db.exec(
      "DELETE FROM media_hash_cache WHERE rowid IN (SELECT rowid FROM media_hash_cache ORDER BY seen DESC LIMIT -1 OFFSET 10000)",
    );
  }
}
