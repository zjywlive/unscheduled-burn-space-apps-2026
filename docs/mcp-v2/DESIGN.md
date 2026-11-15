# Lunar Site Navigator MCP v2 设计

2026-11-15 · 状态：设计稿，待拍板（见 §14）· 原型：`docs/mcp-v2/proto/`

## 0. 结论

v1 MCP（`mcp/server.mjs`，13 个工具）只能回答"这个点、这个日期怎么样"。用户真正会问的三类问题，它都接不住：

| 典型请求 | v1 缺什么 |
|---|---|
| "帮我筛选一个平坦、日照和地球均持续可见 300 小时以上、离永久阴影区近、可能有水冰的着陆点以及路径" | 空间搜索；"连续"时长指标；水冰数据；从着陆点到科学目标的路径 |
| "把我任务规划的 xx 点和 xx 点的光照、地球可见性列出来" | 读不到用户的任务计划（它存在浏览器 localStorage 里）；航点没有名字；不知道巡视器什么时候到那个点 |
| "帮我筛选即使任务推迟 7 天也均可用的着陆点" | 推迟扫描（每个推迟量都检查一遍、取最差）；"可用"没有定义；条件矛盾时不会解释 |

v2 的核心是三件事：

1. **一套共用的约束语言 `criteria`**：搜索、推迟检查、窗口查询、任务检查都用它。每条约束都返回实际值、余量，以及卡住的是哪一条。
2. **三组新工具**：发现（`find_landing_sites`、`check_slip_robustness`、`landing_windows`）、任务（`mission_open`、`mission_conditions`、`mission_check`）、解释（`explain`），再把路径工具升级成 `plan_traverse`。
3. **不可行也是一种结果**：条件互相矛盾时，返回卡在哪、可行的最大值是多少，以及放宽哪一条能多出几个候选。

原型实测（§11）：2 km 网格上，第一个请求的完整筛选（坡度、PSR 距离、连续日地同见、7 天推迟扫描）**0.3–0.6 秒**就能算完，现有数据就够。同时，严格口径下第一个和第三个请求合在一起**在物理上不可行**：从着陆起算，每推迟 1 小时，连续窗口就少 1 小时，所以要扛住 7 天推迟，需要 ≥ 468 h 的连续窗口，而区域内最长只有 401 h。这正是 MCP 应该替规划者讲清楚的事。

## 1. 现状

- **v1 工具**：`list_sites`、`site_summary`、`compare_scenarios`、`rise_set_events`、`next_events`、`sky_at`、`skyline`、`best_landing_dates`、`point_facts`、`energy_summary`、`relay_coverage`、`route_candidates`、`open_in_navigator`。
- **实现**：计算全部在 `demo/src/tools-core.js`（页面"Ask"助手和 MCP 共用一个注册表），Node 端由 `tools/core-context.mjs` 加载数据，`mcp/server.mjs` 只是协议外壳（MCP 2025-11-25，stdio，零依赖）。结果里已有 `structuredContent` 和 `readOnlyHint` 注解。
- **没有的**：prompts、resources、进度通知、跨调用引用（每次都得重新传坐标）、空间搜索、连续时长、推迟扫描、水冰、任务计划读取、"为什么"解释。
- **可直接复用的纯函数**（都能在 Node 里跑）：`heat.js`（2 km / 1 km 天际线网格上的逐格日地可见）、`windows.js`（单点 15 分钟扫描）、`score.js`、`psr.js`、`nasa-avg.js`、`route-plan.js`（方向坡度限制、单行段、陷阱、`reachFrom`）、`route-energy.js`、`comms.js`、`contingency.js`、`mission-save.js`、`mission-config.js`（`goNoGoRows`）、`stories.js`、`agent/system-prompt.js`（已有 planner / educator / public 三种语气）。

## 2. 先对齐定义（语义层）

用户说的话很口语，工具必须把每个词落到可计算的定义上，并把用到的定义原样回显（`query_echo` + `assumed`），这样助手才能说出"我把'平坦'理解为 2 km 平均坡度 ≤ 5°"。

| 用户说法 | 精确定义（默认值） | 参数 | 数据与分辨率 |
|---|---|---|---|
| 可见 | 太阳（或地球）**中心**高于当地地形天际线，观察者离地 2 m；地球含视差 | — | LOLA 天际线：筛选用 2 km / 1 km 网格，精算用单点 480 m DEM |
| 持续可见 N 小时 | 太阳和地球**同时**可见、中间不断开的最长时段 | `both_continuous_h_min`、`sun_continuous_h_min`、`earth_continuous_h_min` | 筛选 1 h 采样，精算 15 min |
| 从什么时候起算 | **默认 `from_landing`**：触地时日地都在、并持续 ≥ N h（着陆器一落地就要电和通信）。可选 `within_stay`：驻留期内任意一段 ≥ N h 即可；`from_time`：从指定时刻（如巡视器到达）起算 | `continuous_from` | — |
| 平坦 | 2 km 格平均坡度 ≤ 5°（筛选）；精算报告 240 m 节点坡度；着陆区精细坡度只在已有 5–20 m 精细地块的地点给出 | `slope_max_deg`、`slope_scale` | `slope_2km` / `slope_1km` / `dem_240m` / hires |
| 离永久阴影区近 | 着陆点**在 PSR 外**，到最近面积 ≥ 1 km² 的 PSR 斑块的距离 ≤ 5 km | `psr_distance_km: {min, max}` | Mazarico 等 PSR，120 m |
| 可能有水冰 | **热稳定**，不是探测到冰：冰面稳定（冰台深度 = 0），或浅层稳定（冰台深度 ≤ 1 m，钻机够得着）。约束作用在着陆点附近、巡视器开得到的**目标**上，不作用在着陆点本身（着陆点要见光） | `ice: {class: surface\|shallow\|any, within_km, depth_max_m}` | Diviner，Schorghofer & Williams 2020，240 m（§10，需核实后接入）；接入前退回"PSR 内"代理，并明确标注 |
| 推迟 N 天也可用 | 着陆时刻在 [L, L+N 天] 内，**每 6 h 取一个**，每个都满足全部约束；报告最差值、第一次不满足的推迟量和原因 | `slip: {from_days, to_days, step_h}` | — |
| 可用（没说具体条件时） | 预设 `lander_dte`：触地时日地都在；从着陆起日地同见 ≥ 72 h；驻留期最长黑夜 ≤ 电池可撑小时数（假设值，默认 24 h）；坡度 ≤ 8° | `preset` | 电池、负载都是**假设** |

