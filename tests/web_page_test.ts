import { validateMediaPolicies } from "../src/media_store.ts";
import { createHandler } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { validateRules } from "../src/rules.ts";
import { runInNewContext } from "node:vm";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const html = Deno.readTextFileSync(
  new URL("../web/index.html", import.meta.url),
);
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)![1].replace(
  "/*__RULE_VALIDATOR__*/ null",
  () => validateRules.toString(),
).replace(
  "/*__MEDIA_VALIDATOR__*/ null",
  () => validateMediaPolicies.toString(),
);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
class FakeElement {
  hidden = false;
  scrolled = false;
  focused = false;
  attributes = new Map<string, string>();
  tabIndex = 0;
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name);
  }
  onkeydown = (_event: { key: string; preventDefault(): void }) => {};
  listeners = new Map<
    string,
    (event: {
      target: { closest(selector: string): { open: boolean } | null };
    }) => void
  >();
  scrollIntoView() {
    this.scrolled = true;
  }
  focus() {
    this.focused = true;
  }
  addEventListener(
    name: string,
    handler: typeof this.listeners extends Map<string, infer H> ? H : never,
  ) {
    this.listeners.set(name, handler);
  }
  style: Record<string, string> = {};
  private text = "";
  get textContent() {
    return this.text;
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  children: FakeElement[] = [];
  value = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  blur() {
    this.onblur();
  }
  checked = false;
  disabled = false;
  className = "";
  type = "";
  maxLength = 0;
  placeholder = "";
  onclick = () => {};
  onchange = (
    _event?: { target?: { type: string }; stopPropagation(): void },
  ) => {};
  oninput = () => {};
  onblur = () => {};
  onfocus = () => {};
  onsubmit = (_event: { preventDefault(): void }) => {};
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
}
function page(
  storage = new Map<string, string>(),
  startParam = "settings_-1",
  resources: Record<string, unknown>[] = [],
) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => {
    const element = new FakeElement();
    element.hidden = [
      "settings",
      "settings-form",
      "retry",
      "load-again",
      "error-notice",
      "logs",
      "panel-rules",
      "panel-media",
    ].includes(match[1]);
    if (match[1] === "logs-filter") element.value = "all";
    return [match[1], element] as const;
  }));
  const settings = {
    revision: 0,
    aiThreshold: .8,
    moderation: "observe",
    verification: false,
    welcome: true,
    kicked: true,
    leave: false,
    tree: false,
    review: true,
    uploadAvatar: true,
  };
  const calls: {
    url: string;
    body?: string;
    method: string;
    headers: Record<string, string>;
  }[] = [];
  const state = {
    mediaEntries: [{
      id: 1,
      kind: "image",
      type: "unique",
      value: "unique",
      quality: null,
      note: "",
      actor: 42,
      created: 1,
    }],
    offline: false,
    conflict: false,
    hold: false,
    holdMediaGet: false,
    discardConfirmed: false,
    reportFails: false,
    logsDenied: false,
    release: () => {},
  };
  const context = {
    window: {
      confirm: () => state.discardConfirmed,
      localStorage: {
        getItem: (key: string) => storage.get(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
    document: {
      createElement: () => new FakeElement(),
      getElementById: (id: string) => elements.get(id),
      title: "",
    },
    location: {
      hash: "#" +
        new URLSearchParams({
          tgWebAppData: new URLSearchParams({
            start_param: startParam,
            hash: "signed-test-data",
          }).toString(),
        }),
      search: "",
    },
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    crypto,
    performance: {
      now: () => performance.now(),
      getEntriesByType: (type: string) => type === "resource" ? resources : [],
    },
    TypeError,
    fetch(url: string, options: Omit<typeof calls[number], "url">) {
      calls.push({ url, ...options });
      if (state.offline) return Promise.reject(new TypeError("Load failed"));
      if (url === "/api/client-logs") {
        return Promise.resolve(
          Response.json({ accepted: 1 }, {
            status: state.reportFails ? 503 : 202,
          }),
        );
      }
      if (url === "/api/media-blacklist") {
        if (options.method !== "GET") {
          const body = JSON.parse(options.body!);
          assert(body.revision === settings.revision);
          if (options.method === "DELETE") {
            state.mediaEntries = state.mediaEntries.filter((entry) =>
              entry.id !== body.id
            );
          } else {state.mediaEntries.find((entry) => entry.id === body.id)!
              .note = body.note;}
          settings.revision++;
        }
        const result = Response.json({
          revision: settings.revision,
          entries: state.mediaEntries,
        });
        if (
          (state.hold && options.method !== "GET") ||
          (state.holdMediaGet && options.method === "GET")
        ) {
          return new Promise<Response>((resolve) => {
            state.release = () => {
              state.hold = false;
              state.holdMediaGet = false;
              resolve(result);
            };
          });
        }
        return Promise.resolve(result);
      }
      if (url === "/api/logs") {
        return Promise.resolve(Response.json(
          state.logsDenied ? { error: "没有本群管理权限" } : {
            userId: 42,
            chat: { id: -1, title: "T" },
            logs: [{
              id: "1",
              time: Date.now(),
              kind: "action",
              data: {
                action: "rule_banned",
                text: "<script>untrusted</script>",
              },
            }],
          },
          { status: state.logsDenied ? 403 : 200 },
        ));
      }
      if (options.method === "PUT") {
        if (state.conflict) {
          return Promise.resolve(
            Response.json(
              { error: "设置已被其他管理员修改，请重新加载后保存" },
              { status: 409 },
            ),
          );
        }
        const input = JSON.parse(options.body!);
        assert(input.revision === settings.revision);
        Object.assign(settings, input, { revision: settings.revision + 1 });
      }
      const result = Response.json({
        userId: 42,
        chat: { id: -1, title: "Test" },
        settings,
        limits: { dailyRequests: 1000, reviewDays: 7, reviewPerChat: 1000 },
      }, {
        headers: {
          "X-Request-ID": crypto.randomUUID(),
          "Server-Timing": "settings;dur=10",
        },
      });
      if (options.method === "PUT" && state.hold) {
        return new Promise<Response>((resolve) => {
          state.release = () => {
            state.hold = false;
            resolve(result);
          };
        });
      }
      return Promise.resolve(result);
    },
  };
  const start = () => runInNewContext(script, context);
  const saves = () =>
    calls.filter((c) => c.url === "/api/settings" && c.method === "PUT");
  return {
    elements,
    settings,
    calls,
    state,
    start,
    saves,
    storage,
    location: context.location,
  };
}
Deno.test("无 Telegram SDK 仍可加载，修改开关立即自动保存并回传客户端耗时", async () => {
  const t = page();
  t.start();
  await tick();
  assert(
    t.elements.get("join")!.hidden && !t.elements.get("settings-form")!.hidden,
  );
  assert(t.elements.get("identity")!.textContent.includes("用户 ID：42"));
  t.elements.get("uploadAvatar")!.checked = false;
  t.elements.get("settings-form")!.onchange();
  await tick();
  assert(
    t.saves().length === 1 &&
      JSON.parse(t.saves()[0].body!).uploadAvatar === false,
  );
  assert(t.elements.get("save-state")!.textContent === "已保存，立即生效。");
  const reports = t.calls.filter((c) => c.url === "/api/client-logs");
  const logs = reports.flatMap((c) => JSON.parse(c.body!).events);
  assert(
    logs.some((e) => e.name === "settings_load") &&
      logs.some((e) => e.name === "settings_save"),
  );
  assert(!reports.some((c) => c.body!.includes("signed-test-data")));
});
Deno.test("自动保存串行提交，旧响应不覆盖后续输入，使用新版本号继续保存", async () => {
  const t = page();
  t.start();
  await tick();
  t.state.hold = true;
  t.elements.get("moderation")!.value = "ban";
  t.elements.get("settings-form")!.onchange();
  await tick();
  t.elements.get("threshold")!.value = "75";
  t.elements.get("uploadAvatar")!.checked = false;
  t.elements.get("settings-form")!.onchange();
  assert(t.saves().length === 1);
  t.state.release();
  await tick();
  assert(t.saves().length === 2);
  const latest = JSON.parse(t.saves()[1].body!);
  assert(
    latest.revision === 1 && latest.aiThreshold === .75 &&
      latest.uploadAvatar === false && latest.moderation === "ban",
  );
  assert(t.elements.get("threshold")!.value === "75");
});
Deno.test("保存冲突在底部醒目提示，保留修改且停止盲目覆盖", async () => {
  const t = page();
  t.start();
  await tick();
  t.state.conflict = true;
  t.elements.get("threshold")!.value = "72";
  t.elements.get("settings-form")!.onchange();
  await tick();
  assert(!t.elements.get("error-notice")!.hidden);
  assert(t.elements.get("error-title")!.textContent.includes("未确认生效"));
  assert(t.elements.get("error-text")!.textContent.includes("其他管理员"));
  assert(t.elements.get("threshold")!.value === "72");
  t.elements.get("settings-form")!.onchange();
  await tick();
  assert(t.saves().length === 1);
});
Deno.test("加载失败显眼提示，离线耗时日志暂存并在下一次打开时补传", async () => {
  const storage = new Map<string, string>();
  const failed = page(storage);
  failed.state.offline = true;
  failed.start();
  await tick();
  assert(
    !failed.elements.get("error-notice")!.hidden &&
      !failed.elements.get("load-again")!.hidden,
  );
  assert(
    failed.elements.get("error-text")!.textContent.includes("网络连接失败"),
  );
  assert([...storage.values()].join().includes('"error":"network"'));
  const recovered = page(storage);
  recovered.start();
  await tick();
  const reports = recovered.calls.filter((c) => c.url === "/api/client-logs");
  assert(reports.some((c) => c.body!.includes('"error":"network"')));
});
Deno.test("阈值无效时不上传设置，错误在操作区显示；日志回传失败不影响保存", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("threshold")!.value = "30";
  t.elements.get("settings-form")!.onchange();
  await tick();
  assert(t.saves().length === 0 && !t.elements.get("error-notice")!.hidden);
  t.state.reportFails = true;
  t.elements.get("threshold")!.value = "80";
  t.elements.get("settings-form")!.onchange();
  await tick();
  assert(t.saves().length === 1 && t.elements.get("error-notice")!.hidden);
  assert(t.elements.get("save-state")!.textContent.includes("已保存"));
});

Deno.test("手机规则编辑器支持新增、AND条件及上下排序，顺序自动保存", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("add-rule")!.onclick();
  await tick();
  t.elements.get("add-rule")!.onclick();
  await tick();
  assert(t.saves().length === 0);
  for (const card of t.elements.get("rules-list")!.children) {
    const pattern = rulePattern(card);
    assert(pattern.value === "" && pattern.placeholder.includes("请输入"));
    pattern.value = "test";
    pattern.oninput();
    pattern.onblur();
  }
  await tick();
  const before = JSON.parse(t.saves().at(-1)!.body!).rules;
  assert(before.length === 2 && before[0].enabled === false);
  const firstCard = t.elements.get("rules-list")!.children[0];
  const tools = findNode(firstCard, "rule-tools");
  tools.children[1].onclick();
  await tick();
  const reordered = JSON.parse(t.saves().at(-1)!.body!).rules;
  assert(reordered[0].id === before[1].id && reordered[1].id === before[0].id);
  const card = t.elements.get("rules-list")!.children[0];
  card.children.at(-1)!.onclick();
  await tick();
  const pattern = rulePattern(t.elements.get("rules-list")!.children[0], 1);
  assert(pattern.value === "");
  pattern.value = "valid";
  pattern.oninput();
  pattern.onblur();
  await tick();
  const grouped = JSON.parse(t.saves().at(-1)!.body!).rules;
  assert(grouped[0].conditions.length === 2);
});
Deno.test("日志页面显示安全的文本记录，失权后醒目提示且不展示设置表单", async () => {
  const t = page(new Map(), "logs_-1");
  t.start();
  await tick();
  assert(
    !t.elements.get("logs")!.hidden && t.elements.get("settings-form")!.hidden,
  );
  assert(t.elements.get("log-entries")!.children.length === 1);
  t.state.logsDenied = true;
  t.elements.get("logs-refresh")!.onclick();
  await tick();
  assert(
    !t.elements.get("error-notice")!.hidden &&
      t.elements.get("error-text")!.textContent.includes("管理权限"),
  );
});

