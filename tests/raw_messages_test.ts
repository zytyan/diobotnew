import { Store } from "../src/store.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
Deno.test("原始消息保留完整JSON和编辑版本，重复投递去重且原始内容不可被分析结果覆盖", () => {
  const store = new Store(":memory:");
  try {
    const original = {
      message_id: 5,
      text: "来发财",
      reply_to_message: {
        text: "引用内容",
        contact: { user_id: 42, phone_number: "+123", vcard: "full-vcard" },
      },
      external_reply: { chat: { id: -2 }, message_id: 7 },
      entities: [{ type: "text_mention", user: { id: 42 } }],
      reply_markup: {
        inline_keyboard: [[{ text: "联系", url: "tg://user?id=42" }]],
      },
      photo: [{ file_id: "file", file_unique_id: "unique" }],
      extra_future_field: "must survive",
    };
    const raw = JSON.stringify(original);
    const update = JSON.stringify({ update_id: 123, message: original });
    const first = store.captureMessage(-1, 5, "first", raw, update);
    assert(store.captureMessage(-1, 5, "first", raw, update) === first);
    const edited = store.captureMessage(
      -1,
      5,
      "edit",
      JSON.stringify({ ...original, text: "edited", edit_date: 2 }),
      JSON.stringify({ update_id: 124, edited_message: original }),
    );
    assert(edited !== first && store.latestRawMessage(-1, 5)?.id === edited);
    store.snapshotContext(first, '{"sender":{"display_name":"A"}}');
    store.snapshotResult(first, "kept", { score: .572 });
    const saved = store.rawMessage(-1, first)!;
    assert(
      saved.message_json === raw && saved.update_json === update &&
        saved.action === "kept",
    );
    assert(
      JSON.parse(saved.message_json).extra_future_field === "must survive",
    );
    assert(store.rawMessage(-2, first) === undefined);
    assert(store.groupLogs(-1).some((row) => row.kind === "message"));
  } finally {
    store.close();
  }
});
Deno.test("原始消息重启保留，按完整记录清理过期数据而非截断字段", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/state.sqlite`;
  let store = new Store(path);
  try {
    const old = store.captureMessage(-1, 1, "old", '{"text":"old"}', "{}", 0);
    const current = store.captureMessage(
      -1,
      2,
      "current",
      '{"text":"完整当前消息"}',
      "{}",
    );
    store.close();
    store = new Store(path);
    assert(
      store.rawMessage(-1, current)?.message_json === '{"text":"完整当前消息"}',
    );
    store.pruneRawMessages();
    assert(!store.rawMessage(-1, old) && store.rawMessage(-1, current));
  } finally {
    store.close();
    Deno.removeSync(dir, { recursive: true });
  }
});
