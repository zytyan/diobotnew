import type { RegexRule } from "./rules.ts";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import type { AvatarImage } from "./profiles.ts";

export interface Join {
  id: string;
  chat_id: number;
  user_id: number;
  kind: "request" | "direct";
  state: "pending" | "verified" | "failed" | "rejected" | "done" | "superseded";
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
      CREATE TABLE IF NOT EXISTS group_settings (
        chat_id INTEGER PRIMARY KEY, verification INTEGER NOT NULL,
        moderation TEXT NOT NULL, welcome INTEGER NOT NULL, kicked INTEGER NOT NULL,
        leave_notice INTEGER NOT NULL, tree INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invitations (
        chat_id INTEGER NOT NULL, invitee_id INTEGER NOT NULL,
        inviter_id INTEGER NOT NULL, name TEXT NOT NULL, joined_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(chat_id, invitee_id)
      );
      CREATE INDEX IF NOT EXISTS invitations_parent ON invitations(chat_id, inviter_id, active);
      CREATE TABLE IF NOT EXISTS tree_actions (
        id TEXT PRIMARY KEY, event_key TEXT UNIQUE NOT NULL, chat_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL, root_id INTEGER NOT NULL, expires INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'offered'
      );
      CREATE TABLE IF NOT EXISTS tree_targets (
        action_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(action_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS raw_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, version_hash TEXT NOT NULL, seen_at INTEGER NOT NULL, message_json TEXT NOT NULL, update_json TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, action TEXT NOT NULL DEFAULT 'received', bytes INTEGER NOT NULL, UNIQUE(chat_id,message_id,version_hash));
      CREATE INDEX IF NOT EXISTS raw_messages_time ON raw_messages(seen_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS raw_messages_chat ON raw_messages(chat_id,message_id,id DESC);
      CREATE TABLE IF NOT EXISTS snapshot_reviews(review_id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_rules(chat_id INTEGER PRIMARY KEY, rules TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_events(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, seen_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS group_events_time ON group_events(chat_id,seen_at DESC);
      CREATE TABLE IF NOT EXISTS client_timings(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, session_id TEXT NOT NULL, seen_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS client_timings_time ON client_timings(seen_at);
      CREATE INDEX IF NOT EXISTS client_timings_user ON client_timings(user_id,seen_at);
      CREATE TABLE IF NOT EXISTS group_avatar_settings(chat_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_ai_settings(chat_id INTEGER PRIMARY KEY, threshold REAL NOT NULL CHECK(threshold>=0.5 AND threshold<=1));
      CREATE TABLE IF NOT EXISTS review_settings(chat_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_avatars(hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, last_used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        profile_json TEXT NOT NULL, avatar_hash TEXT, fingerprint TEXT NOT NULL,
        message_date INTEGER NOT NULL, seen_at INTEGER NOT NULL, mode TEXT NOT NULL,
        result_json TEXT, action TEXT NOT NULL DEFAULT 'recorded', human_label TEXT,
        reviewed_by INTEGER, reviewed_at INTEGER,
        UNIQUE(chat_id,message_id,fingerprint)
      );
      CREATE INDEX IF NOT EXISTS review_chat_time ON review_messages(chat_id,seen_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS review_global_time ON review_messages(seen_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS review_sender ON review_messages(chat_id,sender_id);
      UPDATE joins SET state='done' WHERE state='speech' OR kind='speech';
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
    const state = "pending";
    this.db.prepare(
      "INSERT INTO joins(id,chat_id,user_id,kind,state,expires,permissions) VALUES(?,?,?,?,?,?,?)",
    )
      .run(
        id,
        chat,
        user,
        kind,
        state,
        now + 360_000,
        JSON.stringify(permissions),
      );
    return this.get(id)!;
  }
  get(id: string): Join | undefined {
    return this.db.prepare("SELECT * FROM joins WHERE id=?").get(
      id,
    ) as unknown as Join | undefined;
  }
  joinMessage(id: string, message: number | null) {
    this.db.prepare("UPDATE joins SET message_id=? WHERE id=?").run(
      message,
      id,
    );
  }
  active() {
    return this.db.prepare(
      "SELECT * FROM joins WHERE state IN ('pending','verified','failed','speech') OR (state='done' AND kind='direct' AND message_id IS NOT NULL)",
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
  cancel(chat: number, user?: number) {
    const sql =
      "UPDATE joins SET state='superseded' WHERE state IN ('pending','verified','failed','speech') AND chat_id=?";
    if (user === undefined) {
      this.db.prepare(sql).run(chat);
      this.db.prepare(
        "UPDATE tree_actions SET state='cancelled' WHERE chat_id=? AND state IN ('offered','confirm','running')",
      ).run(chat);
    } else this.db.prepare(sql + " AND user_id=?").run(chat, user);
  }
  settings(chat: number, defaults: GroupSettings): GroupSettings {
    this.db.prepare(
      "INSERT OR IGNORE INTO group_settings VALUES(?,?,?,?,?,?,?,0)",
    ).run(
      chat,
      Number(defaults.verification),
      defaults.moderation,
      Number(defaults.welcome),
      Number(defaults.kicked),
      Number(defaults.leave),
      Number(defaults.tree),
    );
    const row = this.db.prepare("SELECT * FROM group_settings WHERE chat_id=?")
      .get(chat)!;
    return {
      verification: !!row.verification,
      moderation: row.moderation as GroupSettings["moderation"],
      welcome: !!row.welcome,
      kicked: !!row.kicked,
      leave: !!row.leave_notice,
      tree: !!row.tree,
      revision: Number(row.revision),
      aiThreshold: this.groupThreshold(chat),
      uploadAvatar: this.avatarEnabled(chat),
      rules: this.rules(chat),
      review:
        this.db.prepare("SELECT enabled FROM review_settings WHERE chat_id=?")
          .get(chat)?.enabled !== 0,
    };
  }
  captureMessage(
    chat: number,
    message: number,
    version: string,
    rawMessage: string,
    rawUpdate: string,
    now = Date.now(),
  ): number {
    const bytes = new TextEncoder().encode(rawMessage).length +
      new TextEncoder().encode(rawUpdate).length + 2;
    this.db.prepare(
      "INSERT OR IGNORE INTO raw_messages(chat_id,message_id,version_hash,seen_at,message_json,update_json,bytes) VALUES(?,?,?,?,?,?,?)",
    ).run(chat, message, version, now, rawMessage, rawUpdate, bytes);
    return Number(
      this.db.prepare(
        "SELECT id FROM raw_messages WHERE chat_id=? AND message_id=? AND version_hash=?",
      ).get(chat, message, version)!.id,
    );
  }
  snapshotContext(id: number, context: string, review?: number) {
    this.db.prepare(
      "UPDATE raw_messages SET bytes=bytes-length(CAST(context_json AS BLOB))+?,context_json=? WHERE id=?",
    ).run(new TextEncoder().encode(context).length, context, id);
    if (review !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO snapshot_reviews VALUES(?,?)")
        .run(review, id);
    }
  }
  snapshotResult(id: number, action: string, result?: unknown) {
    this.db.prepare(
      "UPDATE raw_messages SET action=?,result_json=COALESCE(?,result_json) WHERE id=?",
    ).run(action, result === undefined ? null : JSON.stringify(result), id);
  }
  rawMessage(chat: number, id: number): RawMessage | undefined {
    return this.db.prepare(
      "SELECT * FROM raw_messages WHERE chat_id=? AND id=?",
    ).get(chat, id) as unknown as RawMessage | undefined;
  }
  latestRawMessage(chat: number, message: number): RawMessage | undefined {
    return this.db.prepare(
      "SELECT * FROM raw_messages WHERE chat_id=? AND message_id=? ORDER BY id DESC LIMIT 1",
    ).get(chat, message) as unknown as RawMessage | undefined;
  }
  pruneRawMessages(now = Date.now()) {
    this.db.prepare("DELETE FROM raw_messages WHERE seen_at<?").run(
      now - 7 * 86400_000,
    );
    this.db.exec(
      `DELETE FROM raw_messages WHERE id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER (ORDER BY id DESC) AS n,SUM(bytes) OVER (ORDER BY id DESC) AS total FROM raw_messages) WHERE n>10000 OR total>268435456);
      DELETE FROM snapshot_reviews WHERE snapshot_id NOT IN (SELECT id FROM raw_messages) OR review_id NOT IN (SELECT id FROM review_messages);`,
    );
  }
  rules(chat: number): RegexRule[] {
    return JSON.parse(
      String(
        this.db.prepare("SELECT rules FROM group_rules WHERE chat_id=?").get(
          chat,
        )?.rules ?? "[]",
      ),
    );
  }
  groupEvent(chat: number, event: unknown) {
    this.db.prepare(
      "INSERT INTO group_events(chat_id,seen_at,body) VALUES(?,?,?)",
    ).run(chat, Date.now(), JSON.stringify(event));
    this.db.prepare("DELETE FROM group_events WHERE seen_at<?").run(
      Date.now() - 7 * 86400_000,
    );
    this.db.exec(
      "DELETE FROM group_events WHERE id NOT IN (SELECT id FROM group_events ORDER BY id DESC LIMIT 10000)",
    );
  }
  groupLogs(chat: number) {
    this.db.prepare("DELETE FROM client_timings WHERE seen_at<?").run(
      Date.now() - 3 * 86400_000,
    );
    this.db.prepare("DELETE FROM group_events WHERE seen_at<?").run(
      Date.now() - 7 * 86400_000,
    );
    const events = this.db.prepare(
      "SELECT id,seen_at,body FROM group_events WHERE chat_id=? ORDER BY seen_at DESC,id DESC LIMIT 100",
    ).all(chat)
      .map((row) => ({
        id: `action-${row.id}`,
        time: Number(row.seen_at),
        kind: "action",
        data: JSON.parse(String(row.body)),
      }));
    const timings = this.db.prepare(
      "SELECT id,seen_at,body,user_id FROM client_timings WHERE chat_id=? ORDER BY seen_at DESC LIMIT 100",
    ).all(chat)
      .map((row) => ({
        id: `client-${row.id}`,
        time: Number(row.seen_at),
        kind: "client",
        data: { user_id: Number(row.user_id), ...JSON.parse(String(row.body)) },
      }));
    const reviews = this.db.prepare(
      "SELECT id,seen_at,message_id,sender_id,text,action,result_json FROM review_messages WHERE chat_id=? ORDER BY seen_at DESC,id DESC LIMIT 100",
    ).all(chat)
      .map((row) => ({
        id: `review-${row.id}`,
        time: Number(row.seen_at),
        kind: "review",
        data: {
          message_id: row.message_id,
          sender_id: row.sender_id,
          text: String(row.text).slice(0, 500),
          action: row.action,
          result: row.result_json ? JSON.parse(String(row.result_json)) : null,
        },
      }));
    const originals = this.db.prepare(
      "SELECT id,seen_at,message_id,message_json,action FROM raw_messages WHERE chat_id=? ORDER BY id DESC LIMIT 100",
    ).all(chat).map((row) => {
      const message = JSON.parse(String(row.message_json));
      return {
        id: `raw-${row.id}`,
        time: Number(row.seen_at),
        kind: "message",
        data: {
          snapshot_id: Number(row.id),
          message_id: row.message_id,
          sender_id: message.from?.id,
          action: row.action,
          text: String(message.text ?? message.caption ?? "[非文字消息]").slice(
            0,
            500,
          ),
          edited: !!message.edit_date,
        },
      };
    });
    return [...events, ...timings, ...reviews, ...originals].sort((a, b) =>
      b.time - a.time
    )
      .slice(0, 100);
  }
  clientTimings(
    user: number,
    chat: number,
    session: string,
    events: { id: string }[],
    now = Date.now(),
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM client_timings WHERE seen_at<?").run(
        now - 3 * 86400_000,
      );
      const count = Number(
        this.db.prepare(
          "SELECT COUNT(*) AS total FROM client_timings WHERE user_id=? AND seen_at>?",
        ).get(user, now - 60_000)!.total,
      );
      const fresh = events.filter((event) =>
        !this.db.prepare("SELECT 1 FROM client_timings WHERE id=?").get(
          event.id,
        )
      );
      if (count + fresh.length > 120) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO client_timings VALUES(?,?,?,?,?,?)",
      );
      for (const event of fresh) {
        insert.run(event.id, user, chat, session, now, JSON.stringify(event));
      }
      this.db.exec(
        "DELETE FROM client_timings WHERE id IN (SELECT id FROM client_timings ORDER BY seen_at DESC,id DESC LIMIT -1 OFFSET 10000)",
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  avatarEnabled(chat: number): boolean {
    return this.db.prepare(
      "SELECT enabled FROM group_avatar_settings WHERE chat_id=?",
    ).get(chat)?.enabled !== 0;
  }
  groupThreshold(chat: number): number | undefined {
    const row = this.db.prepare(
      "SELECT threshold FROM group_ai_settings WHERE chat_id=?",
    ).get(chat);
    return row ? Number(row.threshold) : undefined;
  }
  saveSettings(chat: number, value: GroupSettings, revision: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(
        `UPDATE group_settings SET verification=?,moderation=?,welcome=?,kicked=?,leave_notice=?,tree=?,revision=revision+1 WHERE chat_id=? AND revision=?`,
      )
        .run(
          Number(value.verification),
          value.moderation,
          Number(value.welcome),
          Number(value.kicked),
          Number(value.leave),
          Number(value.tree),
          chat,
          revision,
        ).changes > 0;
      if (changed) {
        if (value.rules !== undefined) {
          this.db.prepare("INSERT OR REPLACE INTO group_rules VALUES(?,?)").run(
            chat,
            JSON.stringify(value.rules),
          );
        }
        this.db.prepare(
          "INSERT OR REPLACE INTO group_avatar_settings VALUES(?,?)",
        ).run(chat, Number(value.uploadAvatar ?? this.avatarEnabled(chat)));
        this.db.prepare("INSERT OR REPLACE INTO review_settings VALUES(?,?)")
          .run(chat, Number(value.review));
        this.db.prepare("INSERT OR REPLACE INTO group_ai_settings VALUES(?,?)")
          .run(chat, value.aiThreshold!);
        if (!value.verification) {
          this.db.prepare(
            "UPDATE joins SET state='verified' WHERE chat_id=? AND state IN ('pending','failed')",
          ).run(chat);
        }
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  updateSetting(
    chat: number,
    key: SettingKey,
    value: boolean | string,
    revision: number,
  ): boolean {
    if (key === "review") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const changed = this.db.prepare(
          "UPDATE group_settings SET revision=revision+1 WHERE chat_id=? AND revision=?",
        ).run(chat, revision).changes > 0;
        if (changed) {
          this.db.prepare("INSERT OR REPLACE INTO review_settings VALUES(?,?)")
            .run(chat, Number(!!value));
        }
        this.db.exec("COMMIT");
        return changed;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const columns = {
      verification: "verification",
      moderation: "moderation",
      welcome: "welcome",
      kicked: "kicked",
      leave: "leave_notice",
      tree: "tree",
    };
    const column = columns[key];
    if (!column) throw new Error("Unknown setting");
    const changed = this.db.prepare(
      `UPDATE group_settings SET ${column}=?, revision=revision+1 WHERE chat_id=? AND revision=?`,
    )
      .run(typeof value === "boolean" ? Number(value) : value, chat, revision)
      .changes > 0;
    if (changed && key === "verification" && !value) {
      // Let the durable worker approve pending requests / restore restricted users.
      this.db.prepare(
        "UPDATE joins SET state='verified' WHERE chat_id=? AND state IN ('pending','failed')",
      ).run(chat);
    }
    return changed;
  }
  memberLeft(chat: number, user: number) {
    this.db.prepare(
      "UPDATE invitations SET active=0 WHERE chat_id=? AND invitee_id=?",
    ).run(chat, user);
  }
  invited(
    chat: number,
    inviter: number,
    invitee: number,
    name: string,
    date: number,
  ) {
    if (inviter === invitee) return;
    this.db.prepare(
      `INSERT INTO invitations VALUES(?,?,?,?,?,1) ON CONFLICT(chat_id,invitee_id)
      DO UPDATE SET inviter_id=excluded.inviter_id,name=excluded.name,joined_at=excluded.joined_at,active=1`,
    )
      .run(chat, invitee, inviter, name, date);
  }
  invitees(chat: number, inviter: number): { user_id: number; name: string }[] {
    return this.db.prepare(
      "SELECT invitee_id AS user_id,name FROM invitations WHERE chat_id=? AND inviter_id=? AND active=1 ORDER BY joined_at,invitee_id",
    )
      .all(chat, inviter) as unknown as { user_id: number; name: string }[];
  }
  offerTree(
    chat: number,
    actor: number,
    root: number,
    event: string,
  ): TreeAction | undefined {
    const id = crypto.randomUUID().replaceAll("-", "");
    if (
      !this.db.prepare(
        "INSERT OR IGNORE INTO tree_actions(id,event_key,chat_id,actor_id,root_id,expires) VALUES(?,?,?,?,?,?)",
      )
        .run(id, event, chat, actor, root, Date.now() + 600_000).changes
    ) return;
    return this.treeAction(id);
  }
  treeAction(id: string): TreeAction | undefined {
    return this.db.prepare("SELECT * FROM tree_actions WHERE id=?").get(
      id,
    ) as unknown as TreeAction | undefined;
  }
  treeState(id: string, from: string, to: string): boolean {
    return this.db.prepare(
      "UPDATE tree_actions SET state=? WHERE id=? AND state=? AND expires>?",
    ).run(to, id, from, Date.now()).changes > 0;
  }
  previewTree(id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.treeState(id, "offered", "confirm")) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const action = this.treeAction(id)!;
      for (const child of this.invitees(action.chat_id, action.root_id)) {
        this.db.prepare(
          "INSERT OR IGNORE INTO tree_targets(action_id,user_id) VALUES(?,?)",
        ).run(id, child.user_id);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  startTree(id: string): boolean {
    return this.treeState(id, "confirm", "running");
  }
  treeJobs(): TreeAction[] {
    return this.db.prepare("SELECT * FROM tree_actions WHERE state='running'")
      .all() as unknown as TreeAction[];
  }
  treePending(id: string): number[] {
    return this.db.prepare(
      "SELECT user_id FROM tree_targets WHERE action_id=? AND state='pending' LIMIT 10",
    ).all(id).map((r) => Number(r.user_id));
  }
  treeResult(id: string, user: number, state: string) {
    this.db.prepare(
      "UPDATE tree_targets SET state=? WHERE action_id=? AND user_id=?",
    ).run(state, id, user);
  }
  treeCounts(id: string): Record<string, number> {
    return Object.fromEntries(
      this.db.prepare(
        "SELECT state, COUNT(*) AS n FROM tree_targets WHERE action_id=? GROUP BY state",
      ).all(id).map((r) => [String(r.state), Number(r.n)]),
    );
  }
  finishTree(id: string, state = "done") {
    this.db.prepare(
      "UPDATE tree_actions SET state=? WHERE id=? AND state='running'",
    ).run(state, id);
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
  recordReview(
    input: ReviewInput,
    limits: Pick<Config, "reviewDays" | "reviewPerChat" | "reviewMax">,
    now = Date.now(),
  ): number | undefined {
    if (limits.reviewDays === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.avatar) {
        this.db.prepare(
          `INSERT INTO review_avatars VALUES(?,?,?,?) ON CONFLICT(hash) DO UPDATE SET last_used=excluded.last_used`,
        )
          .run(input.avatar.hash, input.avatar.mime, input.avatar.bytes, now);
      }
      this.db.prepare(
        `INSERT INTO review_messages(chat_id,message_id,sender_id,kind,text,profile_json,avatar_hash,fingerprint,message_date,seen_at,mode)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,message_id,fingerprint) DO UPDATE SET seen_at=excluded.seen_at,mode=excluded.mode`,
      )
        .run(
          input.chat,
          input.message,
          input.sender,
          input.kind,
          input.text.slice(0, 8000),
          input.profile,
          input.avatar?.hash ?? null,
          input.fingerprint,
          input.date,
          now,
          input.mode,
        );
      const row = this.db.prepare(
        "SELECT id FROM review_messages WHERE chat_id=? AND message_id=? AND fingerprint=?",
      ).get(input.chat, input.message, input.fingerprint)!;
      this.pruneReview(limits, now);
      this.db.prepare(
        "DELETE FROM review_messages WHERE id IN (SELECT id FROM review_messages WHERE chat_id=? ORDER BY seen_at DESC,id DESC LIMIT -1 OFFSET ?)",
      ).run(input.chat, limits.reviewPerChat);
      this.db.prepare(
        "DELETE FROM review_messages WHERE id IN (SELECT id FROM review_messages ORDER BY seen_at DESC,id DESC LIMIT -1 OFFSET ?)",
      ).run(limits.reviewMax);
      this.pruneAvatars();
      this.db.exec("COMMIT");
      return Number(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private lastReviewPrune = 0;
  pruneReview(limits: Pick<Config, "reviewDays">, now = Date.now()) {
    if (this.lastReviewPrune && now - this.lastReviewPrune < 60_000) return;
    this.db.prepare("DELETE FROM review_messages WHERE seen_at<?").run(
      now - limits.reviewDays * 86_400_000,
    );
    this.db.prepare("DELETE FROM moderation WHERE created<?").run(
      now - 86_400_000,
    );
    this.pruneAvatars();
    this.lastReviewPrune = now;
  }
  private pruneAvatars() {
    this.db.exec(
      `DELETE FROM review_avatars WHERE hash NOT IN (SELECT avatar_hash FROM review_messages WHERE avatar_hash IS NOT NULL);
      DELETE FROM review_avatars WHERE hash IN (
        SELECT hash FROM (SELECT hash,SUM(length(bytes)) OVER (ORDER BY last_used DESC,hash) AS total FROM review_avatars) WHERE total>33554432
      );
      UPDATE review_messages SET avatar_hash=NULL WHERE avatar_hash IS NOT NULL AND avatar_hash NOT IN (SELECT hash FROM review_avatars);`,
    );
  }
  reviewResult(id: number | undefined, action: string, result?: unknown) {
    if (id === undefined) return;
    this.db.prepare(
      "UPDATE review_messages SET action=?,result_json=COALESCE(?,result_json) WHERE id=?",
    ).run(action, result === undefined ? null : JSON.stringify(result), id);
  }
  recentReviews(chat: number, limit = 5): ReviewRow[] {
    return this.db.prepare(
      "SELECT * FROM review_messages WHERE chat_id=? ORDER BY seen_at DESC,id DESC LIMIT ?",
    ).all(chat, limit) as unknown as ReviewRow[];
  }
  labelReview(
    id: number,
    chat: number,
    label: string,
    reviewer: number,
  ): boolean {
    if (!["normal", "advertisement", "scam", "uncertain"].includes(label)) {
      return false;
    }
    return this.db.prepare(
      "UPDATE review_messages SET human_label=?,reviewed_by=?,reviewed_at=? WHERE id=? AND chat_id=?",
    ).run(
      label === "scam" ? "advertisement" : label,
      reviewer,
      Date.now(),
      id,
      chat,
    ).changes > 0;
  }
  forgetReviewSender(chat: number, user: number) {
    this.db.prepare(
      "DELETE FROM raw_messages WHERE chat_id=? AND json_extract(message_json,'$.from.id')=?",
    ).run(chat, user);
    this.db.prepare(
      "DELETE FROM moderation WHERE chat_id=? AND message_id IN (SELECT message_id FROM review_messages WHERE chat_id=? AND sender_id=?)",
    ).run(chat, chat, user);
    this.db.prepare(
      "DELETE FROM review_messages WHERE chat_id=? AND sender_id=?",
    ).run(chat, user);
    this.pruneAvatars();
  }
  reviewAvatar(hash: string): { mime: string; bytes: Uint8Array } | undefined {
    return this.db.prepare("SELECT mime,bytes FROM review_avatars WHERE hash=?")
      .get(hash) as unknown as { mime: string; bytes: Uint8Array } | undefined;
  }
  close() {
    this.db.close();
  }
}

export interface GroupSettings {
  rules?: RegexRule[];
  uploadAvatar?: boolean;
  aiThreshold?: number;
  verification: boolean;
  moderation: "off" | "observe" | "delete" | "mute" | "ban";
  welcome: boolean;
  kicked: boolean;
  leave: boolean;
  tree: boolean;
  revision?: number;
  review?: boolean;
}
export type SettingKey =
  | "verification"
  | "moderation"
  | "welcome"
  | "kicked"
  | "leave"
  | "tree"
  | "review";
export interface TreeAction {
  id: string;
  chat_id: number;
  actor_id: number;
  root_id: number;
  expires: number;
  state: string;
}

export interface ReviewInput {
  chat: number;
  message: number;
  sender: number;
  kind: string;
  text: string;
  profile: string;
  avatar?: AvatarImage;
  fingerprint: string;
  date: number;
  mode: string;
}
export interface ReviewRow {
  id: number;
  chat_id: number;
  message_id: number;
  sender_id: number;
  kind: string;
  text: string;
  profile_json: string;
  avatar_hash: string | null;
  seen_at: number;
  message_date: number;
  mode: string;
  result_json: string | null;
  action: string;
  human_label: string | null;
  reviewed_by: number | null;
  reviewed_at: number | null;
}

export interface RawMessage {
  id: number;
  chat_id: number;
  message_id: number;
  version_hash: string;
  seen_at: number;
  message_json: string;
  update_json: string;
  context_json: string;
  result_json: string | null;
  action: string;
  bytes: number;
}
