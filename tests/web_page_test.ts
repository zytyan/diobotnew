import { runInNewContext } from "node:vm";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
const html = Deno.readTextFileSync(
  new URL("../web/index.html", import.meta.url),
);
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
class FakeElement {
  hidden = false;
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
  checked = false;
  disabled = false;
  className = "";
  type = "";
  maxLength = 0;
  placeholder = "";
  onclick = () => {};
  onchange = (_event?: { stopPropagation(): void }) => {};
  oninput = () => {};
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
    offline: false,
    conflict: false,
    hold: false,
    reportFails: false,
    logsDenied: false,
    release: () => {},
  };
  const context = {
    window: {
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
  return { elements, settings, calls, state, start, saves, storage };
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
  const before = JSON.parse(t.saves().at(-1)!.body!).rules;
  assert(before.length === 2 && before[0].enabled === false);
  const firstCard = t.elements.get("rules-list")!.children[0];
  const tools = firstCard.children.find((node) =>
    node.className === "rule-tools"
  )!;
  tools.children[1].onclick();
  await tick();
  const reordered = JSON.parse(t.saves().at(-1)!.body!).rules;
  assert(reordered[0].id === before[1].id && reordered[1].id === before[0].id);
  const card = t.elements.get("rules-list")!.children[0];
  card.children.at(-1)!.onclick();
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
