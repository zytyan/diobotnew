import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

export interface Join {
  id: string;
  chat_id: number;
  user_id: number;
  kind: "request" | "direct" | "speech";
  state: "pending" | "verified" | "failed" | "speech" | "done" | "superseded";
  expires: number;
  attempts: number;
  permissions: string;
  message_id: number | null;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") {
      Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
        bot_status TEXT, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS joins (
        id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        kind TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, permissions TEXT NOT NULL DEFAULT '{}',
        message_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS joins_active ON joins(state, expires);
      CREATE TABLE IF NOT EXISTS moderation (
        chat_id INTEGER, message_id INTEGER, text TEXT NOT NULL, result TEXT NOT NULL,
        created INTEGER NOT NULL, PRIMARY KEY(chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
    `);
  }
  recordChat(id: number, title: string, type: string, status?: string) {
    this.db.prepare(`INSERT INTO chats VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type,
      bot_status=COALESCE(excluded.bot_status, chats.bot_status), last_seen=excluded.last_seen`)
      .run(id, title, type, status ?? null, Date.now());
  }
  chats() {
    return this.db.prepare("SELECT * FROM chats ORDER BY last_seen DESC").all();
  }
  create(
    chat: number,
    user: number,
    kind: Join["kind"],
    permissions = {},
    now = Date.now(),
  ): Join {
    this.db.prepare(
      "UPDATE joins SET state='superseded' WHERE chat_id=? AND user_id=? AND state IN ('pending','verified','failed','speech')",
    ).run(chat, user);
    const id = crypto.randomUUID().replaceAll("-", "");
    const state = kind === "speech" ? "speech" : "pending";
    this.db.prepare(
      "INSERT INTO joins(id,chat_id,user_id,kind,state,expires,permissions) VALUES(?,?,?,?,?,?,?)",
    )
      .run(
        id,
        chat,
        user,
        kind,
        state,
        now + (kind === "speech" ? 600_000 : 360_000),
        JSON.stringify(permissions),
      );
    return this.get(id)!;
  }
  get(id: string): Join | undefined {
    return this.db.prepare("SELECT * FROM joins WHERE id=?").get(
      id,
    ) as unknown as Join | undefined;
  }
  active() {
    return this.db.prepare(
      "SELECT * FROM joins WHERE state IN ('pending','verified','failed','speech')",
    ).all() as unknown as Join[];
  }
  resolve(
    id: string,
    user: number,
    success: boolean,
    now = Date.now(),
  ): boolean {
    if (success) {
      return this.db.prepare(
        "UPDATE joins SET state='verified' WHERE id=? AND user_id=? AND state='pending' AND expires>?",
      ).run(id, user, now).changes > 0;
    }
    return this.db.prepare(
      "UPDATE joins SET attempts=attempts+1, state=CASE WHEN attempts>=2 THEN 'failed' ELSE 'pending' END WHERE id=? AND user_id=? AND state='pending' AND expires>?",
    ).run(id, user, now).changes > 0;
  }
  state(id: string, state: Join["state"], expires?: number) {
    this.db.prepare(
      "UPDATE joins SET state=?, expires=COALESCE(?,expires) WHERE id=?",
    ).run(state, expires ?? null, id);
  }
  message(id: string, message: number) {
    this.db.prepare("UPDATE joins SET message_id=? WHERE id=?").run(
      message,
      id,
    );
  }
  spoke(chat: number, user: number): Join | undefined {
    const row = this.db.prepare(
      "SELECT * FROM joins WHERE chat_id=? AND user_id=? AND state='speech'",
    ).get(chat, user) as unknown as Join | undefined;
    if (row) this.state(row.id, "done");
    return row;
  }
  cancel(chat: number, user?: number) {
    const sql =
      "UPDATE joins SET state='superseded' WHERE state IN ('pending','verified','failed','speech') AND chat_id=?";
    if (user === undefined) this.db.prepare(sql).run(chat);
    else this.db.prepare(sql + " AND user_id=?").run(chat, user);
  }
  spend(limit: number): boolean {
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare("INSERT OR IGNORE INTO usage VALUES (?,0)").run(day);
    return this.db.prepare(
      "UPDATE usage SET requests=requests+1 WHERE day=? AND requests<?",
    ).run(day, limit).changes > 0;
  }
  cached(chat: number, message: number, text: string): string | undefined {
    const row = this.db.prepare(
      "SELECT result FROM moderation WHERE chat_id=? AND message_id=? AND text=?",
    ).get(chat, message, text);
    return row?.result as string | undefined;
  }
  audit(chat: number, message: number, text: string, result: string) {
    this.db.prepare("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(
      chat,
      message,
      text,
      result,
      Date.now(),
    );
  }
  close() {
    this.db.close();
  }
}
