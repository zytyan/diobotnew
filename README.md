# Diobot

Telegram 群管理工具，TypeScript + grammY + Deno
2。可编译为包含运行时和验证页面的独立二进制，目标机器无需安装 Deno / Node.js。

## 版本与归档

`archive/go-legacy` 保存原 Go 源码，`main` 是 TS 版。原目录没有 Git
仓库，因此归档是新建的源码快照。旧二进制 `diobotnew` 和含部署密钥的本机
`diobot.service` 保留且不提交；新版没有自动替换旧服务。

## 群配置

在群中通过 bot 命令菜单使用 `/settings`。命令按 `all_chat_administrators`
范围注册为原生 `is_ephemeral` 命令；bot 用 `sendRichMessage` +
`ephemeral_message_parameters` 返回仅操作者可见的设置面板，按钮使用 rich message
的原生 buttons 块。点击后用 `editEphemeralMessageText` 更新，没有公开消息回退。

需要支持 ephemeral / rich 消息的 Telegram 客户端及 Bot
API。使用旧客户端手动发送普通文本命令时，bot 无法将已经发出的普通消息变成
ephemeral；应从支持此能力的客户端菜单发送命令。匿名管理员须切换为个人身份，bot
无法从匿名发送身份确认其实际管理员权限。

每次打开和点击面板都会查询本群实时管理员身份；按钮绑定操作者、群和设置版本，过期面板会刷新，不会反复翻转开关。配置立即保存到
SQLite，重启后保留。

可配置项：

| 项目         | 行为                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| 入群人机验证 | 开启后，申请入群私信验证；普通邀请链接入群先禁言后验证。直接拉人不验证。 |
| AI 广告审核  | 关闭 → 仅观察 → 自动删除，循环切换；和入群验证独立配置。                 |
| 欢迎消息     | 独立开关。                                                               |
| 被封禁消息   | 独立开关。                                                               |
| 离开消息     | 独立开关。                                                               |
| 砍树提示     | 永久封禁成员后，私密提示管理员处理其直接邀请的在群成员。                 |

**没有发言检查**。验证通过后直接完成，不要求新人发消息；升级时旧的发言任务自动标记完成。

初次观察到一个群时，`PUBLIC_CHAT_IDS` 和 `MODERATION_MODE`
仅用来初始化默认值。已有群始终以数据库配置为准。无 Turnstile
配置时，初始入群验证关闭；有完整配置时，默认在未列入 `PUBLIC_CHAT_IDS`
的群开启。欢迎、被封禁、离开消息和砍树提示默认开启。

关闭入群验证后，未完成申请交由后台批准，待验证的已入群成员恢复原先保存的群默认权限。该开关不会解封此前已经被封禁的账号。

## 邀请追踪与砍树

bot
根据成员变更事件记录“谁直接拉了谁”，按群隔离，退群或自行重新加入后更新关系。只能记录本版本运行后观察到的事件，不能恢复历史上未记录的邀请。

成员被人类管理员**永久封禁**时，bot 给执行封禁的管理员发送 ephemeral rich
提示。临时封禁不触发，bot 自己执行的批量封禁也不会再次触发。

流程：查看名单 → 确认封禁 →
后台执行。预览时冻结名单，不把后来加入的人混入已经确认的操作。只处理当前仍由该成员直接拉入的成员，不递归处理下一层；跳过群主、管理员、已离群成员和
bot 自己。

管理员也可在群里使用 ephemeral 命令 `/tree 用户ID`
重新打开操作。需要当前具有封禁成员权限；原成员必须仍处于永久封禁状态。任务保存到
SQLite，重启可继续；执行时再次检查权限、群设置、原成员封禁状态和目标成员身份。可通过面板查看进度。按钮操作绑定发起管理员和本群，确认窗口十分钟，重复点击不会重复创建任务。

## 其他功能

- 欢迎、退群、临时/永久封禁通知。
- 六分钟入群验证期限，最多三次失败。失败：尚未入群则拒绝申请，已经入群则永久封禁，需要管理员解除才能再次加入。
- 专属验证链接绑定本人、本群、本次申请；新申请淘汰旧链接。校验 Telegram
  签名和有效期，以及 Turnstile 域名、action、cdata。
- SQLite
  保存申请、群配置、邀请关系、砍树任务、群活动和审核结果；未完成申请重启后继续处理。
- 私聊 `/stats`：仅 `OWNER_IDS` 可用，查看新版已经观察到的群、最近活动和 bot
  状态；不能列出 Telegram 上历史全部群。