Deno.test("首屏在SDK尚未加载时即可通知Telegram显示，支持移动和Web客户端桥接", () => {
  const bootstrap =
    html.match(/<script id="bootstrap">\s*([\s\S]*?)<\/script>/)![1];
  const events: string[] = [];
  const pending: (() => void)[] = [];
  const context = {
    window: {
      TelegramWebviewProxy: {
        postEvent: (name: string, _data: string) => events.push(name),
      },
    },
    document: { documentElement: { style: { setProperty() {} } } },
    location: { hash: "" },
    URLSearchParams,
    performance: { now: () => 20 },
    requestAnimationFrame: (callback: () => void) => pending.push(callback),
    setTimeout: (callback: () => void) => pending.push(callback),
  };
  runInNewContext(bootstrap, context);
  assert(events.join() === "web_app_ready" && pending.length >= 1);
  assert(html.indexOf('id="boot"') < html.indexOf('id="bootstrap"'));
  assert(
    !html.slice(0, html.indexOf('id="bootstrap"')).includes(
      'src="https://telegram.org',
    ),
  );
  const messages: string[] = [];
  const web = {
    ...context,
    window: {
      parent: {
        postMessage: (data: string, origin: string) => {
          assert(origin === "https://web.telegram.org");
          messages.push(data);
        },
      },
    },
  };
  runInNewContext(bootstrap, web);
  assert(JSON.parse(messages[0]).eventType === "web_app_ready");
});
Deno.test("分别回传脚本耗时，剥离URL查询参数，跨域受限指标不伪装成零", async () => {
  const t = page(new Map(), "settings_-1", [
    {
      name: "https://telegram.org/js/telegram-web-app.js?private=value#secret",
      initiatorType: "script",
      startTime: 1,
      duration: 3000,
      requestStart: 0,
      responseStart: 0,
      responseEnd: 0,
    },
    {
      name: "https://example.com/helper.js",
      initiatorType: "script",
      startTime: 5,
      duration: 2400,
      requestStart: 100,
      responseStart: 2100,
      responseEnd: 2400,
      domainLookupStart: 10,
      domainLookupEnd: 20,
      connectStart: 20,
      connectEnd: 100,
      secureConnectionStart: 30,
      responseStatus: 200,
    },
  ]);
  t.start();
  await tick();
  t.elements.get("send-logs")!.onclick();
  await tick();
  const entries = t.calls.filter((call) => call.url === "/api/client-logs")
    .flatMap((call) => JSON.parse(call.body!).events);
  const sdk = entries.find((event) =>
    event.resource === "https://telegram.org/js/telegram-web-app.js"
  );
  const helper = entries.find((event) =>
    event.resource === "https://example.com/helper.js"
  );
  assert(
    sdk.duration_ms === 3000 && sdk.timing_detail === "restricted" &&
      Object.keys(sdk.metrics).length === 0,
  );
  assert(
    helper.timing_detail === "full" && helper.metrics.ttfb_ms === 2000 &&
      helper.metrics.dns_ms === 10,
  );
  assert(
    !JSON.stringify(entries).includes("private=value") &&
      !JSON.stringify(entries).includes("#secret"),
  );
});

