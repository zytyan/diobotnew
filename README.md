# Diobot

Telegram 群管理工具，使用 TypeScript、grammY 和 Deno
2，编译为包含运行时和验证页面的独立二进制。目标服务器不需要安装 Deno 或
Node.js。

## 分支与旧版

- `archive/go-legacy`：原 Go 源码快照。
- `main`：新的 TS 实现。

原目录没有 Git 历史，因此归档分支是本次创建的源代码快照。旧的 `diobotnew`
二进制和本机 `diobot.service` 保留并被 Git
忽略；后者包含部署密钥，不纳入版本控制。本次不切换或重启现有服务。

## 功能

- 按群区分验证群和公开群。
- 验证群：入群申请私信验证；普通邀请链接入群先禁言再验证；通过后按群默认权限恢复。成员直接邀请沿用旧版欢迎语，不触发验证。
- 通过链接入群后的 10
  分钟发言检查；六分钟验证期限；最多三次失败。超时/失败沿用旧版的封禁行为，需要管理员解除后才能再次入群。
- 加群、退群、封禁通知。封禁文案简化为永久/临时两类。
- Telegram 签名校验、一次申请专属链接、Turnstile 域名/action/cdata
  校验。无绕过身份校验的测试开关。
- SQLite 保存申请期限、群活动及 bot
  被移除状态；重启后继续处理到期任务。旧版内存中的申请不迁移。
- 私聊 `/stats`：仅 `OWNER_IDS`
  可查看已观察到的群及最近活动；历史上从未收到更新的群无法发现。
- 可选 Cloudflare Workers AI 文本/图片说明审核：默认关闭；支持 `observe`
  只记录或 `delete`
  删除明确广告；处理新消息和编辑消息。不会自动封禁，不识别图片像素/语音；异常时保留消息。
- `GET /healthz` 是进程 HTTP 存活检查，不表示 Telegram 或 Cloudflare 服务正常。

## 开发

需要 Deno 2.2+，本项目使用 Deno 2.9.3 验证。

```sh
cp .env.example .env
# 编辑 .env，填入单独的测试 bot 和 Turnstile 配置
chmod 600 .env
deno task dev
```

`.env` 只由开发启动任务加载。二进制使用进程环境变量；systemd 模板通过
`EnvironmentFile` 加载。

`TELEGRAM_ENV=test` 连接 Telegram 测试环境，使用测试环境 BotFather 的
token；它和正式环境完全分离。测试模式也会正常校验 Telegram 身份。验证页面在
BotFather 配置为 Main Mini App，URL 指向本服务 `/`；专属链接使用
`?startapp=<申请ID>`。

HTTP 默认监听 `127.0.0.1:8532`，生产环境由反向代理提供 HTTPS。`VERIFY_HOSTNAME`
填验证网页的域名，不带协议/端口。正式模式不允许自动放行的 Turnstile 测试
key；测试环境使用测试 key 时也必须满足返回的 hostname/action/cdata
校验，不满足时请使用专门的真实测试 widget。

bot 应为群管理员，具有审批邀请、限制/封禁成员和删除消息权限。`PUBLIC_CHAT_IDS`
内的群不禁言新人、不做人机验证和发言检查。其他群默认沿用旧版验证策略，部署前应明确检查这些群的配置。

## AI 审核

配置 `PUBLIC_CHAT_IDS`、`CF_ACCOUNT_ID` 和 `CF_API_TOKEN` 后，将
`MODERATION_MODE` 设为 `observe`，先用真实消息评估误判；确认后可设为
`delete`。管理员和 `OWNER_IDS` 的消息不会自动删除。

只传输待审核的文本/图片说明到 Cloudflare。SQLite
审核表保存文本和分类结果，使用记录目前不自动清理，需根据自己的留存需求管理。模型的
high/low 是自评标签，不是校准的概率。`AI_DAILY_LIMIT` 是账户本进程数据库内每日
UTC 调用次数上限，不保证 Cloudflare 免费 Neurons
额度一定够用；所有模型调用（含失败）都消耗本地次数。配额耗尽时跳过
AI；相同消息未修改时复用已存结果。

## 检查与打包

```sh
deno task check
deno task test
deno task compile
./dist/diobot --version
./dist/diobot --help
```

`dist/diobot` 是当前系统/架构的二进制，包含 Deno 运行时，因此比原 Go
文件大。编译权限为网络、环境变量、读写文件；用独立低权限账号和服务沙箱限制部署访问范围。配置通过环境注入，不会将
`.env` 或密钥嵌入产物。

交叉编译示例：

```sh
deno compile --target aarch64-unknown-linux-gnu --allow-env --allow-net --allow-read --allow-write --include web/index.html --output dist/diobot-linux-arm64 src/main.ts
```

`./dist/diobot --check` 仅验证环境配置，不请求 Telegram，也不创建数据库。

`deploy/diobot-ts.service` 是可审阅的 systemd 示例。部署前创建 `data/` 并确保
`tgnoperm:tgbots` 可写，配置 `.env`，然后停掉旧实例再启用新实例。不要用同一个
bot token 同时运行两个 polling 进程。模板绑定当前项目路径，实际目录不同需调整。

## 测试范围

自动测试覆盖身份签名和重放时效、跨群/用户隔离、重复提交终态、失败次数、重申请、SQLite
重启恢复、审核预算和 HTTP 权限拒绝。真实 Telegram 入群/删除/禁言、Cloudflare
返回值及各客户端 Mini App
行为需要在测试服务器联调；本地测试不会调用这些外部服务。