- 同群的消息和后台任务按顺序处理，不同群可并发。
- `GET /healthz` 仅检查 HTTP 进程存活，不代表 Telegram / Cloudflare 正常。

## 开发和配置

需要 Deno 2.2+，本项目在 Deno 2.9.3 验证。

```sh
cp .env.example .env
chmod 600 .env
# 编辑 .env，填入独立测试 bot token
deno task dev
```

Turnstile 配置可以全部省略，仅运行群设置 / AI
审核；要开启入群验证须提供三项完整配置，正式环境禁止使用自动放行的测试 key。

`TELEGRAM_ENV=test` 使用 Telegram 测试环境自己的 BotFather token。HTTP 默认绑定
`127.0.0.1:8532`，公网由反向代理提供 HTTPS。验证页在 BotFather 配置为 Main Mini
App，URL 指向 `/`。`VERIFY_HOSTNAME` 填网页域名，不含协议或端口。

bot 须为群管理员，具备审批邀请、限制/封禁成员和删除消息权限。应用配置不会授予
bot Telegram 管理员权限。

## AI 审核

配置 `CF_ACCOUNT_ID` 和
`CF_API_TOKEN`，然后在群面板开启“仅观察”，评估实际消息后再切换自动删除。审核适用于任何开启此功能的群，与入群验证独立。

审核新消息及编辑消息的文本和媒体说明，默认
Qwen3；没有图片像素识别、OCR、语音识别或聊天上下文。管理员的消息不会自动删除，`OWNER_IDS`
的消息直接跳过。

模型返回正常、广告、诈骗或不确定及 high/low
自评标签（不是校准概率）。仅在自动删除模式下删除 high
的广告或诈骗，不自动禁言或封号。API 故障、异常结果和额度耗尽时保留消息。

`AI_DAILY_LIMIT` 为本数据库每天 UTC 的请求次数上限，不等同于 Cloudflare Neurons
额度；失败调用也计数。未改变的同一条消息复用已存结果。文本会发送到
Cloudflare，并连同分类保存在本地审核表；目前不自动清理。

## 检查与二进制

```sh
deno task check
deno task test
deno task compile
./dist/diobot --version
./dist/diobot --help
```

`dist/diobot` 包含 Deno 运行时和验证页面。当前 Linux x64 产物约 107
MB。密钥通过进程环境提供，不会嵌入产物。开发启动任务读取 `.env`，独立二进制由
systemd 的 `EnvironmentFile` 加载配置。`--check` 只验证配置，不连接 Telegram。

`deploy/diobot-ts.service` 是尚未安装的服务模板。部署前创建 `data/` 并确保
`tgnoperm:tgbots` 可写，准备 `.env`。切换时先停旧实例，同一 token
不能同时运行两个 polling 进程。

## 实际 API 测试工具

`tools/` 使用独立配置和依赖锁文件，MTProto 账号客户端不进入生产 bot
二进制。应用凭据 `.env.telegram` 和账号 session / 测试 bot token 均被 Git
忽略，凭据文件权限为 0600。

登录工具只登录、不发送消息；手机号与验证码不写入源码。测试环境和正式环境分别存放
session，必须显式指定环境。

```sh
deno run --no-prompt --config tools/deno.json --env-file=.env.telegram --allow-env --allow-sys --allow-net --allow-read --allow-write tools/telegram_login.ts --environment test --alias account-name --phone +123456789
```

以下联调工具仅用于已授权的测试账号：`test_fixture.ts` 创建专用测试 bot
和隔离群，`integration_test.ts` 查询服务端 testMode 后测试原生 ephemeral
命令/面板、面板编辑、通知开关、真实直接邀请和无发言任务。不会使用正式 bot token
或正式群。需先登录工具约定的两个测试账号别名。运行时也必须传入上面相同的
config、env-file 和权限参数。

本地自动测试覆盖身份签名、状态隔离、设置权限与失效按钮、通知开关、砍树确认与冻结名单、跳过管理员、不递归、撤权/解封取消、SQLite
重启恢复和旧发言任务迁移。真实按钮点击与客户端展示仍需支持新 API
的客户端检查；联调脚本通过 Bot API 返回值验证消息为 ephemeral rich。

完成夹具初始化和编译后，可运行 `deno task test:serve`
启动独立测试实例（127.0.0.1:18532，单独 manual.sqlite），在测试群内操作
`/settings` 面板。Ctrl+C 退出；不要与 `test:telegram`
同时运行，二者使用同一个测试 bot token。
