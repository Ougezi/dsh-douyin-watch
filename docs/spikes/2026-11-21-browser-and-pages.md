# Spike 记录 — 浏览器通道与三类页面（2026-11-21）

> 目的：在写生产代码前，用可复现的探针回答「Edge 能不能用」「播放器怎么打开」「搜索/热榜是否需要登录」。
> 脚本：`scripts/spike.mjs`（通道 + 播放器 + 搜索 + 热榜）、`scripts/spike2.mjs`（点击策略 + 页面正文）。

## 1. Edge 兼容性 —— 通过

| 项 | 结果 |
| --- | --- |
| 可执行文件 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（157.0.4341.60） |
| 用本插件零依赖 CDP 引擎启动 | **865 ms** |
| 读推荐流卡片 | 20 张，探测字段完整 |
| 打开播放器 / 抓帧 | 与 Chrome 一致 |

结论：Edge 是 Chromium，同一套 `Page.* / Runtime.* / Input.*` 命令全通，**只需加"通道选择"，不必换引擎**。

## 2. 播放器（A 层真播放）—— 关键发现

| 尝试 | 结果 |
| --- | --- |
| `Input.dispatchMouseEvent` 在卡片中心按下+抬起 | ❌ `videoCount = 0`，URL 不变 |
| 页面内 `element.click()`（合成点击） | ✅ URL 变为 `https://www.douyin.com/jingxuan?modal_id=7689371847216893193`，`videoCount = 2`，`<video>.readyState = 4`，`duration = 444.17s` |

**两个可复用结论**：

1. 卡片要用**合成点击**打开，物理鼠标事件无效（站点把 handler 绑在合成 click 上）。
2. `modal_id` 是**稳定的视频标识**，天然适合做 `kb_video` 的入参与日志主键。

**尚未验证**：模态内 `Page.captureScreenshot` 是否黑屏（`captureFrame()` 已内置 `< 20KB 判疑似黑屏` 的启发式，需在 M2 用连抓 5 帧来定论）。

## 3. 热榜 —— 匿名可用，且与卡片同构

`https://www.douyin.com/hot` 正文（节选）：

```
热点视频
02:44 1805 河蚌肉太鲜了…#广德炖锅 #我家的小土狗 … @皖南乔哥 · 3天前
00:36 2005 娱乐榜：许飞四十岁活法激励女性 132.3万人在看 … @甜心豌豆 · 4天前
```

与推荐流卡片同构（时长 / 点赞 / 标题 / 话题 / 作者 · 相对日期），**可直接复用 `parseCard()`**。

探测方法：页面上「innerText 以 `HH:MM` 开头且长度 < 400」的元素即条目容器，去重后解析。

## 4. 搜索 —— 被登录墙挡住

两种 URL 形态（`/search/<kw>` 与 `/search/<kw>?type=video`）都只渲染出：

```
综合 视频 用户 直播 多列 单列 筛选
登录后即可搜索更多精彩视频
扫码登录 / 验证码登录 / 密码登录
```

`videos = 0`，正文约 638 字符（基本是页脚）。

结论：**`kb_search` 必须实现 `needs-login` 分支**，并在文档里写明"搜索需要先登录"。检测特征用正文包含 `登录后即可搜索`。

## 5. 失败模式清单（供适配器实现）

| 现象 | 判定 | 上报 |
| --- | --- | --- |
| 卡片存在但点开无 `modal_id` | `player-not-opened` | 附卡片文本 + 截图路径 |
| `modal_id` 在但 `<video>` 未就绪 | 等待 `readyState>=2 && currentTime>0`，超时则 `video-not-ready` | 不声称已解码 |
| 截图 < 20KB | 疑似黑屏 | 重试一次，仍小则 `frameSuspect: true` |
| 正文含 `登录后即可搜索` | 登录墙 | `needs-login` + 扫码提示 |
| `/hot` 无可解析条目 | 改版或空页 | `no-items` + 建议跑 `dy_diagnose` |
