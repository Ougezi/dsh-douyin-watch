# 抖音观看循环

一个**我自己用**的插件：在每日额度内自己刷抖音推荐流，把看过的东西记进一个有衰减曲线的兴趣画像，最后每天出一份日报。额度、去重和画像全部落在本地。

## 它到底做什么

一轮观看 = 打开推荐流 → 滚动触发加载 → 收集**没看过**的视频卡片 → 逐张记录（标题 / 作者 / 时长 / 点赞 / 话题 / 相对时间）→ 把卡片**封面截一张图**存下来 → 写进 `watch-log.jsonl` → 更新兴趣画像 → 刷新当天日报。

四道额度闸门，任何一道不过都会**明确拒绝并给出下一步**：

| 闸门 | 默认 | 拒绝码 |
| --- | --- | --- |
| 每日条数 | 40 | `quota-cards` |
| 每日轮数 | 4 | `quota-rounds` |
| 两次间隔 | 30 分钟 | `cooldown` |
| 允许时段 | 08:00–24:00 | `outside-hours` |
| 每日打开视频总时长 | 180 分钟 | `quota-minutes` |
| 每日模型调用 | 120 次 | `quota-model-calls` |

## 工具

**A 自主观看（`dy_*`）**

- `dy_watch` — 看一轮。`mode: cards`（默认）只读卡片与封面，零模型成本；`mode: play` 打开播放器、记录时长并抓一帧（每帧记 1 次模型调用预算）。可选 `cards` 指定本轮条数。
- `dy_status` — 额度、预算、三层开关、浏览器通道与状态、近期事件、兴趣概要；`closeBrowser: true` 关掉专用窗口
- `dy_report` — 生成并返回某天的日报 Markdown + 文件路径
- `dy_diagnose` — 把页面此刻的真实状态倒出来（卡片数、滚动容器、验证码、登录墙、通道、前几条卡片原文）
- `dy_login` — 打开插件自己的浏览器并报告登录状态（只检查、不代替输入、不绕验证码）；未登录时按它给的 hint 扫码即可

**C 只读知识源（`kb_*`，默认开启）**

- `kb_hot` — 热榜，匿名可用；`limit` 超过首屏会自动滚动补页（最多 4 次）
- `kb_video` — 打开视频播放器，读时长/元数据并抓一帧；`modalId` 接受纯数字、`?modal_id=` 地址或 `/video/<id>` 分享链接
- `kb_search` — 搜索；未登录 `needs-login`，上游 50x `upstream-error`，改版 `no-results`，参数不合法 `invalid-argument`
- `kb_save` — 把当天采集内容落成 Markdown

**B 运营（`ops_*`，默认关闭）**

- `ops_status` — 账号是否登录、写开关状态、今日写预算
- `ops_trend` — 创作者中心可达性（未登录返回 `needs-login`）

> **写操作（点赞/评论/回复/私信/发布）没有实现。** Spike 显示它们全部需要登录，且未登录时点任何互动只弹通用登录框。闸门已在 `policy.assertWriteAllowed()` 就绪并有测试覆盖；实现前需要账号本人登录并单独验收。这里不发布未经验证的写操作代码。

## 记忆怎么衰减

每个话题与作者各有一条记录 `{s, n, last}`：

- 每次再遇到：`s ← min(1, decayed + 0.35 × (1 − decayed))`，`n += 1`
- 衰减：`decayed = s × 0.5 ^ (相隔天数 / 14)`

也就是**艾宾浩斯式的遗忘 + 间隔重复的活化**：常出现的兴趣会更牢，久不出现的会自己淡下去，但不会消失——历史记录留在 `watch-log.jsonl` 里。

## 数据落在哪

```
$DSH_HOME/plugin-data/dsh-douyin-watch/
  quota.json       今天的计数
  seen.json        看过就不再看（上限 5000 条）
  watch-log.jsonl  每条观看记录的追加日志
  interests.json   衰减后的兴趣画像
  covers/<日期>/   每条的封面 PNG
  reports/<日期>.md
  profile/         专用 Chrome 档案（登录态只存在这里）
```

## 必须先知道的三件事

1. **它不播放视频。** 抖音 PC 端只有点开卡片才会挂载真正的 `<video>`；推荐流页面本身没有播放器。所以"观看"在这里的准确定义是：**读到卡片文案 + 存下封面帧**。它不会声称自己解码了视频。
2. **需要一次手动登录。** 第一次跑如果没有登录态，会返回 `needs-login` 并让你在它自己的 Chrome 窗口里扫码。登录态只写进这个插件自己的 `profile/`，不读你日常浏览器的 cookie。
3. **它依赖抖音的页面结构。** 卡片靠语义类名后缀匹配、文案靠 token 解析。抖音改版可能让它一条都解析不出来——那时跑 `dy_diagnose` 看真实结构，再校准解析器。这是本插件最脆的一环，也是我把它做成一等工具的原因。

## 两个实测出来的细节

- **登录弹窗会被自动摘掉。** 抖音会在推荐流上盖一个 `position: fixed`、`z-index: 9999` 的**全屏遮罩**（面板只是它的子元素，面板自己是 `position: static`）。不处理的话，封面截图会把扫码框一起拍进去。插件在每轮取封面之前会把这个遮罩 `display: none` 掉——实测卡片数会从 10 直接变成 29，因为被挡住的部分终于可读了。
- **推广位会被丢掉。** 卡片文本里没有任何视频信号（无时长、无作者、无话题）的，比如"下载 APP"横幅，会被解析器判为非视频并跳过，不会污染日报。


## 配置

在 `cordis.patch.yml` 的 row `config` 里改：

```yaml
browserChannel: auto  # auto=Chrome 优先、Edge 兜底；edge/chrome 强制单通道
chromePath: ""        # 留空自动找；指定后优先于通道
headless: false       # true 则不开窗口（登录时必须是 false）

cardsPerRound: 10     # 单轮上限
dailyCards: 40        # 每日条数上限
dailyRounds: 4        # 每日轮数上限
minIntervalMin: 30    # 两轮最小间隔（分钟）
hours: [8, 24]        # 允许观看的本地时段
scrollRounds: 4       # 每轮滚动几次触发加载
scrollStepPx: 700     # 每次滚动多少像素

dailyMinutes: 180     # 每日「打开的视频总时长」预算（从 journal 派生）
dailyModelCalls: 120  # 每日模型调用预算（真实成本闸门）

enableKb: true        # C 层只读知识源（M1 起有工具）
enableOps: false      # B 层写操作；关掉时 ops_* 根本不注册
```

## 通道与 profile

Chrome 与 Edge 都是 Chromium，共用同一套 CDP 命令（Edge 157 已实测）。两者**各自一个 profile 目录**：

```
profile-chrome/   profile-edge/
```

原因很实在：你在 Chrome 里扫码登录过抖音，Edge 那边不会自动有。旧的单一 `profile/` 会在首次以 Chrome 运行时**一次性迁移**成 `profile-chrome/`（迁移失败不致命，会继续用旧目录并记日志）。