function findNode(root: FakeElement, className: string): FakeElement {
  if (root.className === className) return root;
  for (const child of root.children) {
    const result = findNodeOrNull(child, className);
    if (result) return result;
  }
  throw new Error(`Missing ${className}`);
}
function findNodeOrNull(
  root: FakeElement,
  className: string,
): FakeElement | null {
  if (root.className === className) return root;
  for (const child of root.children) {
    const result = findNodeOrNull(child, className);
    if (result) return result;
  }
  return null;
}
function rulePattern(card: FakeElement, index = 0) {
  const row =
    card.children.filter((node) => node.className === "rule-condition")[index];
  return findNode(row, "regex-input");
}
Deno.test("阈值编辑和change不保存，失焦后才保存；旧请求完成不提交仍在编辑的值", async () => {
  const t = page();
  t.start();
  await tick();
  const threshold = t.elements.get("threshold")!;
  threshold.value = "75";
  threshold.oninput();
  t.elements.get("settings-form")!.onchange(
    { target: { type: "number" }, stopPropagation() {} } as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert(t.saves().length === 0);
  t.state.hold = true;
  threshold.onblur();
  await tick();
  assert(t.saves().length === 1);
  threshold.value = "78";
  threshold.oninput();
  t.state.release();
  await tick();
  assert(t.saves().length === 1);
  threshold.onblur();
  await tick();
  assert(
    t.saves().length === 2 &&
      JSON.parse(t.saves()[1].body!).aiThreshold === .78,
  );
});
Deno.test("正则草稿留空，失焦校验语法，勾选标志串行保存且不产生重复标志", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("add-rule")!.onclick();
  const pattern = rulePattern(t.elements.get("rules-list")!.children[0]);
  pattern.onblur();
  await tick();
  assert(t.saves().length === 0);
  pattern.value = "[";
  pattern.oninput();
  pattern.onblur();
  await tick();
  assert(
    t.saves().length === 0 &&
      t.elements.get("save-state")!.textContent.includes("语法无效"),
  );
  pattern.value = "hello";
  pattern.oninput();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert(t.saves().length === 0);
  pattern.onblur();
  await tick();
  assert(t.saves().length === 1);
  const card = t.elements.get("rules-list")!.children[0];
  const flags = findNode(card, "regex-flags");
  const ignoreCase = flags.children[0].children[0];
  ignoreCase.checked = false;
  ignoreCase.onchange();
  await tick();
  assert(t.saves().length === 2);
  assert(
    JSON.parse(t.saves().at(-1)!.body!).rules[0].conditions[0].flags === "u",
  );
  ignoreCase.checked = true;
  ignoreCase.onchange();
  await tick();
  assert(t.saves().length === 3);
  assert(
    JSON.parse(t.saves().at(-1)!.body!).rules[0].conditions[0].flags === "iu",
  );
});