两条硬规则：
- 任何不是数据而是假设的量（电池、面板、负载、坡度上限、中继轨道、钻深），一律放进 `assumed[]`，助手回答时必须点名。
- 搜索区域默认只用声明的覆盖范围（80°S 到极点）。原型发现，网格四角（75–79°S）的天际线会被 DEM 边界截断，会系统性地高估可见时长，见 §11。

## 3. 三类人群的使用需求

题面原话："lets mission planners, educators, and the public compare landing sites and dates quickly"。三类人用的是同一套工具，区别在入口、细节量和语气：

| | 任务规划者 | 教育者 | 公众 |
|---|---|---|---|
| 主要入口 | 自己的助手（Claude Code / Desktop / opencode）里的 MCP，旁边就是自己的材料（推迟通知、电池规格） | Claude Desktop 里的 MCP 备课 + 课堂上打开网页 | 网页里的"Ask"助手（同一注册表，浏览器内运行）；可选托管版 MCP（P2） |
| 默认细节 | `standard` / `full` | `standard` | `brief`（≤ 1 KB） |
| 语气来源 | MCP prompt `planner`（沿用 `system-prompt.js` 的 AUDIENCES） | prompt `educator` | prompt `public` |
| 最看重 | 数字准、可复现、假设标明、批量、快 | 物理对、分级讲解、答案能用数据复算 | 零门槛、直观、有画面感、不堆术语 |

### 3.1 任务规划者（CLPS 载荷/任务团队、科学与工程协调）

**要完成的工作**

| # | 工作 | 典型说法 | 工具链 |
|---|---|---|---|
| P1 | 选址初筛：同时满足工程约束（坡度、光照、直连地球、黑夜 ≤ 电池）和科学约束（近 PSR、有冰） | "帮我筛选一个平坦、日照和地球均持续可见 300 小时以上、离永久阴影区近、可能有水冰的着陆点以及路径" | `find_landing_sites` → `plan_traverse` → `open_in_navigator` |
| P2 | 应对推迟：已定的点和日期变了怎么办 | "发射推迟到 1 月 27 日，IM-2 还能用吗？不能的话同一地区有什么替代？" | `compare_scenarios` → `landing_windows` → `find_landing_sites(region=附近)` |
| P3 | 事前做稳：选推迟也扛得住的点 | "帮我筛选即使任务推迟 7 天也均可用的着陆点" | `check_slip_robustness`（已知点）或 `find_landing_sites(slip)`（全区） |
| P4 | 核对自己的计划：航点在巡视器到达时的光照、通信 | "把我任务规划的 W2 和 W4 的光照、地球可见性列出来" | `mission_open` → `mission_conditions` |
| P5 | 放行检查和推迟假设 | "这个任务推迟 3 天，哪些 go/no-go 会变红？" | `mission_check(slip)` |
| P6 | 巡视路径：着陆点 → 冷阱 → 返回，看能量、通信、避险点 | "从着陆点到最近的冷阱往返，什么时候出发最好？路上哪段失联？" | `plan_traverse(to={nearest:"ice"}, return=true, depart="best")` |
| P7 | 电池约束倒推日期 | "电池只能撑 30 小时黑夜，沙克尔顿脊哪些日期着陆是安全的？" | `landing_windows(criteria={longest_dark_h_max:30})` |
| P8 | 跨团队沟通：给科学团队一张表、一个链接 | "把这 5 个候选做成表发给科学组，附地图链接" | `find_landing_sites` 结果 → resource `lsn://search/{id}.csv` + `open_in_navigator(pins)` |

**功能需求**
- 区域搜索支持：整个极区、某地点周围 R km、经纬度框、多边形、"我任务的着陆点附近"。
- 日期支持：单个着陆时刻、着陆窗口（从…到…），以及"不定日期"（每个候选给出最好的着陆日期）。
- 每条约束都给出实际值和余量；候选数为零时给出卡点和放宽建议。
- 筛选值和精算值分开报告（2 km 网格 vs 单点 15 min），差异要能看到。
- 结果可以引用（`S1`、`W2`、`route R1`），后续追问不用再传坐标。
- 能导出 CSV / GeoJSON，能一键在页面上看到。

**非功能需求**
- 典型查询 < 5 s，全区不定日期搜索 < 20 s，超时返回部分结果并标明。
- 同样的输入得到同样的输出；`about` 里写数据版本和分辨率。
- 只读，不联网，不写用户文件。
- 明确声明"首轮筛查，不是认证级着陆分析"。

### 3.2 教育者（中学/大学教师、天文馆、科普工作者）

| # | 工作 | 典型说法 | 工具链 |
|---|---|---|---|
| E1 | 备一节有真实数据的课，带答案 | "给高一学生设计一节 40 分钟的课：为什么月球南极的太阳永远很低，用真实数据，带答案" | prompt `build_lesson` → `explain` + `sky_at` + `classroom_activity`（P2） |
| E2 | 找一组反差强烈的例子课堂演示 | "找两个相距不到 5 公里、光照却完全不同的地方" | `find_landing_sites(rank_by=contrast)` 或 `explain(topic=contrast)` → `open_in_navigator(persona=educator)` |
| E3 | 讲清一个现象的成因 | "为什么在月球南极地球会'落下'？用学生能懂的话，配一个能打开的页面" | `explain(topic=why_earth_sets)` → `open_in_navigator(playhead=地落时刻)` |
| E4 | 出题，答案要能复算 | "出 5 道选择题比较 Apollo 11 和沙克尔顿的日照，答案用工具算" | `compare_scenarios` → 题目里写明每个答案来自哪次调用 |
| E5 | 纠正误解 | "学生问月球背面是不是永远黑的，帮我用数据回答" | `explain(topic=misconception, claim=…)` |

