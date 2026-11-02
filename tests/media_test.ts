import { orientRgb, rgbaRgb } from "../src/media_pixels.ts";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import {
  hamming,
  MediaService,
  type MediaSource,
  mediaSource,
  pdqRgb,
} from "../src/media.ts";
import {
  defaultMediaPolicies,
  validateMediaEntry,
  validateMediaPolicies,
} from "../src/media_store.ts";
import { groupSettings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Api } from "grammy";
import type { Message, Update } from "grammy/types";
function assert(v: unknown, detail = "assertion failed"): asserts v {
  if (!v) throw new Error(detail);
}
const config = loadConfig({ BOT_TOKEN: "99:fake", TELEGRAM_ENV: "test" });
const message = {
  message_id: 1,
  date: 1,
  chat: { id: -1, type: "supergroup", title: "Test" },
  from: { id: 42, is_bot: false, first_name: "Alice" },
};
const photo = {
  ...message,
  photo: [{
    file_id: "small",
    file_unique_id: "small-unique",
    width: 64,
    height: 64,
  }, {
    file_id: "large",
    file_unique_id: "large-unique",
    width: 128,
    height: 128,
  }],
} as Message;
const source = mediaSource(photo)!;
const api = {} as Pick<Api, "getFile">;
Deno.test("媒体识别：照片全部尺寸别名、图片文件、三种sticker，拒绝普通视频和GIF", () => {
  assert(source.file === "large" && source.aliases.length === 2);
  for (
    const [field, value, expected] of [
      ["document", {
        file_id: "f",
        file_unique_id: "u",
        mime_type: "image/png",
      }, "image"],
      [
        "sticker",
        { file_id: "f", file_unique_id: "u", is_animated: true },
        "tgs",
      ],
      [
        "sticker",
        { file_id: "f", file_unique_id: "u", is_video: true },
        "webm",
      ],
      [
        "sticker",
        { file_id: "f", file_unique_id: "u", set_name: "Pack" },
        "image",
      ],
    ] as const
  ) {
    assert(
      mediaSource({ ...message, [field]: value } as Message)?.format ===
        expected,
    );
  }
  assert(
    !mediaSource(
      {
        ...message,
        document: { mime_type: "image/gif", file_name: "a.gif" },
      } as Message,
    ),
  );
  assert(!mediaSource({ ...message, video: {} } as Message));
});
Deno.test("黑名单SQLite：按群和类别隔离、别名去重、版本冲突、删除、重启保留", () => {
  const dir = Deno.makeTempDirSync();
  let store = new Store(`${dir}/state.sqlite`);
  try {
    groupSettings(config, store, -1);
    groupSettings(config, store, -2);
    const added = store.media.add(-1, 1, {
      kind: "image",
      type: "unique",
      value: source.unique,
      aliases: source.aliases,
    }, 0);
    assert(added.revision === 1);
    assert(
      store.media.add(-1, 1, {
        kind: "image",
        type: "unique",
        value: "small-unique",
      }, 1).duplicate,
    );
    assert(
      store.media.entries(-2).length === 0 &&
        store.media.entries(-1, "sticker").length === 0,
    );
    let conflict = false;
    try {
      store.media.remove(-1, added.entry.id, 0);
    } catch {
      conflict = true;
    }
    assert(conflict && store.media.entries(-1).length === 1);
    store.close();
    store = new Store(`${dir}/state.sqlite`);
    assert(store.media.entries(-1)[0].aliases.includes("small-unique"));
    assert(store.media.remove(-2, added.entry.id, 0) === 0);
    assert(store.media.remove(-1, added.entry.id, 1) === 2);
    assert(store.media.entries(-1).length === 0);
  } finally {
    store.close();
    Deno.removeSync(dir, { recursive: true });
  }
});
Deno.test("媒体匹配：ID和组名不下载、组内新增sticker匹配，PDQ距离及双方Quality边界", async () => {
  const store = new Store(":memory:");
  try {
    groupSettings(config, store, -1);
    let computations = 0;
    const service = new MediaService(store.media, api, config, fetch, () => {
      computations++;
      return Promise.resolve({ hash: "0".repeat(63) + "1", quality: 50 });
    });
    const policies = defaultMediaPolicies();
    policies.image.enabled = policies.sticker.enabled = true;
    store.media.add(-1, 1, {
      kind: "image",
      type: "unique",
      value: source.unique,
      aliases: source.aliases,
    }, 0);
    assert(
      (await service.match(-1, source, policies))?.type === "unique" &&
        computations === 0,
    );
    store.media.add(-1, 1, { kind: "sticker", type: "set", value: "Pack" }, 1);
    const sticker: MediaSource = {
      kind: "sticker",
      format: "image",
      file: "f",
      unique: "new",
      aliases: ["new"],
      set: "PACK",
    };
    assert(
      (await service.match(-1, sticker, policies))?.type === "set" &&
        computations === 0,
    );
    store.media.add(-1, 1, {
      kind: "image",
      type: "pdq",
      value: "0".repeat(64),
      quality: 50,
    }, 2);
    const query = { ...source, unique: "different", aliases: ["different"] };
    policies.image.distance = 0;
    assert(!await service.match(-1, query, policies));
    policies.image.distance = 1;
    assert((await service.match(-1, query, policies))?.distance === 1);
    policies.image.quality = 51;
    assert(!await service.match(-1, query, policies));
    assert(Number(computations) === 1);
    assert(hamming("0".repeat(64), "f".repeat(64)) === 256);
    assert(hamming("0".repeat(64), "0".repeat(64)) === 0);
  } finally {
    store.close();
  }
});
Deno.test("PDQ WASM与官方C++ RGB参考实现完全一致；透明像素统一白底，损坏输入不计算", async () => {
  const rgb = new Uint8Array(128 * 128 * 3);
  let i = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      for (
        const c of [
          (x * 2 + y) % 256,
          (y * 2) % 256,
          ((Math.floor(x / 16) + Math.floor(y / 16)) % 2) * 200,
        ]
      ) rgb[i++] = c;
    }
  }
  const result = await pdqRgb(
    { rgb, width: 128, height: 128 },
    AbortSignal.timeout(10000),
  );
  assert(
    result.hash ===
        "aaa2a8e822aa8adfaa22a8ffaa2a8add2a226faa5aaa7688d52a774a5dd27536" &&
      result.quality === 100,
  );
  assert(
    rgbaRgb(new Uint8Array([20, 30, 40, 0]), 1, 1).rgb.every((v) => v === 255),
  );
  let failed = false;
  try {
    await pdqRgb(
      { rgb: new Uint8Array(0), width: 128, height: 128 },
      AbortSignal.timeout(1000),
    );
  } catch {
    failed = true;
  }
  assert(failed);
});
Deno.test("真实解码：PNG/JPEG/WebP/WebM首帧及TGS WASM渲染，缓存复用，超限和坏文件保留", async () => {
  const store = new Store(":memory:");
  let bytes = new Uint8Array();
  let downloads = 0;
  const service = new MediaService(
    store.media,
    {
      getFile: () =>
        Promise.resolve({
          file_id: "f",
          file_unique_id: "u",
          file_path: "fixture",
        }),
    },
    config,
    () => {
      downloads++;
      return Promise.resolve(new Response(bytes.slice()));
    },
  );
  try {
    const baseline = JSON.parse(
      await Deno.readTextFile(
        new URL("./fixtures/media/native-baseline.json", import.meta.url),
      ),
    );
    const results = [];
    for (
      const file of [
        "image.png",
        "image.jpg",
        "image.webp",
        "first-frame.webm",
        "first-frame.tgs",
      ]
    ) {
      bytes = await Deno.readFile(
        new URL(`./fixtures/media/${file}`, import.meta.url),
      );
      const input: MediaSource = {
        kind: file.includes("frame") ? "sticker" : "image",
        format: file.endsWith("tgs")
          ? "tgs"
          : file.endsWith("webm")
          ? "webm"
          : "image",
        file: "f",
        unique: file,
        aliases: [file],
      };
      const result = await service.hash(input);
      results.push(result);
      assert(/^[a-f0-9]{64}$/.test(result.hash));
      assert(
        result.hash === baseline[file].hash &&
          result.quality === baseline[file].quality,
        `WASM must preserve stored PDQ semantics: ${file}`,
      );
      assert((await service.hash(input)).hash === result.hash);
    }
    assert(downloads === 5);
    assert(
      hamming(results[0].hash, results[1].hash) <= 31 &&
        hamming(results[0].hash, results[2].hash) <= 31,
    );
    assert(hamming(results[0].hash, results[3].hash) <= 31);
    const redHalf = new Uint8Array(128 * 128 * 3);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        redHalf.set(x < 64 ? [255, 0, 0] : [255, 255, 255], (y * 128 + x) * 3);
      }
    }
    const reference = await pdqRgb(
      { rgb: redHalf, width: 128, height: 128 },
      AbortSignal.timeout(10000),
    );
    assert(
      results[4].hash === reference.hash,
      "TGS must render frame zero exactly",
    );
    const alphaHashes = [];
    for (const file of ["alpha.png", "alpha.webm"]) {
      bytes = await Deno.readFile(
        new URL(`./fixtures/media/${file}`, import.meta.url),
      );
      alphaHashes.push(
        await service.hash({
          kind: "sticker",
          format: file.endsWith("webm") ? "webm" : "image",
          file: "f",
          unique: file,
          aliases: [file],
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      const file = i ? "alpha.webm" : "alpha.png";
      assert(
        alphaHashes[i].hash === baseline[file].hash,
        `WASM alpha PDQ must match native: ${file}`,
      );
    }
    assert(
      hamming(alphaHashes[0].hash, alphaHashes[1].hash) <= 31,
      "WebM alpha must composite onto white like PNG",
    );
    bytes = new TextEncoder().encode("not an image");
    let errors = 0;
    for (
      const s of [{ ...source, unique: "bad" }, {
        ...source,
        unique: "large",
        size: 21 * 1024 * 1024,
      }]
    ) {
      try {
        await service.hash(s);
      } catch {
        errors++;
      }
    }
    assert(errors === 2);
  } finally {
    store.close();
  }
});
Deno.test("共享校验：拒绝非法策略、空ID、非法hash和组名；默认各类关闭并独立", () => {
  const policies = defaultMediaPolicies();
  policies.image.distance = 0;
  assert(
    policies.sticker.distance === 31 && !policies.image.enabled &&
      !policies.sticker.enabled,
  );
  let errors = 0;
  for (
    const value of [{
      ...policies,
      image: { ...policies.image, distance: 257 },
    }, { ...policies, image: { ...policies.image, quality: -1 } }]
  ) {
    try {
      validateMediaPolicies(value);
    } catch {
      errors++;
    }
  }
  for (
    const value of [{ kind: "image", type: "unique", value: "" }, {
      kind: "image",
      type: "set",
      value: "Pack",
    }, { kind: "sticker", type: "pdq", value: "0".repeat(64), quality: 101 }]
  ) {
    try {
      validateMediaEntry(value);
    } catch {
      errors++;
    }
  }
  assert(errors === 5);
});
Deno.test("完整媒体审核：独立动作、优先正则白名单、管理员保护，AI关闭也生效且check不处罚", async () => {
  for (const mode of ["observe", "delete", "mute", "ban"] as const) {
    const store = new Store(":memory:");
    const settings = groupSettings(config, store, -1);
    const policies = defaultMediaPolicies();
    policies.image.enabled = true;
    policies.image.action = mode;
    store.saveSettings(-1, {
      ...settings,
      aiThreshold: .8,
      media: policies,
      rules: [{
        id: "allow",
        name: "all",
        enabled: true,
        action: "allow",
        conditions: [{ field: "message", pattern: ".*", flags: "" }],
      }],
    }, 0);
    store.media.add(-1, 1, {
      kind: "image",
      type: "unique",
      value: source.unique,
      aliases: source.aliases,
    }, 1);
    let role = "member";
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const { bot } = createBot(config, store, {
      request: () => Promise.reject(new Error("AI must not run")),
    });
    bot.api.config.use((_prev, method, payload) => {
      const p = payload as Record<string, unknown>;
      calls.push({ method, payload: p });
      const result = method === "getMe"
        ? { id: 99, is_bot: true, first_name: "Bot", username: "bot" }
        : method === "getChatMember"
        ? {
          status: p.user_id === 1 ? "creator" : role,
          user: { id: p.user_id, is_bot: false, first_name: "U" },
        }
        : true;
      return Promise.resolve({ ok: true, result }) as ReturnType<
        typeof _prev<typeof method>
      >;
    });
    try {
      await bot.init();
      await bot.handleUpdate({ update_id: 1, message: photo } as Update);
      assert(
        calls.some((c) => c.method === "deleteMessage") ===
          (mode !== "observe"),
      );
      assert(
        calls.some((c) => c.method === "banChatMember") === (mode === "ban"),
      );
      assert(
        calls.some((c) => c.method === "restrictChatMember") ===
          (mode === "mute"),
      );
      assert(
        !calls.some((c) =>
          c.method === "getFile" || c.method === "getUserProfilePhotos" ||
          c.method === "getChat"
        ),
      );
      assert(
        JSON.parse(store.latestRawMessage(-1, 1)!.result_json!).model ===
          "local-media",
      );
      const before = calls.filter((c) =>
        ["deleteMessage", "banChatMember", "restrictChatMember"].includes(
          c.method,
        )
      ).length;
      await bot.handleUpdate({
        update_id: 2,
        message: {
          ...message,
          message_id: 2,
          from: { id: 1, is_bot: false, first_name: "Admin" },
          text: "/check",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
          reply_to_message: { ...photo, reply_to_message: undefined },
        },
      } as Update);
      assert(JSON.stringify(calls.at(-1)).includes("已记录的媒体黑名单匹配"));
      role = "administrator";
      await bot.handleUpdate(
        { update_id: 3, message: { ...photo, message_id: 3 } } as Update,
      );
      assert(
        calls.filter((c) =>
          ["deleteMessage", "banChatMember", "restrictChatMember"].includes(
            c.method,
          )
        ).length === before,
      );
    } finally {
      store.close();
    }
  }
});

Deno.test("媒体处理期间升管理员或设置变化不处罚，hash失败记日志并继续正则规则", async () => {
  for (const scenario of ["promotion", "settings", "failure"] as const) {
    const store = new Store(":memory:");
    const initial = groupSettings(config, store, -1);
    const policies = defaultMediaPolicies();
    policies.image.enabled = true;
    policies.image.action = "ban";
    store.saveSettings(-1, {
      ...initial,
      aiThreshold: .8,
      media: policies,
      rules: [{
        id: "allow",
        name: "allow",
        enabled: true,
        action: "allow",
        conditions: [{ field: "message", pattern: ".*", flags: "" }],
      }],
    }, 0);
    store.media.add(-1, 1, {
      kind: "image",
      type: "pdq",
      value: "0".repeat(64),
      quality: 100,
    }, 1);
    let role = "member";
    const media = new MediaService(store.media, api, config, fetch, () => {
      if (scenario === "failure") throw new Error("decoder failed");
      if (scenario === "promotion") role = "administrator";
      if (scenario === "settings") store.updateSetting(-1, "welcome", false, 2);
      return Promise.resolve({ hash: "0".repeat(64), quality: 100 });
    });
    const calls: string[] = [];
    const { bot } = createBot(config, store, { media });
    bot.api.config.use((_prev, method) => {
      calls.push(method);
      const result = method === "getMe"
        ? { id: 99, is_bot: true, first_name: "B", username: "bot" }
        : method === "getChatMember"
        ? { status: role, user: message.from }
        : method === "getChat"
        ? { id: 42, type: "private", first_name: "Alice" }
        : method === "getUserProfilePhotos"
        ? { total_count: 0, photos: [] }
        : true;
      return Promise.resolve({ ok: true, result }) as ReturnType<
        typeof _prev<typeof method>
      >;
    });
    try {
      await bot.init();
      await bot.handleUpdate({ update_id: 1, message: photo } as Update);
      assert(
        !calls.some((c) =>
          ["deleteMessage", "banChatMember", "restrictChatMember"].includes(c)
        ),
      );
      if (scenario === "settings") {
        assert(store.latestRawMessage(-1, 1)?.action === "settings_changed");
      }
      if (scenario === "failure") {
        assert(store.latestRawMessage(-1, 1)?.action === "rule_allowed");
        assert(
          store.groupLogs(-1).some((row) => row.data.event === "media_error"),
        );
      }
    } finally {
      store.close();
    }
  }
});

Deno.test("内嵌解码器保留JPEG全部EXIF方向，与迁移前原生PDQ完全一致", async () => {
  const original = await Deno.readFile(
    new URL("./fixtures/media/image.jpg", import.meta.url),
  );
  const baseline = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/media/native-baseline.json", import.meta.url),
    ),
  );
  for (let orientation = 2; orientation <= 8; orientation++) {
    const tiff = new Uint8Array(26);
    tiff.set([
      0x49,
      0x49,
      42,
      0,
      8,
      0,
      0,
      0,
      1,
      0,
      0x12,
      1,
      3,
      0,
      1,
      0,
      0,
      0,
      orientation,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const exif = new Uint8Array(36);
    exif.set([0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0]);
    exif.set(tiff, 10);
    const image = new Uint8Array(original.length + exif.length);
    image.set(original.subarray(0, 2));
    image.set(exif, 2);
    image.set(original.subarray(2), exif.length + 2);
    const result = await pdqRgb(
      { media: image, webm: false },
      AbortSignal.timeout(10000),
    );
    assert(
      result.hash === baseline[`orientation-${orientation}`].hash &&
        result.quality === baseline[`orientation-${orientation}`].quality,
      `EXIF ${orientation}`,
    );
  }
});

Deno.test("EXIF转置保持非正方形图片的尺寸和像素位置", () => {
  const rgb = new Uint8Array([
    1,
    1,
    1,
    2,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    5,
    6,
    6,
    6,
  ]);
  const result = orientRgb({ rgb, width: 2, height: 3 }, 6);
  assert(result.width === 3 && result.height === 2);
  assert(
    [...result.rgb].filter((_, index) => index % 3 === 0).join() ===
      "5,3,1,6,4,2",
  );
});