Deno.test("实际页面注入服务端校验函数，客户端执行相同规则格式及正则检查", async () => {
  const store = new Store(":memory:");
  try {
    const handler = createHandler(
      loadConfig({ BOT_TOKEN: "99:fake", TELEGRAM_ENV: "test" }),
      store,
      html,
    );
    const response = await handler(new Request("https://test.example/"));
    const page = await response.text();
    assert(!page.includes("/*__RULE_VALIDATOR__*/ null"));
    const source = page.match(
      /const validateRules = ([\s\S]*?);\n\s*let lastOperation/,
    )![1];
    const clientValidate = runInNewContext(`(${source})`);
    const rule = {
      id: "test",
      name: "规则",
      enabled: false,
      action: "ban",
      conditions: [{ field: "message", pattern: "hello", flags: "iu" }],
    };
    const invalid = [
      [{ ...rule, name: "x".repeat(65) }],
      [rule, rule],
      [{ ...rule, conditions: [] }],
      [{
        ...rule,
        conditions: [{ field: "invalid", pattern: "hello", flags: "" }],
      }],
      ...["", "[", "x".repeat(257)].map((
        pattern,
      ) => [{
        ...rule,
        conditions: [{ field: "message", pattern, flags: "iu" }],
      }]),
      ...["ii", "g", "v"].map((
        flags,
      ) => [{
        ...rule,
        conditions: [{ field: "message", pattern: "hello", flags }],
      }]),
    ];
    assert(
      JSON.stringify(clientValidate([rule])) ===
        JSON.stringify(validateRules([rule])),
    );
    for (const value of invalid) {
      let clientError = "", serverError = "";
      try {
        clientValidate(value);
      } catch (error) {
        clientError = (error as Error).message;
      }
      try {
        validateRules(value);
      } catch (error) {
        serverError = (error as Error).message;
      }
      assert(clientError !== "" && clientError === serverError);
    }
  } finally {
    store.close();
  }
});