**需求要点**
- 物理正确优先于有趣；每个结论都能追溯到一次工具调用和它的输入。
- 输出要区分**某一时刻**、**一次驻留**和**18.6 年长期平均**，这是学生最容易混淆的三个概念。
- 比喻里的数字也要算出来，例如"太阳最高 1.5°，大约相当于地球赤道上日出后 6 分钟的太阳高度"，不能凭感觉写。
- 课堂要离线能用、不需要 API key，所以页面链接是第一交付物。
- 可打印（Markdown 讲义），可复用（同一活动换个地点重算）。

### 3.3 公众（太空爱好者、关注 Artemis/CLPS 新闻的人、学生）

| # | 工作 | 典型说法 | 工具链 |
|---|---|---|---|
| U1 | 身临其境：站在那里能看到什么 | "如果我现在站在沙克尔顿陨石坑边上，抬头能看到什么？" | prompt `virtual_visit` → `sky_at` + `skyline` + `explain(brief)` |
| U2 | 跟新闻：某个任务为什么那样 | "IM-2 为什么那么快就没电了？" | `site_summary(im2)` + `explain(why_dark)` |
| U3 | 好奇的搜索 | "月球上哪里这个月太阳一直不落山？" | `find_landing_sites(preset=sun_never_sets, detail=brief)` |
| U4 | 什么时候 | "下一次从沙克尔顿看到地球升起是什么时候？" | `next_events` |
| U5 | 和地球对比 | "月球上的一天有多长？太阳有多高？" | `explain(topic=earth_analogy)` |
| U6 | 玩一把 | "带我规划一次我自己的月球南极任务" | prompt `my_first_mission`：选址 → 定日期 → 看推迟 → 打开页面 |

**需求要点**
- 回答短、先给画面再给数字，最多三个数字，单位口语化（"14 天"而不是"336 h"）。
- 不确定性要说成人话（"这是用 2 公里的地形格子估的"），但不能省略。
- 每个回答都附一个能直接打开的页面链接，画面比文字有说服力。

## 4. 总体架构

```
                ┌──────────────── demo/src/tools-core.js (one registry, v2) ────────────────┐
  front-ends    │ discover        inspect (v1+)      engineering    traverse     mission      │
  ─────────     │ find_landing_   site_summary       energy_        plan_        mission_open │
  MCP stdio  ──▶│ sites           compare_scenarios  summary        traverse     mission_     │
  (mcp/)        │ check_slip_     sky_at/next_events relay_                      conditions   │
  page "Ask" ──▶│ robustness      rise_set/skyline   coverage                    mission_check│
  tests      ──▶│ landing_windows point_facts(+ice)               explain   open_in_navigator│
                └───────┬──────────────────────────────────────────────────────────┬────────┘
                        │ new pure modules                                         │ refs store
                 criteria.js  search.js  ice.js  mission-io.js  explain.js           │ (search_id,
                        │                                                          │  mission_id,
                 existing: heat.js windows.js score.js psr.js nasa-avg.js            │  route_id)
                 route-plan.js route-energy.js comms.js contingency.js mission-config.js
                        │
                 demo/data packs (+ ice_2km.bin, ice_1km.bin, ice_dist_2km.bin, ice_240m.bin)
```

- **一个注册表，三个入口**：新工具都加在 `tools-core.js`，MCP 和页面助手同时获得。页面助手已有三种语气，所以公众入口几乎是现成的。
- **MCP 外壳新增**：prompts（§7）、resources（§7）、引用存储、`detail` 控制、进度通知（客户端带 `progressToken` 时，每完成 10% 发一次）。
- **引用存储**：进程内 LRU（32 条）。`search_id` / `mission_id` / `route_id` 都带一份输入摘要，过期时错误信息会告诉助手用什么参数重跑，而不是让它猜。
- **PLACE 类型扩展**：现有 `{site_id}` / `{lat_deg, lon_deg}` 之外，再接受 `{candidate: "S2"}`（最近一次搜索）、`{search_id, rank}`、`{mission_point: "W2"}`（当前任务）。所有接受地点的工具都能直接用。

## 5. 统一约束语言 `criteria`

```jsonc
{
  "preset": "lander_dte",              // optional; explicit fields below override it
  // terrain
  "slope_max_deg": 5, "slope_scale": "2km",          // 2km | 1km | 240m
  "inside_psr": false,
  "psr_distance_km": { "min": 0.5, "max": 5 },
  "ice": { "class": "shallow", "within_km": 5, "depth_max_m": 1 },   // target near the site, see §2
  "nasa_avg_sun_min": null, "nasa_avg_earth_min": null,             // 18.6-year shares, 0–1
  // timing (evaluated per landing time)
  "continuous_from": "from_landing",   // from_landing | within_stay | from_time
  "both_continuous_h_min": 300, "sun_continuous_h_min": null, "earth_continuous_h_min": null,
  "both_total_h_min": null, "sun_total_h_min": null, "earth_total_h_min": null,
  "sun_at_landing": true, "earth_at_landing": true,
  "longest_dark_h_max": null,          // battery hours, an assumption
  "sun_elevation_min_deg": null, "earth_elevation_min_deg": null,
  "stay_days": 14
}
```

