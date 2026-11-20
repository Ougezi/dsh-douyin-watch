# dsh-douyin-watch

An autonomous Douyin watch loop as a [DeepSeek Harness](https://github.com/deepseek-ai) plugin: a daily quota, a decayed interest memory and a daily report. Zero runtime dependencies — it drives your own Chrome over CDP.

一个给 DeepSeek Harness 的抖音观看循环插件：每日额度、按遗忘曲线衰减的兴趣记忆、每日日报。**零运行时依赖**，用你本机的 Chrome 走 CDP。

> 它不下载视频、不解码视频、不绕过登录。它做的是：读推荐流卡片、存封面帧、记账、出日报。

## 为什么值得单独做一个

社区里已经有同类插件，但它们的做法通常是再拉一个重型运行时（Playwright / 专用浏览器 / Python）。这个插件的取舍是：

- **零依赖**：只用 Node 22+ 内建的全局 `WebSocket` + `fetch` 直接说 CDP。没有原生模块，升级 DSH / Electron 不会因为 ABI 变化而炸。
- **自己的浏览器档案**：登录态存在插件自己的 `profile/` 里，不读你日常浏览器的 cookie。
- **失败必须可见**：每次拒绝都返回机器可读的 `code` + 人可读的 `hint`。额度拒绝如果静默发生，用户分不清是"到限额了"还是"插件坏了"。
- **改版可诊断**：`dy_diagnose` 把页面此刻的真实状态倒出来，抖音改版时靠它重新校准，不用瞎猜。

## 安装

```bash
dsh plugin add /absolute/path/to/dsh-douyin-watch
```

或在 DSH 里用 Plugin Manager 的 Add plugin 指向这个目录。装好后重载插件行（停用再启用）即可，不必重启 DSH。

## 四个工具

| 工具 | 作用 |
| --- | --- |
| `dy_watch` | 看一轮：滚动、收没看过的卡、截封面、写日志与日报 |
| `dy_status` | 额度、闸门判定、浏览器状态、数据目录、兴趣概要；`closeBrowser=true` 关掉专用窗口 |
| `dy_report` | 生成/读取某天的日报 Markdown |
| `dy_diagnose` | 倒出页面真实状态（卡片数、滚动容器、验证码、登录墙、前几条卡片原文） |

## 额度（四道闸门）

| 闸门 | 默认 | 拒绝码 |
| --- | --- | --- |
| 每日条数 | 40 | `quota-cards` |
| 每日轮数 | 4 | `quota-rounds` |
| 两轮间隔 | 30 分钟 | `cooldown` |
| 允许时段 | 08:00–24:00 | `outside-hours` |

## 记忆：衰减 + 间隔重复

每个话题与作者各一条 `{s, n, last}`：

```
decayed = s × 0.5 ^ (相隔天数 / 14)
s       = min(1, decayed + 0.35 × (1 − decayed))
```

衰减只影响**注入时的显著度**，不影响存档——历史永远留在 `watch-log.jsonl` 里。

## 数据落在哪

```
$DSH_HOME/plugin-data/dsh-douyin-watch/
  quota.json        今日计数
  seen.json         看过就不再看的指纹（上限 5000）
  watch-log.jsonl   追加式观看记录
  interests.json    衰减后的兴趣画像
  covers/<日期>/    每条一张封面 PNG
  reports/<日期>.md 日报
  profile/          专用 Chrome 档案（登录态只存在这里）
```

## 配置

在 bundle patch 的 row `config` 里改：

```yaml
# 浏览器：auto = Chrome 优先、Edge 兜底；edge = 只用 Edge；chrome = 只用 Chrome
browserChannel: auto
chromePath: ""
headless: false

# 观看额度
cardsPerRound: 10
dailyCards: 40
dailyRounds: 4
minIntervalMin: 30
hours: [8, 24]
scrollRounds: 4
scrollStepPx: 700

# 预算（从 journal.jsonl 派生，不各自计数）
dailyMinutes: 30
dailyModelCalls: 120

# 能力开关：关掉的能力不会注册工具，模型根本看不到
enableKb: true
enableOps: false
```

## 浏览器通道：Chrome 与 Edge

两者都是 Chromium，同一套 CDP 命令都通（已在 **Edge 157** 实测：启动、读流、开播放器、抓帧）。

每个通道**各自一个 profile 目录**（`profile-chrome/`、`profile-edge/`），因为 Chrome 里的抖音登录态不会自动出现在 Edge 里。旧的单一 `profile/` 会在首次以 Chrome 运行时一次性迁移为 `profile-chrome/`。

`auto` 通道下 Chrome 优先；想强制用 Edge 就设 `browserChannel: edge`。

## 已知限制（诚实版）

1. **它不播放视频。** 抖音 PC 端只有点开卡片才挂载真正的 `<video>`，推荐流页面本身没有播放器。所以"观看" = 读卡片文案 + 存封面帧。
2. **需要一次手动登录。** 没登录态时返回 `needs-login`，请在插件自己的 Chrome 窗口里扫码。
3. **依赖抖音页面结构。** 卡片靠语义类名后缀匹配、文案靠 token 解析。改版会让它解析不出来——跑 `dy_diagnose` 再校准。
4. **登录弹窗会被自动摘掉。** 那是个 `position:fixed`、`z-index:9999` 的全屏遮罩，不处理会把扫码框拍进封面。插件在截图前把它 `display:none`，顺带让可见卡片数从 10 变成 29。

## 开发

```bash
node scripts/test-parse.mjs      # 解析器回归（不需要浏览器）
node scripts/smoke.mjs --probe   # 只起浏览器探测页面
node scripts/smoke.mjs           # 完整一轮：探测 + 看 2 条 + 出日报
node scripts/verify-install.mjs  # 按 ToolDefinition 契约校验注册
```

`smoke.mjs` 会真的消耗额度，介意的话设 `minIntervalMin: 0` 再用。

## License

MIT