Deno.test("图片和sticker策略独立、默认关闭，PDQ数值仅失焦保存，非法Quality本地拦截", async () => {
  const t = page();
  t.start();
  await tick();
  assert(
    !t.elements.get("media-image-enabled")!.checked &&
      !t.elements.get("media-sticker-enabled")!.checked,
  );
  const distance = t.elements.get("media-image-distance")!;
  distance.value = "12";
  distance.oninput();
  await tick();
  assert(t.saves().length === 0);
  distance.onblur();
  await tick();
  const policies = JSON.parse(t.saves()[0].body!).media;
  assert(policies.image.distance === 12 && policies.sticker.distance === 31);
  const quality = t.elements.get("media-sticker-quality")!;
  quality.value = "101";
  quality.oninput();
  quality.onblur();
  await tick();
  assert(
    t.saves().length === 1 &&
      t.elements.get("error-text")!.textContent.includes("Quality"),
  );
  quality.value = "50";
  quality.oninput();
  quality.onblur();
  await tick();
  assert(t.saves().length === 2);
});
Deno.test("网页名单加载、备注失焦和删除串行递增版本；旧响应不重绘正在编辑的备注", async () => {
  const t = page();
  t.state.mediaEntries.push({
    ...t.state.mediaEntries[0],
    id: 2,
    value: "second",
  });
  t.start();
  await tick();
  t.elements.get("media-image-refresh")!.onclick();
  await tick();
  const list = t.elements.get("media-image-entries")!;
  assert(list.children.length === 2);
  const firstNote = list.children[0].children[1].children[0];
  firstNote.value = "first note";
  firstNote.oninput();
  await tick();
  const mutations = () =>
    t.calls.filter((c) =>
      c.url === "/api/media-blacklist" && c.method !== "GET"
    );
  assert(mutations().length === 0);
  t.state.hold = true;
  firstNote.onblur();
  await tick();
  const secondNote = list.children[1].children[1].children[0];
  secondNote.value = "still editing";
  secondNote.oninput();
  t.state.release();
  await tick();
  assert(
    list.children[1].children[1].children[0] === secondNote &&
      mutations().length === 1,
  );
  secondNote.onblur();
  await tick();
  assert(
    mutations().length === 2 && JSON.parse(mutations()[1].body!).revision === 1,
  );
  list.children[0].children[2].onclick();
  await tick();
  assert(
    mutations().length === 3 && Number(list.children.length) === 1 &&
      t.settings.revision === 3,
  );
});