- **预设**（resource `lsn://criteria/presets`，schema 里也是 enum）：
  - `lander_dte`：通用着陆器，直连地球
  - `long_stay_dte`：长驻留，日地同见 ≥ 300 h
  - `ice_prospector`：`lander_dte` + 5 km 内有浅层冰目标 + 坡度 ≤ 5°
  - `relay_ok`：不要求地球，太阳连续 ≥ 72 h（假设有中继）
  - `sun_never_sets`：驻留期内太阳一直在（给公众的简单问题用）
- **评估结果的统一形状**（每个候选、每个推迟量都一样）：

```jsonc
{ "pass": false,
  "checks": [
    { "id": "both_continuous_h_min", "need": 300, "value": 233, "margin": -67, "pass": false, "screened": true },
    { "id": "slope_max_deg", "need": 5, "value": 4.5, "margin": 0.5, "pass": true }
  ],
  "limiting": "both_continuous_h_min" }
```

- `criteria.js` 只负责解析、补默认值、评估、算余量和"limiting"，不做任何计算。数值来自 `search.js`（网格）或 `windows.js`（单点）。

## 6. 工具设计

优先级：P0 = 今天截止前做；P1 = 有余力今天做，否则赛后；P2 = 赛后。

### 6.1 `find_landing_sites` ★ P0

**用途**：在极区网格上按 `criteria` 搜索着陆候选，排序、去重，并给出筛选漏斗、不可行原因和放宽建议。

**输入**

```jsonc
{
  "region": { "within_km": 30, "of": { "site_id": "shackleton" } },  // or bbox | polygon | "cap" (default) | { "of": { "mission_point": "landing" } }
  "landing": "2027-01-13",                 // or "landing_window": { "from": "2027-01-01", "to": "2027-03-01" }; neither = any date
  "slip": { "from_days": 0, "to_days": 7, "step_h": 6 },   // optional
  "criteria": { ... },                     // §5
  "rank_by": "margin",                     // margin | both_continuous | robustness | ice_distance | contrast | score
  "count": 5, "min_spacing_km": 10,
  "refine": true,                          // 1 km grid + point skyline for the top cells
  "detail": "standard"
}
```

**算法（分层，越往后越贵）**

| 层 | 做什么 | 数据 | 原型耗时 |
|---|---|---|---|
| T0 区域 | 区域掩膜 ∩ 声明覆盖（≥ 80°S）；去掉天际线被截断的边缘格 | `horizon_grid` 元数据 | ~0 |
| T1 静态 | 坡度、PSR 内外与距离、冰目标距离、NASA 长期平均 | `slope_2km`、`shadow_2km`、`ice_dist_2km`、`nasa_*` | 1–2 ms（102,400 → 14,394） |
| T2 时间 | 每格算一条 1 h 采样的日地可见位序列，覆盖 [最早着陆, 最晚着陆 + 驻留]；用游程算连续时长（`from_landing` 用后缀游程，`within_stay` 用窗口内最长游程），推迟扫描在同一条序列上做，几乎不增加成本 | `heat.js` `grid.visibility` | 0.3–0.6 s（14k 格，37 天） |
| T3 精算 | 前 M 个（默认 60）2 km 格各拆成 4 个 1 km 子格重算，取最好的子格；再用单点天际线（480 m DEM）15 min 扫描复核全部约束 | `horizon_1km`、`windows.js` | 估计 1–3 s（未测） |
| T4 去重排序 | 按 `rank_by` 贪心排序，保证最小间距 | `heat.js topCells` | ~0 |

不定日期时，T2 的序列覆盖整个星历期（2026-11 到 2029-01，2 h 采样），每个候选输出最好的着陆日和满足条件的天数。估计 14k 格约 6–8 s，需实测。

**输出**

```jsonc
{
  "search_id": "s_7f3a",
  "query_echo": { ...resolved inputs with defaults... },
  "assumed": ["slope limit 5° (2 km mean)", "ice = thermal stability, not detection"],
  // real counts from the prototype data (landing 2027-10-07, 2 km cells, PSR 1–5 km); the ice and refine stages are not built yet
  "funnel": [
    { "stage": "all cells", "cells": 102400 }, { "stage": "coverage ≥80°S", "cells": 72580 },
    { "stage": "slope ≤5° (2 km)", "cells": 20434 }, { "stage": "PSR 1–5 km", "cells": 6969 },
    { "stage": "ice target ≤5 km", "cells": "…" }, { "stage": "Sun+Earth from landing ≥300 h", "cells": 71 },
    { "stage": "refined (1 km + point skyline)", "cells": "…" }
  ],
  "candidates": [
    { "ref": "S1", "lat_deg": -84.82, "lon_deg": 24.44, "cell_km": 1,
      "eval": { "pass": true, "checks": ["…"], "limiting": null },
      "metrics": { "both_from_landing_h": 401, "both_h": "…", "longest_dark_h": "…", "sun_peak_deg": "…", "earth_peak_deg": "…",
                   "slope_deg": 4.5, "psr_km": 2, "screened_vs_exact": { "both_from_landing_h": [401, "…"] } },
      "slip": { "worst": { "both_from_landing_h": 233 }, "first_fail_h": 102, "fail_reason": "both_continuous_h_min" },
      "science_target": { "kind": "ice_shallow", "lat_deg": "…", "lon_deg": "…", "dist_km": "…", "area_km2": "…", "depth_m": "…" },
      "best_landing": null,                // filled in any-date mode
      "headline": "…" }
  ],
  "near_misses": [ { "ref": "N1", "fails": "psr_distance_km", "value": 5.6 } ],   // fail exactly one check
  "feasibility": {
    "status": "ok | infeasible | thin",
    "binding": "both_continuous_h_min with slip 0–7 d",
    "why": "…",                                    // see §8.3
    "max_achievable": { "both_from_landing_h": 401, "at": "2027-10-07" },
    "relaxations": [ { "change": { "both_continuous_h_min": 230 }, "unlocks": "…" }, { "change": { "continuous_from": "within_stay" }, "unlocks": "…" } ]
  },
  "about": { "resolution": "2 km screen, 1 km + point skyline refine", "sampling": "1 h screen, 15 min refine", "limitations": [...] },
  "links": { "map": "…#pins=…" }
}
```

