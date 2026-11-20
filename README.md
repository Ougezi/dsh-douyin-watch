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
| `dy_watch` | 看一轮。`mode: cards` 只读卡片与封面（**零模型成本**）；`mode: play` 打开播放器、记录时长并抓一帧 |
| `dy_status` | 额度、预算、三层开关、浏览器通道与状态、近期事件、兴趣概要；`closeBrowser=true` 关掉专用窗口 |
| `dy_report` | 生成/读取某天的日报 Markdown |
| `dy_diagnose` | 倒出页面真实状态（卡片数、滚动容器、验证码、登录墙、通道、前几条卡片原文） |
| `dy_login` | 打开插件自己的浏览器并报告登录状态；未登录时引导你扫码（不代替输入、不绕验证码） |
| `kb_hot` | 读抖音热榜（**匿名可用**），落进本地知识库 |
| `kb_video` | 打开某条视频的播放器，读时长/元数据并抓一帧；可用 `modalId` 直接重开 |
| `kb_search` | 搜索关键词；未登录时明确返回 `needs-login` |
| `kb_save` | 把当天采集的热榜/视频/搜索落成 Markdown |
| `ops_status` / `ops_trend` | **只读**运营探测：账号是否登录、创作者中心可达性。写操作未实现（见下） |

## 额度与预算（四道闸门 + 两道预算）

| 闸门 | 默认 | 拒绝码 |
| --- | --- | --- |
| 每日条数 | 40 | `quota-cards` |
| 每日轮数 | 4 | `quota-rounds` |
| 两轮间隔 | 30 分钟 | `cooldown` |
| 允许时段 | 08:00–24:00 | `outside-hours` |
| 每日「打开的视频总时长」 | 180 分钟 | `quota-minutes` |
| 每日模型调用 | 120 次 | `quota-model-calls` |

后两道从 `journal.jsonl` 派生，只在 `mode: play` 下消耗：每抓一帧记 1 次模型调用，
每打开一条视频按它的时长计入分钟预算（**不是**墙钟时间——我们是 seek 后暂停，不假装看完了）。

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
  journal.jsonl     三层统一事件流（预算与日报的派生源）
  knowledge.jsonl   只读层采集到的热榜/视频/搜索条目
  interests.json    衰减后的兴趣画像
  covers/<日期>/    每条一张封面 PNG
  frames/<日期>/    play 模式抓到的视频帧
  knowledge/<日期>.md  kb_save 的落盘
  reports/<日期>.md 日报
  profile-chrome/   各浏览器通道各自的档案（登录态只存在这里）
  profile-edge/
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
dailyMinutes: 180
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

1. **`cards` 模式不播放视频。** 推荐流页面本身没有播放器，只有点开卡片才挂载 `<video>`。所以 `cards` 的"观看" = 读卡片文案 + 存封面帧；要真播放用 `mode: play`。
2. **`play` 模式会抓一帧，但不代表"看懂了"。** 帧存盘并返回路径（`frameSuspect` 会标出疑似黑帧/海报图）。要不要把帧交给模型，由调用方决定，费用也由那次调用产生。
3. **搜索需要登录。** 抖音未登录时 `/search/<kw>` 只有登录墙，`kb_search` 会返回 `needs-login` 而不是空列表。
4. **评论需要登录，因此写操作未实现。** Spike 显示点任何互动只弹通用登录框、评论 DOM 为 0。`ops` 层目前只有只读的 `ops_status` / `ops_trend`；点赞、评论、回复、私信、发布的闸门（`policy.assertWriteAllowed`）已就绪并有测试，但**没有发布未经验证的写操作代码**。
5. **依赖抖音页面结构。** 卡片靠语义类名后缀匹配、文案靠 token 解析。改版会让它解析不出来——跑 `dy_diagnose` 再校准。
6. **登录弹窗会被自动摘掉。** 那是个 `position:fixed`、`z-index:9999` 的全屏遮罩，不处理会把扫码框拍进封面。插件在截图前把它 `display:none`，顺带让可见卡片数从 10 变成 29。
7. **播放器有首次使用引导浮层**（"我知道了"），不摘掉会把引导拍成"帧"。

## 开发

```bash
node scripts/test-parse.mjs         # 解析器回归（不需要浏览器）
node scripts/verify-install.mjs     # ToolDefinition 契约校验
node scripts/smoke-channel.mjs edge # 通道与诊断（edge/chrome）
node scripts/smoke.mjs              # cards 模式完整一轮
node scripts/smoke-kb.mjs edge      # 知识源：热榜/视频+帧/搜索/落盘
node scripts/smoke-play.mjs edge    # play 模式：真播放+抓帧+双预算
node scripts/smoke-ops.mjs edge     # 运营层：只读工具与写闸门
node scripts/smoke-failures.mjs edge# 失败路径：code+hint 契约
node scripts/spike*.mjs             # 页面结构探针（改版后校准用）
```

这些冒烟会真的起浏览器、真的消耗额度——建议配临时 `DSH_HOME` 跑，别动真实账本：
`$env:DSH_HOME = "$env:TEMP\dy-test"`。

## 成本

- `cards` 模式与日报：**0 模型调用**。
- `play` 模式：每条抓一帧算 1 次（`dailyModelCalls` 管住）。
- 只读层（`kb_*`）：只处理文本与本地文件，**0 模型调用**。

## License

MIT