Deno.test("刷新名单期间失焦的备注排队保存，不丢失提交请求", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("media-image-refresh")!.onclick();
  await tick();
  const note =
    t.elements.get("media-image-entries")!.children[0].children[1].children[0];
  t.state.holdMediaGet = true;
  t.elements.get("media-image-refresh")!.onclick();
  await tick();
  note.value = "queued";
  note.oninput();
  note.onblur();
  assert(
    !t.calls.some((c) =>
      c.url === "/api/media-blacklist" && c.method === "POST"
    ),
  );
  t.state.release();
  await tick();
  assert(
    t.calls.some((c) =>
      c.url === "/api/media-blacklist" && c.method === "POST"
    ),
  );
  assert(t.state.mediaEntries[0].note === "queued");
});

Deno.test("分区切换只展示选中的页面，保留Telegram凭据和未提交草稿", async () => {
  const t = page();
  t.start();
  await tick();
  const hash = t.location.hash;
  t.elements.get("threshold")!.value = "72";
  t.elements.get("threshold")!.oninput();
  for (const section of ["rules", "media", "general"]) {
    t.elements.get(`nav-${section}`)!.onclick();
    for (const key of ["general", "rules", "media"]) {
      assert(t.elements.get(`panel-${key}`)!.hidden === (key !== section));
      assert(
        t.elements.get(`nav-${key}`)!.getAttribute("aria-selected") ===
          String(key === section),
      );
    }
  }
  assert(t.location.hash === hash && t.saves().length === 0);
  assert(t.elements.get("threshold")!.value === "72");
});
Deno.test("分区支持方向键循环选择和Home/End，焦点与可见页面一致", async () => {
  const t = page();
  t.start();
  await tick();
  let prevented = false;
  t.elements.get("nav-general")!.onkeydown({
    key: "ArrowLeft",
    preventDefault() {
      prevented = true;
    },
  });
  assert(prevented && !t.elements.get("panel-media")!.hidden);
  assert(
    t.elements.get("nav-media")!.focused &&
      t.elements.get("nav-media")!.tabIndex === 0,
  );
  t.elements.get("nav-media")!.onkeydown({ key: "Home", preventDefault() {} });
  assert(
    !t.elements.get("panel-general")!.hidden &&
      t.elements.get("nav-general")!.focused,
  );
});

Deno.test("折叠的高级设置校验失败时展开，普通字段不受影响", async () => {
  const t = page();
  t.start();
  await tick();
  const invalid = t.elements.get("settings-form")!.listeners.get("invalid")!;
  const details = { open: false };
  invalid({
    target: { closest: (selector) => selector === "details" ? details : null },
  });
  assert(details.open);
  invalid({ target: { closest: () => null } });
  assert(t.saves().length === 0);
});