- `relaxations` 在 T2 已缓存的序列上逐项放宽重算，只放宽一个维度，按多出的候选数排序，成本很低。
- `headline` 是一句中性描述，供助手按受众改写。

### 6.2 `check_slip_robustness` ★ P0

**用途**：给定若干地点（策展站点、坐标、搜索候选、任务着陆点）和计划着陆时刻，逐个推迟量检查约束。回答"哪些点推迟 7 天也能用"。

- **输入**：`places`（缺省 = 全部 80°S 以南的策展站点）、`landing`、`slip {from_days,to_days,step_h}`、`criteria`、`detail`。
- **输出**：
  - 每个地点：`survives_all`、`first_fail_h`、`fail_reason`、最差值、各推迟量的通过/失败矩阵（`brief` 只给摘要，`full` 给矩阵）。
  - 全局：`survivors[]`，以及"可行性"块（同 6.1）。
- **实现**：单点用 `windows.js` 15 min 精扫一次 [L+from, L+to+驻留]，各推迟量在同一组区间上用区间运算得出。和 6.1 共用 `criteria.js`。

### 6.3 `landing_windows` P0

**用途**：对一个地点，在星历期内找出所有满足 `criteria` 的着陆**时间段**，以及长度 ≥ 推迟容忍量的"稳健窗口"。回答"这个点什么时候能降，推迟 7 天还能不能降"和"电池撑 30 小时，哪些日期安全"。

- **输入**：地点、`criteria`、`from`/`to`、`min_window_days`、`step_h`（默认 6）。
- **输出**：`windows: [{ open, close, length_h, worst_check }]`、`robust_windows`、计划日期落在哪个窗口里、离窗口边缘还有多少小时。
- 是 `best_landing_dates`（按天排名）的区间化版本。两者都保留，`best_landing_dates` 回答"最好的几天"，`landing_windows` 回答"哪些时间段可以"。

### 6.4 任务三件套 ★ P0（`mission_check` P1）

用户的计划存在浏览器 localStorage 里（`lsn-mission`、`lsn-route3d`、`lsn-records`、`lsn-config`），MCP 进程读不到，所以需要一座桥。

**`mission_open`**
- 来源 `source`：
  - `{path}`：页面导出的任务记录 JSON（`lsn-mission-record` v1）、冻结配置（`lsn-config` v1）或 GeoJSON。
  - `{url}`：页面分享链接。现在的 hash 已经带地点、时间、驻留、推迟和模式；v2 再加 `wps=` 和航点名，由页面 `state.js` 解析。
  - `"live"`（P1）：页面在设置里打开"把计划共享给我的助手"后，向 MCP 进程起的 `127.0.0.1` 小服务推送当前计划，带随机令牌，默认关闭。
- **航点命名规则**（页面同时支持给航点起名，名字随导出带出）：

| 名称 | 含义 |
|---|---|
| `landing` | 计划着陆点 |
| `touchdown` | 执行页记录的实际触地点 |
| `start` / `end` | 路线起点、终点 |
| `W1…Wn` | 按顺序的航点 |
| `stop1…` | 能量仿真里的停车充电点（带起止时刻） |
| `haven1…` | 避险点 |
| `empty` | 电量耗尽点 |
| `km12.5` | 沿路线第 12.5 km 处 |
| 用户自定义名 | 如"冷阱入口" |

- **输出**：`mission_id`、地点、着陆时刻、驻留、推迟、航点表（坐标、计划到达/离开时刻）、路线摘要、上次冻结以来的变化（`changesSince`）。

**`mission_conditions`**（对应请求二）
- **输入**：`points: ["W2","W4"] | "all"`、`window: "pass" | "stay" | "both"`（默认 both）、`detail`。
- **每个点输出**：
  - **途经时**（来自能量仿真的到达/离开时刻）：日地高度和离天际线余量、是否见光、是否见地；到达后多久日落、多久地落；途经期间最长失联；地面站链路（若有）。
  - **整个驻留期**：日、地、同见小时数，最长黑夜，下一次日落/地落。
  - **风险**：如"到达时见光但 3.2 h 后日落""途经全程地球不可见，没有直连"，按严重度排序。
- 不另写计算，内部调用 `sky_at`、`next_events`、`site_summary`、`comms.linkSummary`。

**`mission_check`**（P1）
- 复用 `mission-config.js goNoGoRows` 生成放行检查，再加推迟假设：`slip_days: [1,3,7]`，列出每个推迟量下哪些检查从 go 变成 warn / no-go，以及原因。

### 6.5 `plan_traverse` P1（取代 `route_candidates`，保留旧名作别名）

**用途**：请求一里的"以及路径"。从着陆点到科学目标（可以往返），看机动性、能量、通信、避险。

- **输入**：
  - `from`：PLACE，可以是 `{candidate:"S1"}`。
  - `to`：PLACE 或 `{nearest: "ice_surface" | "ice_shallow" | "psr_edge" | "haven" | "station"}`。最近目标按**驾驶时间**选（`route-plan.js reachFrom`），不按直线距离。
  - `via[]`（≤ 6 个）、`return_to_start`。
  - `depart`：ISO 时刻、`"landing+6h"` 或 `"best"`（用 `scanDepartures` 搜最好的出发时刻）。
  - `mobility`、`power`、`station`：都是假设值，有默认。
  - `planners`：`["shortest","flattest","sunniest","rrt"]`。
  - `include_path`、`detail`。
