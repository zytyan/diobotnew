import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

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
    };
  }
  updateSetting(
    chat: number,
    key: SettingKey,
    value: boolean | string,
    revision: number,
  ): boolean {
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
  close() {
    this.db.close();
  }
}

export interface GroupSettings {
  verification: boolean;
  moderation: "off" | "observe" | "delete";
  welcome: boolean;
  kicked: boolean;
  leave: boolean;
  tree: boolean;
  revision?: number;
}
export type SettingKey =
  | "verification"
  | "moderation"
  | "welcome"
  | "kicked"
  | "leave"
  | "tree";
export interface TreeAction {
  id: string;
  chat_id: number;
  actor_id: number;
  root_id: number;
  expires: number;
  state: string;
}