Deno.test("媒体名单区分未加载与空名单，请求期间禁用刷新并显示进度", async () => {
  const t = page();
  t.start();
  await tick();
  assert(
    t.elements.get("media-image-entries")!.textContent.includes("尚未加载"),
  );
  t.state.mediaEntries = [];
  t.state.holdMediaGet = true;
  t.elements.get("media-image-refresh")!.onclick();
  await tick();
  for (const kind of ["image", "sticker"]) {
    const button = t.elements.get(`media-${kind}-refresh`)!;
    assert(button.disabled && button.textContent.includes("正在加载"));
  }
  t.state.release();
  await tick();
  for (const kind of ["image", "sticker"]) {
    assert(!t.elements.get(`media-${kind}-refresh`)!.disabled);
    assert(
      t.elements.get(`media-${kind}-entries`)!.textContent.includes(
        "暂无黑名单",
      ),
    );
  }
});

Deno.test("重新加载前确认丢弃草稿，取消时保留输入且不发送加载请求", async () => {
  const t = page();
  t.start();
  await tick();
  const loads = () =>
    t.calls.filter((c) => c.url === "/api/settings" && c.method === "GET")
      .length;
  t.elements.get("threshold")!.value = "72";
  t.elements.get("threshold")!.oninput();
  t.elements.get("reload")!.onclick();
  await tick();
  assert(loads() === 1 && t.elements.get("threshold")!.value === "72");
  t.state.discardConfirmed = true;
  t.elements.get("reload")!.onclick();
  await tick();
  assert(loads() === 2 && Number(t.elements.get("threshold")!.value) === 80);
});

Deno.test("新规则先改标题或动作时保留未完成草稿，不弹出阻断编辑的错误卡片", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("add-rule")!.onclick();
  const card = t.elements.get("rules-list")!.children[0];
  const name = findNode(card, "rule-name");
  name.value = "我的新规则";
  name.oninput();
  name.onblur();
  await tick();
  assert(t.saves().length === 0 && t.elements.get("error-notice")!.hidden);
  const pattern = rulePattern(card);
  pattern.value = "hello";
  pattern.oninput();
  pattern.onblur();
  await tick();
  assert(t.saves().length === 1);
  assert(JSON.parse(t.saves()[0].body!).rules[0].name === "我的新规则");
});

Deno.test("正则辅助键包裹选中内容、保持草稿和光标位置，完成时才保存", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("add-rule")!.onclick();
  const pattern = rulePattern(t.elements.get("rules-list")!.children[0]);
  pattern.value = "hello";
  pattern.oninput();
  pattern.setSelectionRange(0, 5);
  pattern.onfocus();
  const groupKey = t.elements.get("regex-keys")!.children.find((key) =>
    key.getAttribute("aria-label") === "分组 ( )"
  )!;
  groupKey.onclick();
  assert(pattern.value === "(hello)" && pattern.selectionStart === 6);
  assert(
    pattern.focused && !t.elements.get("regex-keyboard")!.hidden &&
      t.saves().length === 0,
  );
  t.elements.get("regex-done")!.onclick();
  await tick();
  assert(t.saves().length === 1 && t.elements.get("regex-keyboard")!.hidden);
  assert(
    JSON.parse(t.saves()[0].body!).rules[0].conditions[0].pattern === "(hello)",
  );
  await new Promise((resolve) => setTimeout(resolve, 160));
});

Deno.test("正则高亮保留原始字符，区分转义、字符集与量词", async () => {
  const t = page();
  t.start();
  await tick();
  t.elements.get("add-rule")!.onclick();
  const card = t.elements.get("rules-list")!.children[0];
  const pattern = rulePattern(card);
  pattern.value = String.raw`t\.me|[a-z]+`;
  pattern.oninput();
  const layer = findNode(card, "regex-highlight");
  assert(
    layer.children.map((span) => span.textContent).join("") === pattern.value,
  );
  assert(
    ["rx-escape", "rx-class", "rx-quantifier"].every((token) =>
      layer.children.some((span) => span.className === token)
    ),
  );
  pattern.value = "<b>hello</b>";
  pattern.oninput();
  assert(
    layer.children.map((span) => span.textContent).join("") === pattern.value,
  );
  assert(t.saves().length === 0);
});