- **输出**：每条候选路线给出
  - 长度、行驶小时、停车等待小时、到达时刻、最低电量及位置、单行段 km、能否返回、陷阱面积、黑暗段 km、见地比例、地面站链路比例、最长失联；
  - 每个航点的预计到达时刻和当时的日地状态；
  - 避险点；
  - **进入 PSR 的提示**（PSR 里没有太阳能，要靠电池撑 y 小时）；
  - 风险清单、`route_id`，可选 GeoJSON 路径。
- **实现**：拼装已有的 `route-plan.js` + `route-energy.js` + `comms.js` + `contingency.js`，全是纯函数。耗时按 `route_candidates` 的经验估计为几秒，需实测。

### 6.6 `explain` P1

**用途**：返回"为什么"的**结构化事实**，不返回成段文字。由助手按受众改写，教育者和公众主要靠它。

**topic**

| topic | 返回什么 |
|---|---|
| `why_dark` | 太阳方位上的天际线遮挡点：方位、距离、高程（新增 `horizonBlocker`：沿射线找出决定天际线的那个地形点），太阳当时高度和遮挡角 |
| `why_earth_sets` | 地球高度的周期（天平动，约 27.2 天）、当前相位、下一次最高/最低 |
| `why_slip_matters` | 两个着陆日对比：哪个天体损失了多少；太阳 29.5 天周期和地球 27.2 天周期错开，好窗口每月漂移 |
| `why_south_pole` | 冰（PSR 面积、冷阱）、峰顶长时间见光（NASA 长期平均） |
| `contrast` | 两个邻近地点的差异和地形成因 |
| `earth_analogy` | 一个月球日的长度、太阳最高能到多高，并换算成地球上的对应量，例如"日出后几分钟的太阳高度" |
| `misconception` | 输入一个说法，返回支持或反驳它的数据（如"背面永远是黑的"） |

**输出**：`facts[]`（每条带数值和单位）、`cause_chain[]`、`analogies[]`（数值是算出来的）、`suggested_view`（打开到合适时刻的页面链接）、`addresses_misconceptions[]`。

### 6.7 `classroom_activity` P2

- **输入**：主题、年级段、时长、题目数、可选指定地点。
- **输出**：教学目标、步骤（每步配一个页面状态链接）、题目和答案。每个答案都标明来自哪次工具调用、输入是什么，换地点可以重算。附教师提示（常见误解）和可打印的 Markdown。

### 6.8 v1 工具的改动

| 工具 | 改动 | 优先级 |
|---|---|---|
| `site_summary` / `compare_scenarios` | 加 `both_from_landing_h`、`longest_both_h`、`longest_sun_h`、`longest_earth_h`（`windows.js` 区间上直接算） | P0 |
| `point_facts` | 加冰：Tmax、冰台深度、冰稳定分级、最近冷阱距离；加 1 km 坡度 | P0（冰视 §10 进度） |
| `skyline` | 每个方位加遮挡点的距离和高程（与 `explain.why_dark` 共用） | P1 |
| 全部 | 接受扩展后的 PLACE（候选 / 任务航点）；加 `detail` 参数 | P0 |
| `open_in_navigator` | 加叠加层：`pins`（搜索结果，带标签）、`route`（`route_id`）、`mission`、`persona` 预设（planner / educator / public 的面板组合）、`playhead`；页面同步解析这些参数 | P1 |
| `route_candidates` | 保留为 `plan_traverse` 的别名 | P1 |

## 7. Prompts 与 Resources

**Prompts**（客户端里是斜杠命令，例如 Claude Code 的 `/mcp__lunar-site-navigator__plan_landing_site`）。每个 prompt 都带上对应受众的语气（直接复用 `agent/system-prompt.js` 的 AUDIENCES），并写明调用顺序和必须说出的假设。

| prompt | 受众 | 参数 | 流程 |
|---|---|---|---|
| `plan_landing_site` | 规划者 | 区域、日期、要求（自然语言） | 复述定义 → `find_landing_sites` → 不可行时讲卡点并给放宽选项 → 对首选候选 `plan_traverse` → 表格 + 链接 |
| `respond_to_slip` | 规划者 | 地点、原日期、新日期 | `compare_scenarios` → `landing_windows` → 附近搜索替代 |
| `check_my_mission` | 规划者 | 任务来源 | `mission_open` → `mission_check` → `mission_conditions(all)` |
| `build_lesson` | 教育者 | 主题、年级、分钟数 | `explain` + 演示用地点 + 题目（答案可复算） |
| `explain_simply` | 公众 / 教育者 | 问题 | `explain(brief)` + 一个链接 |
| `virtual_visit` | 公众 | 地点、时刻（默认现在） | `sky_at` + `skyline` + 第一人称描述 |
| `my_first_mission` | 公众 | — | 引导：选址 → 定日期 → 看推迟 → 打开页面 |

**Resources**

| URI | 内容 |
|---|---|
| `lsn://sites` | 策展站点 |
| `lsn://criteria/presets` | 约束预设及含义 |
| `lsn://about/data` | 数据来源、分辨率、覆盖范围、局限（与 README 资源表一致） |
| `lsn://glossary` | 术语表（`docs/guide/glossary.md`） |
| `lsn://search/{id}.csv`、`lsn://search/{id}.geojson` | 搜索结果导出 |
| `lsn://mission/{id}` | 已加载的任务 |
| `lsn://route/{id}.geojson` | 路线 |

**Server instructions**（`initialize` 返回给客户端的说明）：在现有文字基础上补充约束语言、引用写法（`S1`、`W2`）、"假设必须点名"、"不可行时先讲卡点"，以及三种受众的默认 `detail`。

## 8. 三个示例请求的完整调用链

### 8.1 "帮我筛选一个平坦、日照和地球均持续可见 300 小时以上、离永久阴影区近、可能有水冰的着陆点以及路径"

1. 没说日期：先试 `mission_open("live"|最近导出)`。有任务就用它的着陆时刻，否则用"不定日期"模式。助手在回答里说明这一点。
2. 调用：

