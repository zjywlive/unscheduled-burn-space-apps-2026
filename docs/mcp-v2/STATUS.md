# MCP v2 实现状态

2026-11-15 · 设计见 `DESIGN.md`，任务书见 `briefs/`，各包报告见 `reports/`。未提交。

## 已实现（P0）

| 部分 | 文件 | 谁写的 |
|---|---|---|
| 约束语言 `criteria`（预设、评估、余量、limiting） | `demo/src/criteria.js` | Claude |
| 单点精算（480 m 天际线、15 min 扫描） | `demo/src/point-eval.js` | Claude |
| 引用存储（`S1`、`W2`、别名） | `demo/src/tools-v2/refs.js` | Claude |
| 扩展口、扩展后的 PLACE、`point_facts` 冰字段 | `demo/src/tools-core.js`（`createCoreTools(ctx, { extensions })`） | Claude |
| Node 加载器：1 km 网格、冰数据、读本地任务文件 | `tools/core-context.mjs` | Claude |
| `find_landing_sites`（T0–T4、漏斗、不可行与放宽） | `demo/src/search.js`、`demo/src/tools-v2/find.js` | astra（A1），Claude 修改 |
| `check_slip_robustness`、`landing_windows` | `demo/src/tools-v2/slip.js` | astra（A2），Claude 修改 |
| `mission_open`、`mission_conditions` | `demo/src/mission-io.js`、`demo/src/tools-v2/mission.js` | astra（B），Claude 修改 |
| Diviner 冰数据（格式核实、方向判定、打包） | `tools/build-ice.mjs`、`demo/src/ice.js`、`demo/data/ice*` | astra（D） |
| MCP prompts（7 个）、resources（4 个 + 导出模板）、服务说明 | `mcp/catalog.mjs`、`mcp/server.mjs`、`mcp/navigator.mjs` | Claude |
| 三个示例请求的演示 | `node mcp/try.mjs --v2` | Claude |

页面助手暂未接 v2 工具：`demo/src/main.js` 仍调用 `createCoreTools(ctx)`（不带扩展），所以页面行为不变。要接入，只需改那一行，传入 `{ extensions: V2_EXTENSIONS }`；`mission_open` 的 `path` 来源在浏览器里不可用，会提示改为粘贴 JSON。

## 集成时 Claude 做的修改

- 搜索预算不够时，按 NASA 18.6 年平均日地可见率优先，不再按网格顺序均匀抽样。
- 筛查通过数不足时，把只差一两项时间条件的格子也送去精算（漏斗里记为旁支 `refined_near_misses` / `exact_near_misses`，主线保持单调）。
- 按时刻缓存指标读取；`landingSet` 只在需要返回时才合并对象。"不定日期 + 7 天推迟"从 89 格、6.6 s 提高到 338 格、7.5 s。
- 推迟工具的 `brief` 模式保留精简的假设列表（原先折叠进了引用里）。
- 任务航点的插值时刻取整到分钟；引用存储支持用户给航点起的别名（规范名优先，别名重名时报错）。
- `about.limits` 写明两个分辨率限制：80°S 附近筛查天际线被截断，精算可兜住；窄脊和坑缘（< 1 km）网格搜不到，需要用 `check_slip_robustness` 检查具体站点。

## 验证（2026-11-15）

- 全量测试 `node --test 'tests/*.test.mjs'`：843 项，通过 827，失败 0，跳过 16（原有的、缺原始数据的测试）。
- v2 与 MCP 相关测试 125 项全部通过：search、find-tool、slip-tool、mission-io、mission-tool、ice、mcp-server、mcp-tools（每个工具经 stdio 调用都与直接调用结果一致）、mcp-catalog、tools-core。
- 独立打包 `node tools/package-mcp.mjs`：18 个工具，解压后逐字节一致，`try.mjs` 退出码 0。
- 真实 MCP 客户端（opencode + gpt-6-astra，只读权限，空目录）原样输入三句请求，结果见下节。

## 已知限制

- 网格搜索分辨率 1–2 km：沙克尔顿连接脊这类窄脊上的点（全程见光）会漏掉，因为 0.8 km 外的格中心有 325 h 黑夜。请求三要先查策展站点，再做全区搜索。
- "不定日期"的全区搜索是部分搜索（约 2,300 / 7,000 个格子，按长期可见率优先），结果会标明。
- "连续可见 300 h"在 80°S 近地面一侧，只要在当地日出时着陆就能满足（地球几乎一直在天上）；但驻留结束后紧跟着约 14 天黑夜。回答里要讲清这一点。
- 浅层稳定冰（冰台 ≤ 1 m）约占南纬 80° 以南面积的三成，所以"5 km 内有浅层冰"几乎不起筛选作用；表面稳定冰（`class: surface`）的筛选力更强。
- 未做：`plan_traverse`、`explain`、`mission_check`、页面实时桥、页面分享链接里的航点（`wps=`）、`outputSchema`、进度通知。

## 下一步（P1）

1. 页面助手接入 v2 工具（`main.js` 一行，并重新构建 `demo/index.html`）。
2. `plan_traverse`：从候选点到冰目标往返，拼接 `route-plan.js`、`route-energy.js`、`comms.js`。
3. `explain`：遮挡点（`horizonBlocker`），给教育者和公众用。
4. `mission_check`：沿用 `goNoGoRows`，叠加推迟假设。