```jsonc
find_landing_sites {
  "criteria": { "preset": "ice_prospector", "slope_max_deg": 5, "both_continuous_h_min": 300,
                "continuous_from": "from_landing", "psr_distance_km": { "max": 5 },
                "ice": { "class": "shallow", "within_km": 5 } },
  "count": 5, "min_spacing_km": 10
}
```

3. 对 `S1`：`plan_traverse { from: {candidate:"S1"}, to: {nearest:"ice_shallow"}, return_to_start: true, depart: "best" }`。
4. `open_in_navigator { pins: "s_…", route: "r_…" }`。
5. 回答的形状：结论（推荐 S1 和最好的着陆日）→ 候选表（连续同见小时、坡度、PSR 距离、冰目标距离、最好着陆日）→ 路线摘要（往返 km、PSR 内无光小时数、最低电量）→ 点名假设（坡度上限、电池、冰 = 热稳定）→ 链接。

### 8.2 "把我任务规划的 W2 和 W4 的光照、地球可见性列出来"

1. `mission_open { source: { path: "~/Downloads/Mission_A.json" } }`；或者用户贴一个页面链接，或者用 live 桥。
2. `mission_conditions { points: ["W2","W4"] }`。
3. 回答的形状（示意，数值由工具给出）：

| 点 | 计划到达 | 到达时太阳 | 到达时地球 | 到达后日落 | 到达后地落 | 风险 |
|---|---|---|---|---|---|---|
| W2 | 着陆 + 52 h | 高于天际线 1.8° | 被北侧山脊挡住 | 31 h 后 | 已落，6 h 后升起 | 前 6 h 无直连 |
| W4 | 着陆 + 96 h | 见光 | 见地 | 3.2 h 后 | 40 h 后 | 停留不能超过 3 h |

4. 附 `open_in_navigator { mission, point: "W4", playhead: 到达时刻 }`。

### 8.3 "帮我筛选即使任务推迟 7 天也均可用的着陆点"

1. "可用"没说具体条件：如果有任务就用它的放行检查，否则用预设 `lander_dte`，并在回答里说明。
2. 范围：说的是"着陆点"，先查策展站点 `check_slip_robustness { slip: {to_days:7} }`，再查全区 `find_landing_sites { slip: {to_days:7} }`。
3. 如果和请求一的 300 h 条件叠加，工具会返回不可行，原型数据如下：

```jsonc
"feasibility": {
  "status": "infeasible",
  "binding": "both_continuous_h_min = 300 (from_landing) with slip 0–7 d",
  "why": "从着陆起算时，每推迟 1 h 连续窗口就少 1 h；要扛住 168 h 推迟，需要 ≥ 468 h 的连续日地同见窗口。满足坡度和 PSR 条件的格子里，最长是 401 h（2027-10-07 着陆，84.82°S 24.44°E）",
  "max_achievable": { "both_from_landing_h": 401, "at": "2027-10-07" },
  "relaxations": [
    { "change": { "slip_to_days": 4 }, "unlocks": "…" },
    { "change": { "both_continuous_h_min": 230 }, "unlocks": "…" },
    { "change": { "continuous_from": "within_stay", "stay_days": 30 }, "unlocks": "…" }
  ]
}
```

4. 这是规划者最需要的一句话：条件互相冲突，能达到的最好是什么，放宽哪一条代价最小。

## 9. 输出契约

- **统一外壳**：`query_echo`、`assumed[]`、主体结果、`headline`、`refs`、`about`（单位、分辨率、采样、数据版本、局限）、`links`。
- **`detail` 三档**：
  - `brief`：≤ 1 KB，只有 headline、3–5 个关键数字和一个链接。
  - `standard`：表格级。
  - `full`：加 `about`、矩阵和逐点序列。
- **结构化输出**：继续同时返回 `structuredContent` 和文本 JSON；v2 给每个工具加 `outputSchema`。
- **错误也是数据**：例如"80°S 以北没有地形数据，用的是平滑地平线"、"冰数据未加载，用 PSR 代理"。不编造任何值。
- **注解**：所有工具 `readOnlyHint: true`、`idempotentHint: true`、`openWorldHint: false`。
- **命名**：v1 工具名不变（页面助手和测试在用），新工具用动词开头。

## 10. 水冰数据（需核实后接入）

- **候选数据**：Schorghofer, N. & Williams, J.-P. (2020), *Mapping of ice storage processes on the Moon with time-dependent temperatures*, PSJ 1:54, doi:10.3847/PSJ/abb6ff。UCLA Diviner 团队发布。
- **地址**：`https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/24x6_240m/additional_maps/`。目录里还有 `pds/`，如果是 PDS 归档版，优先用它。
- **已核实**（2026-11-15，读了目录列表和 `aareadme.txt`）：
  - 南极 80° 以南的文件有：`polar_south_80_Tmax.grd`（傅里叶平滑后的最高温度，K）、`polar_south_80_zit-1.grd`（升华损失率降到 1 kg/m²/Gyr 的深度，m）、`zit-100`、`Tmean`、`Emax`、`Emean`、`pump`。
  - 每个约 25 MB；部分另有 float32 GeoTIFF。
  - 该服务器的 TLS 证书校验不过，`curl` 要加 `-k`。
- **未核实**（接入前必须查清）：
  - `.grd` 的具体格式（GMT 网格一般是 netCDF）、投影和范围。分辨率 240 m 只是从目录名推断的。
  - 无数据值。
  - 这个数据和我们 LOLA 极坐标网格怎么对齐。
- **分级规则**：
  - 冰面稳定：`zit-1` = 0。
  - 浅层稳定：0 < `zit-1` ≤ `depth_max_m`（默认 1 m）。
  - `Tmax` 只用来展示和解释（经典阈值约 110 K）。
- **打包**：新写 `tools/build-ice.mjs`，零依赖，产出：
  - `ice_240m.bin`：单点查询用。
  - `ice_1km.bin` / `ice_2km.bin`：每格的冰分级和冷阱面积占比。
  - `ice_dist_2km.bin`：到最近冰稳定斑块的距离，规则仿照 `shadow_2km`（斑块 ≥ 0.5 km²）。
- **兜底**：格式核实 1 小时内搞不定，今天就只用"PSR 内"作代理，结果里写明"未使用温度数据"。
- **README**：资源表加一行。
- **措辞**：结果和回答里一律写"热稳定、可能存冰"，不写"有冰"。

## 11. 性能与原型实测

原型在 `docs/mcp-v2/proto/`，在仓库根目录运行。Node 26，Apple Silicon，单线程。

| 原型 | 设定 | 结果 | 耗时 |
|---|---|---|---|
| `search-window.mjs 2027-01-13` | ≥ 80°S、2 km 坡度 ≤ 5°、PSR 距离 1–10 km（102,400 → 14,394 格）；30 天驻留内任意一段日地同见 ≥ 300 h；按天推迟 0–7 天 | 当天 269 格通过，7 天推迟后仍通过 2 格 | 0.57 s |
| 同上，`2027-06-01` | 同上 | 78 格通过，78 格全部扛住推迟 | 0.65 s |
| `search-from-landing.mjs 2027-01-13` | 同样的静态过滤；从着陆起连续 ≥ 300 h；每 6 h 推迟一次，0–7 天 | 37 格通过，0 格扛住推迟（最好的在 +66 h 失败） | 0.28 s |
| 同上，`2027-10-07` | 同上 | 153 格通过，0 格扛住推迟；最长连续 401 h，最好的在 +102 h 失败 | 0.33 s |

**结论**
- T1 + T2 在现有数据上不到 1 秒，P0 的性能不是问题。
- 口径（`from_landing` 还是 `within_stay`）对结果影响巨大（37 vs 269），所以必须回显口径，并让用户能切换（§14 决策 1）。
- 不限 80°S 时，结果集中在网格四角的 75–78°S（那里天际线可能被 DEM 边界截断）。所以 T0 必须裁到声明的覆盖范围。
- 还没测的：T3 精算、不定日期模式（估计 6–8 s）、`plan_traverse`。实现时补测。

## 12. 安全与边界

- 只读；不联网；不写用户文件。导出走 resources，由客户端决定保存到哪里。
- `mission_open` 只读 JSON，≤ 5 MB。客户端支持 MCP roots 时只读 roots 内的文件，否则只读用户显式给出的路径。
- live 桥（P1）：只绑定 `127.0.0.1`，随机令牌，页面端默认关闭，用户主动打开才推送。
- 每个结果都写明"首轮筛查，不是认证级着陆分析"；电池、面板、轨道、坡度上限、钻深都标为假设。

## 13. 分期与分工（按文件所有权拆，可并行）

截止时间：2026-11-15 23:59（当地）。

| 包 | 内容 | 拥有的文件 | 优先级 |
|---|---|---|---|
| A 搜索 | `criteria.js`、`search.js`（序列、游程、推迟、漏斗、可行性与放宽、T3 精算）；工具 `find_landing_sites`、`check_slip_robustness`、`landing_windows`；v1 加连续时长指标 | `demo/src/criteria.js`、`demo/src/search.js`、`tests/search*.test.mjs`、`tools-core.js` 中这三个工具的段落 | P0 |
| B 任务 | `mission-io.js`（解析记录、配置、链接；航点命名）；工具 `mission_open`、`mission_conditions`；页面航点起名、hash 加 `wps=` | `demo/src/mission-io.js`、`tests/mission-io*.test.mjs`、`state.js` 的 hash 部分、航点 UI 的最小改动 | P0 |
| C 外壳 | prompts、resources、引用存储、扩展 PLACE、`detail`、进度通知、server instructions、`mcp/README.md`、`try.mjs` 演示三个示例请求 | `mcp/*`、`tools-core.js` 的 PLACE 解析 | P0 |
| D 冰 | 核实格式 → `tools/build-ice.mjs`、`demo/src/ice.js`、数据包；`point_facts` 冰字段；`criteria.ice`；README 资源表 | `tools/build-ice.mjs`、`demo/src/ice.js`、`demo/data/ice_*` | P0（1 小时核实不过就退回 PSR 代理） |
| E 路径 | `plan_traverse`（拼装已有路线模块，nearest 目标）、`mission_check` | `demo/src/traverse.js` 等 | P1 |
| F 解释 | `explain.js`（含 `horizonBlocker`）、`skyline` 遮挡点、`open_in_navigator` 叠加层和页面解析 | `demo/src/explain.js`、`navigator.mjs` | P1 |
| G | `classroom_activity`、MCP Apps 内嵌界面（需先核实客户端支持）、托管 HTTP 版、live 桥 | — | P2 |

`tools-core.js` 是共享文件。A、B、C 会同时改它，所以由 C 先把注册表拆成"每个工具一个导出段"，或者合并时按段落串行。

## 14. 需要你拍板

1. **"持续可见"的默认口径**：`from_landing`（推荐：着陆器一落地就要电和通信），还是 `within_stay`？两种口径的结果相差近 10 倍（37 vs 269）。
2. **今天是否接入 Diviner 水冰数据**：要下载约 2 × 25 MB，新增一个数据源，还有一小时的格式核实风险。不接的话，"可能有水冰"今天只能用"PSR 内"代理。
3. **任务计划怎么桥接**：P0 用导出文件 + 分享链接（推荐，零基础设施），live 实时桥放 P1？
4. **今天的范围**：做 P0 的 A + B + C（+ D），还是只做 A + C，先保证请求一和请求三能演示？
5. **谁来实现**：按之前的做法，我写任务书分给其他 agent，我负责验收？
