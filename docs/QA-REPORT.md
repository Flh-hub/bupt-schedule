# 北邮课程表 · QA 独立验证报告

> 验证者：QA（严过关）｜被测版本：`D:/bupt-schedule` 当前工作区｜日期：2026-10-22
> 运行环境：Node v22.22.2 / Windows（Git Bash）
> 立场说明：工程师自测 90 条全绿。本报告**不采信自测结论**，只按 `docs/PRD.md` §7.8.1 / `docs/ARCHITECTURE.md` / `docs/TASKS.md` §3 的契约重新写断言，凡工程师未覆盖或只覆盖 happy path 的地方一律对抗式验证。
> 硬约束遵守情况：**未修改 `src/` 任何文件**；**未新增任何 npm 依赖**；新增文件仅 `tests/qa-*.test.mjs`（4 个）、`.gate-notice.mjs`、`.gate-copy.mjs`、本报告。

> **最终状态（第 2 轮回归后）**：`180 tests / 180 pass / 0 fail / exit 0`，三道运行时门禁 G14/G16/G18 全 `PASS`/exit 0，`ROUTE: NOBODY`。
> 第 1 轮发现的 8 条缺陷已逐条独立复核修复（不是只看测试转绿，见 §1.1）；另记录 2 条**新发现但不阻塞交付**的 P2 已知问题（见 §3.9 / §3.10，本轮按要求不扩大范围、不再开修复轮）。

---

## 1. 结论摘要（第 1 轮基线）

| 项 | 结果 |
|---|---|
| 全量用例（第 1 轮） | **165 条 / 通过 157 / 失败 8 / 退出码 1** |
| 其中 QA 新增 | 75 条（`tests/qa-*.test.mjs`），通过 67，失败 8 |
| 其中工程师原有 | 90 条全部通过（未改动一行） |
| 失败归因 | **8 条全部为源码缺陷**（无一条是测试写错） |
| 智能路由（第 1 轮） | **`ROUTE: ENGINEER`** |
| 质量门禁 | G2/G3/G4/G8/G9/G10/G11/G12/G13/G14/G15/G16/G17/G18 **全部 PASS**；G1 因真实缺陷为红；G7 需浏览器/真机，未验 |
| 核心真相层 | `classifyDay` 五步顺序、7 状态、`complete` 纪律、`getReminders` 计划对象、ICS 时区/UID —— **全部通过，P0-17 的"未知 vs 确定没课"没有被做假** |
| 风险集中区 | **解析器文本通道（P0-1 兜底通道）与嵌套表格**：8 个缺陷里 7 个在这里，且全部**静默**（无 `unrecognized`、无 `warnings`） |

一句话（第 1 轮）：**真相层和导出层是可信的；"数据进得来"这一环被打穿**。最刺眼的一条——应用自带的 `SAMPLE_TEXT`（导入页"一键填充示例数据"按钮）导入后，`大学英语` 会变成 `Sarah`、`体育(羽毛球)` 会变成 `体育馆-2F`、`1-8,10-16周` 会变成 `10-16周`。

---

## 1.1 第 2 轮回归：逐条复核修复结果

> 只是"测试转绿"不算验证。下表右列是**我用自己的探针脚本重新跑出的行为证据**（不读工程师/lead 的测试断言）。

| 原缺陷 | 复核方法（独立探针） | 实测结果 | 判定 |
|---|---|---|---|
| **P0-2** 周次截断 | `1-8,10-16周` 分别放在行尾 / 行中 / 节次前三个位置；再跑 8 种写法 + `3-15周(单),17周` | 三个位置均 `raw=1-8,10-16周`、展开 `[1..8,10..16]`（15 周）；`1,3,5-9周`→`[1,3,5-9]`；`3-15周(单),17周`→`[3,5,…,15,17]` | ✅ 修复 |
| **P0-1** 字段错位 | 6 条真实行型（含 `Sarah` 英文教师、`沙河校区-教学楼A101`、`操场`、`体育(羽毛球)`、`高等数学(上)`） | `name/teacher/location` 全部正确；括号内容保留（`高等数学(上)` 不再退化成 `高等数学`） | ✅ 修复 |
| **P0-3** 示例数据 | 直接对 `SAMPLE_TEXT` 跑 `parseText`，逐门核对 8 门课的 名称/节次/地点/周次 | 8 门课全部正确：`高等数学(上) P1-2 教三-201 16w`、`大学英语 P3-4 主楼-410 1-16周(单) 8w`、`体育(羽毛球) P7-8 体育馆-2F 1-8,10-16周 15w` …；`unknown=[]`、`warnings=[]` | ✅ 修复 |
| **P1** 嵌套表格 | 外层 2 行 × 4 列，其中一格内嵌 `<table>` | 外层 7 门课全部解析（`大学物理@2 / 大学英语@3 / 化学@4 / 线代@1P2 …`），内层单元格进 `unrecognized`（可补录，非静默） | ✅ 修复 |
| **P2** 叠加 `original` | 同日 roomChange(`教四-105`) + reschedule(第7-8节) | `location=教四-105`、`P7-8`、`original={location:'教三-201', startPeriod:1, endPeriod:2}` | ✅ 修复 |
| **P2** 时间制反查 | `periodsFromTimes('08:00', periods, '09:35')` 等 5 组 + 两参兼容 | `1-2 / 1-1 / 3-3 / 5-6 / 11-11`；两参调用仍返回单节（向后兼容） | ✅ 修复 |
| **P2** 表头阈值 | 表头只有 `周四/周五` 两列 | 2 门课全部解析（`dayOfWeek=[4,5]`），不再误判"未找到课表" | ✅ 修复 |
| **P2** `emptyState` 转义 | 传入 `<script>` 与 `<img onerror>` | `title` 与 `desc` 均被转义为 `&lt;…&gt;`，输出无裸 `<script` / `<img` | ✅ 修复 |
| **lead 补修的「周/周次」歧义** | `教三-101 周宏 1-16周`（原：教师=`宏`、地点=`教三-1`、周次=`1-1`） | 现：`loc=教三-101`、`teacher=周宏`、`raw=1-16周`、展开 16 周；周敏 / 周老师 同样正确；`周宏` + `周次:1-16` 也正确 | ✅ 修复 |

**回归数字**（本轮新增 10 条边界用例，专门钉死上面第 9 行那处修复的正反两面）：

```
$ node --test "tests/**/*.test.mjs"
# tests 180
# suites 0
# pass 180
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3114.2244
exit=0        ← G1：GREEN
```

```
$ node .gate-shape.mjs
GATE16: PASS
  9 字段齐全 / status ∈ 7 值 / 4 个样本语义正确 / NOTICE 7 键全函数 / plan 对象齐全
G16 exit=0

$ node .gate-notice.mjs
GATE14: PASS
  7 keys, all functions
G14 exit=0

$ node .gate-copy.mjs
GATE18: PASS
  8 样本，文案与状态全部符合
G18 exit=0
```

第 1 轮的 8 条红项现已全部 `ok`（`ok 113` 叠加 original、`ok 158` 嵌套表格、`ok 163-168` 文本通道 6 条、`ok 169` 原因码），`not ok` 计数 = **0**。

---

## 2. 测试矩阵（功能 × 用例数 × 结果，第 1 轮基线）

> 第 2 轮在该矩阵之上新增 `tests/qa-week-boundary.test.mjs`（10 条，全绿），总数 165 → 180，失败 8 → 0。

| 功能域 | 对应用例文件 | 用例数 | 通过 | 失败 | 结论 |
|---|---|---|---|---|---|
| 周次文案 8 种写法（含离散两段） | `qa-parsers-adversarial` | 2 | 2 | 0 | ✅ 含 `1,3,5-9周`→`extra:[1,3]`、`1-8,10-16周` 精确匹配 |
| HTML 网格：`rowspan` / `colspan` | 同上 | 2 | 2 | 0 | ✅ 占位记账正确，第 3 行不左移 |
| HTML 网格：嵌套 `table` | 同上 | 1 | 0 | 1 | ❌ **P1** 整表静默丢弃 |
| HTML 网格：一格两课 / `<br>` 乱序 | 同上 | 2 | 2 | 0 | ✅ |
| HTML 网格：无课标记 / 只有周次无课名 | 同上 | 2 | 2 | 0 | ✅ 均进 `unrecognized` |
| 文本通道（P0-1 兜底）：字段归属 | 同上 | 4 | 0 | 4 | ❌ **P0** 课程名/教师/地点错位 |
| 文本通道：离散周次 | 同上 | 2 | 0 | 2 | ❌ **P0** 周次被截断 |
| 文本通道：示例数据端到端 | 同上 | 1 | 0 | 1 | ❌ **P0** 自带示例即翻车 |
| 文本通道：未知行原因码 / F3 时间反查 | 同上 | 2 | 2 | 0 | ✅ |
| `Day` 七状态 + 判定顺序 4 条反例 | `qa-calendar-truth` | 10 | 10 | 0 | ✅ 含"学期外 > 补班三态"与 NaN 防线 |
| 调课四操作（cancel×2/roomChange/reschedule×2/makeup） | 同上 | 6 | 6 | 0 | ✅ |
| `sessions` 只读（含 `SET_MAKEUP_FOLLOW`） | 同上 | 2 | 2 | 0 | ✅ `JSON.stringify` 前后严格相等 |
| 冲突互指 / cancel 优先于 makeup | 同上 | 2 | 2 | 0 | ✅ |
| 叠加 adjustment 的 `original` 对照 | 同上 | 1 | 0 | 1 | ❌ **P2** 原值被中间值覆盖 |
| 跨零点 / 周次过滤 / 无效节次 | 同上 | 3 | 3 | 0 | ✅ |
| `getReminders` 计划对象（pending 不产点/skipped/warnings/提前量/通道/rule） | 同上 | 8 | 8 | 0 | ✅ |
| 内置节假日数据（33+6、逐日星期、推定唯一解） | 同上 | 1 | 1 | 0 | ✅ 与 PRD 附录 A 逐条一致 |
| ICS 合规（9 条：CRLF/VTIMEZONE/TZID/DTSTAMP/UID/75 字节/转义/告警/事件数） | `qa-ics-store-security` | 9 | 9 | 0 | ✅ |
| 存储健壮性（坏 JSON / 高版本 / 隐私模式 / 配额满 / 往返 / 合并 / action 校验 / 历史 3 条） | 同上 | 10 | 10 | 0 | ✅ |
| 转义与 XSS（`escapeHtml` 5 元字符 / 模板函数无裸标签 / 恶意课程名） | 同上 | 3 | 3 | 0 | ✅ |
| 静态资源与离线合规（7 个文件 / 零外链 / 零依赖） | 同上 | 3 | 3 | 0 | ✅ |
| **合计（QA 新增）** | | **75** | **67** | **8** | |

### 运行时 HTTP 静态资源检查（`python -m http.server 8099` + `curl`）

```
200  /index.html
200  /manifest.webmanifest
200  /sw.js
200  /src/main.js
200  /assets/css/app.css
200  /assets/icons/icon-192.png
200  /assets/icons/icon-512.png
200  /src/calendar.js
--- 404 对照 ---
404
```

### 零外链（G4，全仓 grep）

```
$ grep -rnE "https?://" index.html assets/css/app.css src/ sw.js manifest.webmanifest | grep -v bupt_schedule
（无输出 = 0 命中）
$ grep -rn "https\?://" --include="*.html" --include="*.js" --include="*.css" --include="*.webmanifest" . | grep -v "^\./tests/"
（无输出 = 0 命中）
```

---

## 3. 缺陷清单（按严重度）

> 每条给出：文件:行号 / 复现 / 期望 vs 实际 / 影响。复现命令可直接粘贴（在 `D:/bupt-schedule` 下执行）。

### P0-1 · 文本通道把教师名/英文名/地点残片当成课程名，且地点丢失

- **位置**：`src/parsers/html.js:554-556`（地点正则只认 `教X / 教学楼 / X教 / 主楼 / 实验楼`，或 `\d{2,4}` 形态）、`src/parsers/html.js:562-571`（`name = tokens.sort(按长度降序)[0]`，取最长 token 当课程名；`teacher` 取剩余第一个 ≤6 字且无数字的 token）、`src/parsers/html.js:563`（`()` 被当分隔符，括号内容被打散）。
- **复现**：

  ```bash
  node -e "import('./src/parsers/index.js').then(m=>{
    for (const t of ['周一 1-2节 高数 教三-101 王老师 1-16周(单)',
                     '周一 1-2节 大学英语 主楼-410 Sarah 1-16周',
                     '周一 3-4节 大学物理 沙河校区-教学楼A101 李明 1-16周',
                     '周三 1-2节 体育 操场 刘磊 1-16周']) {
      const r = m.parseText(t);
      console.log(t, '→', r.courses.map(c=>c.name), r.sessions.map(s=>[s.teacher,s.location]));
    }})"
  ```

- **期望 vs 实际**：

  | 输入 | 期望课程名 | 实际课程名 | 实际教师 / 地点 |
  |---|---|---|---|
  | `… 高数 教三-101 王老师 1-16周(单)` | `高数` | **`王老师`** | `高数` / `教三-101` |
  | `… 大学英语 主楼-410 Sarah 1-16周` | `大学英语` | **`Sarah`** | `大学英语` / `主楼-410` |
  | `… 大学物理 沙河校区-教学楼A101 李明 1-16周` | `大学物理` | **`沙河校区-`** | `大学物理` / `教学楼A101`（沙河前缀丢弃） |
  | `… 体育 操场 刘磊 1-16周` | `体育` | `体育` | **`操场`** / `''`（地点被当教师） |

- **影响**：PRD US-3（P0-1"唯一 100% 不依赖页面结构的兜底通道"）在**教师名比课程名长**或**地点不含"教/楼"**时直接产出错数据；生成 .ics 后 `SUMMARY` 变成教师名，日历提醒会显示成"Sarah"。同时 `unrecognized` 为空、`warnings` 为空 —— **没有任何提示**。
- **附带症状**：`高等数学(上)` → `高等数学`（括号被吞）。若同一学期同时存在 `体育(羽毛球)` 与 `体育(篮球)`，会被 `normalize()` 合并成同一门课（`byName` 合并）。

### P0-2 · 文本通道把离散周次 `1-8,10-16周` 截断成 `10-16周`

- **位置**：`src/parsers/html.js:331-334`（`weeksTextFromString` 的单次 `match` 只取第一段可匹配的片段，`1-8` 后跟 `,` 不满足"必须紧跟周字"，正则右移到 `10-16周` 才命中）；调用点 `src/parsers/html.js:547`。
- **复现**：

  ```bash
  node -e "import('./src/parsers/index.js').then(m=>{
    const r = m.parseText('周四 7-8节 体育(羽毛球) 体育馆-2F 刘磊 1-8,10-16周');
    console.log('name=', r.courses.map(c=>c.name), 'weeks=', r.sessions.map(s=>s.weeks), 'raw=', r.sessions.map(s=>s.rawWeeksText));
    const r2 = m.parseText('周一 1-2节 高数 教三-101 1-8,10-16周');
    console.log('name=', r2.courses.map(c=>c.name), 'weeks=', r2.sessions.map(s=>s.weeks));
  })"
  ```
- **期望**：`expandWeeks(session.weeks)` = `[1..8, 10..16]`（15 周），`rawWeeksText` = `1-8,10-16周`。
- **实际**：`weeks = {start:10,end:16,type:'all',extra:[]}`（只有 7 周），`rawWeeksText = "10-16周"`；第二种输入里被截断的残片 `1-8` 还被当成了**课程名**（`name='1-8'`）。
- **影响**：该课在**第 1–8 周直接从课表消失** → 学生不去上课，且 App 不会报任何错。这正是 TASKS §4 里点名要防的"静默错误"。**应用自带的 `SAMPLE_TEXT`（`src/ui/components.js:420`）就用了这个写法**，点"一键填充示例数据"再导入即 100% 复现。

### P0-3 · 自带示例数据端到端导入结果与示例文本不符

- **位置**：P0-1 + P0-2 的组合效应，入口 `src/ui/components.js:414-421`（`SAMPLE_TEXT`）→ `src/ui/import.js` → `src/parsers/index.js:parseText`。
- **复现**：`node --test tests/qa-parsers-adversarial.test.mjs`（用例"应用自带示例数据（SAMPLE_TEXT）导入后课程名必须与示例一致"）。
- **期望课程名**：`高等数学(上) / 大学物理(下) / 数据结构 / 大学英语 / 概率论与数理统计 / 计算机网络 / 体育(羽毛球) / 毛概`
- **实际课程名**：`["高等数学","大学物理","数据结构","Sarah","概率论与数理统计","计算机网络","体育馆-2F","毛概"]`
- **影响**：这是用户点一下就能看到的路径，也是 PRD 成功指标"首次导入成功率 ≥90%"的正面校验样本。

### P1 · 嵌套 `<table>` 导致整表课程静默丢弃

- **位置**：`src/parsers/html.js:212`（`/<table[^>]*>([\s\S]*?)<\/table>/gi` 非贪婪，从最外层 `<table>` 匹配到**内层** `</table>` 就结束），外层表格剩余行/兄弟单元格全部丢失。
- **复现**：

  ```bash
  node -e "import('./src/parsers/html.js').then(m=>{
    const html='<table><tr><th>节次</th><th>周一</th><th>周二</th><th>周三</th></tr>'
      +'<tr><td>第1节</td><td><table><tr><td>内层高等数学 1-16周</td></tr></table></td>'
      +'<td>大学物理<br>1-16周</td><td>大学英语<br>1-16周</td></tr></table>';
    const r=m.parseJwgl(html);
    console.log('sessions=', r.sessions.length, 'unrecognized=', JSON.stringify(r.unrecognized));
  })"
  ```
- **期望**：`大学物理`、`大学英语` 被解析（至少进入 `unrecognized`，PRD §8 E2"绝不静默丢弃"）。
- **实际**：`sessions = []`，`unrecognized = [{reason:'MISSING_NAME', raw:'内层高等数学 1-16周'}]` —— 兄弟单元格两门课**无声消失**，且顶层仍被判定为"解析成功流程走完"。
- **影响**：真实教务系统页面常用嵌套布局表包裹课表；一旦命中，用户会看到"导入成功但课表少一半"，且没有未识别行可补录。

### P2 · 同日 `roomChange` + `reschedule` 叠加时 `original` 被中间值覆盖

- **位置**：`src/calendar.js:62`（`ADJ_PRIORITY = {cancel:0, roomChange:1, reschedule:2, makeup:3}`）+ `src/calendar.js:301`（reschedule 里无条件 `target.original.location = target.location`，此时 `location` 已被 `roomChange` 改成新值）。
- **复现**：`node --test tests/qa-calendar-truth.test.mjs`（用例"同一天 roomChange 与 reschedule 叠加时…"）。
- **期望**：`original.location = '教三-201'`（调课前原值），课表显示"教三-201 → 教四-105"。
- **实际**：`original.location = '教四-105'`，UI 会渲染成"教四-105 → 教四-105"（PRD US-12 AC4 的原值对照失效）。
- **建议方向**：只在 `original.location == null` 时记录，或改为从 `sessions` 侧取权威原值（`baseClass` 里带 `session.location`）。

### P2 · F3（只给时间）反查节次只出单节，结束时间被丢弃

- **位置**：`src/parsers/html.js:308-326`（`periodsFromTimes` 恒返回 `{startPeriod: i, endPeriod: i}`），调用点 `src/parsers/html.js:541`。
- **复现/实际**：`周一 08:00-09:35 线性代数 教三-102 张老师 1-16周` → `startPeriod=1, endPeriod=1`，`09:35` 丢失，连堂课被压成一节。
- **期望**：按 PRD §9 Q2 的建议"反查最近节次并提示用户确认"；至少应把 `08:00-09:35` 落成第 1-2 节，或在 `warnings` 里提示"已按第 1 节处理，请核对"。
- **影响**：只影响"仅给时间"的输入形态，当前无 UI 提示，属数据精度损失。

### P2 · 表头星期列少于 3 个时整表被判"未找到课表"

- **位置**：`src/parsers/html.js:598`（`if (hits >= 3)`）。
- **实际**：只含 `周一/周二` 两列（例如只上周四、周五的实验课/短学期）的表格 → `NO_COURSE_FOUND` + "未找到课表表格"。
- **影响**：小概率，且失败是显式的（有提示，不静默），故列 P2。

### P2（隐患排查，当前无可达注入路径） · `emptyState(desc)` 不转义

- **位置**：`src/ui/components.js:293`（`<p>${desc}</p>`）。
- **说明**：`title` 走 `escapeHtml`，`desc` 与 `actionsHtml` 原样插入。当前**所有调用点的 `desc` 都是代码内常量**，因此不可被用户输入触达；但这是全文件唯一一处"参数名像用户数据却未转义"的位置，建议补 `escapeHtml(desc)` 以防后续有人把课程名传进来。
- **状态**：第 2 轮已修（`title` 与 `desc` 均转义，见 §1.1）。

---

### 3.9 已知问题（第 2 轮新发现，**不阻塞交付，本轮不修**） · HTML 单元格里课程名含「实验」会被当成地点

- **位置**：`src/parsers/html.js` 的 `tagLine()` 中 `RE_LOCATION`（词表含 `实验`）。
- **复现**：

  ```bash
  node -e "import('./src/parsers/html.js').then(m=>{
    const h='<table><tr><th>节次</th><th>周四</th><th>周五</th></tr>'
      +'<tr><td>第1-2节</td><td>大学物理实验<br>1-16周</td><td>讲座<br>1-8周</td></tr></table>';
    const r=m.parseJwgl(h); console.log(r.sessions.map(s=>s.name), r.unrecognized.map(u=>u.reason))})"
  # 实际：[ '讲座' ] [ 'MISSING_NAME' ]
  ```

- **影响**：`大学物理实验` / `电路实验` / `数据结构实验(上)` 这类北邮真实课名，在 **HTML 单元格通道**会被整格判为 `location`，课程进「未识别行」需用户手工补录（文本通道正常）。**不是静默丢失**（导入预览页会列出来、可补录），故 P2。
- **建议**：`RE_LOCATION` 里的 `实验` 改为 `实验楼|实验中心`，或在 `tagLine` 判为 `location` 且该行是单元格唯一文本时降级为 `text`。

### 3.10 已知问题（第 2 轮新发现，**不阻塞交付，本轮不修**） · 周次与后续中文无分隔时识别不到

- **位置**：`src/parsers/html.js` 的 `WEEK_EXPR_RE`（lead 本次新增的 `周(?![\u4e00-\u9fa5])` 右边界）。
- **复现**：`parseText('周一 1-2节 高数 教三-101 王老师 1-16周体育')` → 周次回退整学期 1-20 周、课程名变成 `1-16周体育`。
- **影响**：仅在「周次后紧跟中文且**完全没有分隔符**」时触发（教务/企微导出的文本与单元格都有空格或 `<br>`，`SAMPLE_TEXT` 与 8 种写法均正常）。
- **为什么接受这个代价**：去掉该右边界会回退到更常见的缺陷——任何姓「周」的教师（`教三-101 周宏`）都会被吃成周次。两害相权取前者。
- **建议**（若后续要收）：把右边界从"禁止中文"改为"禁止 `[\u4e00-\u9fa5]` 但允许紧跟课程名"很难；更稳的做法是要求周次片段前一个字符是分隔符/行首（左边界收紧），右边界改为 `(?=$|[\s,，、;；/|（）()]|[\u4e00-\u9fa5])` 并**同时**要求左边界必须是非数字非字母且前后有成对数字——即用"两端边界 + 结构"替代单侧否定。

---

## 4. 质量门禁原始输出与退出码（第 1 轮基线；第 2 轮输出见 §1.1）

> 门禁脚本：`.gate-notice.mjs`（G14）、`.gate-copy.mjs`（G18）按 `docs/TASKS.md §3` 参考脚本逐字实现；`.gate-shape.mjs`（G16）为工程师已有版本，本轮独立复跑。全部为**运行时断言**（import 模块后校验导出对象），无 grep/sed 推断。

```
$ node --test "tests/**/*.test.mjs"
# tests 165
# suites 0
# pass 157
# fail 8
# cancelled 0
# skipped 0
# todo 0
# duration_ms 796.7914
exit=1                      ← G1：RED（8 条真实缺陷，见 §3）
```

```
$ node .gate-notice.mjs
GATE14: PASS
  7 keys, all functions
exit=0

$ node .gate-copy.mjs
GATE18: PASS
  8 样本，文案与状态全部符合
exit=0

$ node .gate-shape.mjs
GATE16: PASS
  9 字段齐全 / status ∈ 7 值 / 4 个样本语义正确 / NOTICE 7 键全函数 / plan 对象齐全
exit=0
```

**负向对照（证明门禁不是空转）**：把三个门禁脚本复制到 `/tmp/neg`，配一个"旧契约 + 漏一个 NOTICE 键"的桩模块后重跑：

```
$ node .gate-notice.mjs      → GATE14: FAIL
                               missing=["unconfigured"] ; extra=[] ; notFunction=[]     exit=1
$ node .gate-copy.mjs        → GATE18: FAIL
                               8 个样本 status=undefined（样本没走到目标分支，断言会平凡通过）  exit=1
$ node .gate-shape.mjs       → GATE16: FAIL
                               …缺字段 9 个 / NOTICE 键集合不一致 / makeup_skipped 两来源文案相同   exit=1
$ rm -rf /tmp/neg/src && node .gate-shape.mjs
                             → GATE16: BROKEN 模块加载失败 → Cannot find module …   exit=2
```

其余门禁：

| 门禁 | 方法 | 原始结果 | 结论 |
|---|---|---|---|
| G2 纯逻辑无 DOM | `grep -nE "document\|window\|localStorage\|navigator" src/model.js src/holidays.js src/calendar.js src/ics.js src/parsers/*.js` | 仅 2 处**注释**命中（`model.js:4`、`holidays.js:4`） | PASS |
| G3 UI 不自算日期 | `grep -rnE "getDay\(\|getUTCDay\(\|% ?2\|weekNoOf\|new Date\(" src/ui/` | 0 命中 | PASS |
| G4 零外链 | 见 §2 | 0 命中 | PASS |
| G5 ICS 合规 | `qa-ics-store-security` 4 条用例（无裸 UTC / 含 VTIMEZONE / 全 CRLF / 每行 ≤75 字节） | 全绿 | PASS |
| G6 sessions 只读 | 2 条用例（`ADD_ADJUSTMENT` 与 `SET_MAKEUP_FOLLOW` 前后 `JSON.stringify` 相等） | 全绿 | PASS |
| G8 零依赖 | `qa-ics-store-security`（`package.json` 无 dependencies/devDependencies、`type:module` 未被改） | 全绿 | PASS |
| G9 真相函数不被绕过 | `grep -rn "resolveClasses(\|classifyDay(" src/ \| grep -v calendar.js` | 0 命中 | PASS |
| G10 `complete` 纪律 | 逐点审查 `src/ui` 全部 `classes` 用法：`timetable.js:184/276/581` 为遍历/查找，`265`（`day.complete && day.classes.length === 0`）与 `320`（`day.complete ? … : 0`）均带 `complete` 判据 | 无裸判结论 | PASS |
| G11 补班数据未被猜测 | 独立复核：33 放假日 / 6 补班日；`2026-01-04→5` 且 `inferred:true`，其余 5 条全 `null`；6 个补班日真实星期与 PRD 附录 A.2 逐条一致；春节 9 天、中秋国庆不连休（09-28~30 未入假期） | `auditBuiltinHolidays()` → `{ok:true, errors:[]}` | PASS |
| G12 计划对象未被当数组 | `grep -rn "const points = getReminders" src/` | 0 命中 | PASS |
| G13 导出告警未被吞 | 用例断言 `result.warnings.length>=1` 且每条 warning 文本**不出现在** `result.text` 中；`reminderView.js:463-471` 确消费 `result.warnings` | 全绿 | PASS |
| G15 未确认态 fail-closed | 2 条用例（`10-10` / `09-20` + `mode='skip'` 反例） | 全绿 | PASS |
| G17 UI `classes.length` 反向门禁 | `grep -rn "classes\.length *=== *0\|\.classes\.length\b" src/ --include=*.js \| grep -v calendar.js` → 3 命中：1 条注释、2 条合法（`265`/`320` 同行有 `complete`） | 合规 | PASS |
| G7 离线可用 | 仅验到 HTTP 200（见 §2）。**断网刷新需浏览器/真机，本轮未验** | 未验 | 见 §5 |

---

## 5. 遗留风险（真机 / 浏览器才能验，本轮覆盖不到）

1. **ColorOS 日历实际导入后的时区**：`.ics` 的 `DTSTART;TZID=Asia/Shanghai` + `VTIMEZONE` + `DTSTAMP:…Z` 结构已静态验对，但"导入系统日历后是否整体偏移 8 小时"必须真机导入一次才成立（PRD §4 技术风险 3）。
2. **应用内通知的到达率**：后台定时器被 ColorOS 杀掉属结构性限制，catch-up（回前台补发 5 分钟）逻辑无法在纯 Node 环境验证，需真机前后台切换实测。
3. **PWA 可安装性与离线首屏**：manifest 字段与 SW 预缓存清单已静态验（7 个文件全 200、`purpose` 含 `maskable`），但"添加到主屏幕 → 断网刷新"需真机；Lighthouse PWA 项未跑。
4. **真实页面抓取**（PRD Q3）：企业微信 H5 若为接口渲染，源码里可能根本没有课表数据——本轮只用内联 fixture 验证解析器逻辑，未验真实页面。
5. **UI 渲染层无运行时验证**：项目零依赖（无 jsdom），`renderTimetable` / `renderDetail` / 三个 Tab 的 DOM 输出、触摸区尺寸、`safe-area` 表现、`sheet`/`snackbar`/`confirmDialog` 交互，本轮只做了**静态审查 + 纯函数断言 + 转义断言**。建议工程师按 TASKS §T6/§T7 验收点在浏览器手工冒烟一遍（尤其是待确认卡的 8 选 1、撤销 Snackbar 5 秒、导出前告警弹窗）。
6. **2026 年 5 个补班日的真实口径**（PRD Q4）：`02-14 / 02-28 / 05-09 / 09-20 / 10-10` 内置为 `null` 是**正确**的（不得猜），但产品上意味着用户要自己点 5 次；拿到北邮 2026 校历后应预填并保留可改。
7. **`JOURNEY` 未验**：`getWeekView` / `getNowMarker` / `getNextClass` 等 UI 辅助函数本轮只做间接覆盖（`resolveDay` 正确性）；跨零点节次与红线位置的组合未做专项断言。

---

## 6. 本轮自身修正记录（透明起见）

写测试过程中我自己的 3 处错误，均在提交前修好，**没有放宽任何断言**：

1. `weeksOf()` 辅助函数一开始直接读 `session.weeks`，但适配器输出的是 `weeksText`（原文），`normalize()` 之后才有 `weeks` → 改为两者兼容（否则会把"实现正确"误报成失败）。
2. 文件头注释里写了 `tests/**/*.test.mjs`，其中的 `*/` 提前闭合了块注释 → 改为不含 `*/` 的表述。
3. manifest 断言一开始把 `short_name` 写成 `北邮课程表`（实际 `北邮课表`，`name` 才是全名）→ 按实际契约改为校验 `name` 全名 + `short_name` 非空 + 192/512 + `maskable`。

---

## 7. 复现方式

```bash
cd D:/bupt-schedule

# 全量（工程师原有 + lead 回归 + QA 对抗，共 180 条）
node --test "tests/**/*.test.mjs"

# 只看 QA 新增的四组（第 2 轮起全绿）
node --test tests/qa-parsers-adversarial.test.mjs     # 17 条
node --test tests/qa-calendar-truth.test.mjs          # 33 条
node --test tests/qa-ics-store-security.test.mjs      # 25 条
node --test tests/qa-week-boundary.test.mjs           # 10 条（第 2 轮补：周/周次歧义等边界）

# 门禁
node .gate-notice.mjs    # G14
node .gate-copy.mjs      # G18
node .gate-shape.mjs     # G16
```

> 注意命令形式必须是目录 glob 形式 `"tests/**/*.test.mjs"`（带引号）；直接传目录在 Node 22 + Windows 下会 `MODULE_NOT_FOUND`。

---

## 8. 路由判定

```text
ROUTE: NOBODY
```

**第 2 轮（最终回归）全绿**：`180 tests / 180 pass / 0 fail / exit 0`，G14/G16/G18 三道运行时门禁全 `PASS`（exit 0）。第 1 轮报出的 8 条缺陷已逐条独立复核修复（§1.1），修复没有引入回归——原有 90 条、`sessions` 只读、`classifyDay` 五步顺序、`getReminders` 计划对象、ICS 的 TZID/UID/折行、34 项存储健壮性断言全部保持绿色。

剩余 2 条 **P2 已知问题**（§3.9 「实验」词表、§3.10 周次紧贴中文）已记录在案，均**不阻塞交付**、有可用的用户侧补救路径（未识别行可补录 / 回退整学期），按"两轮硬上限"纪律不再开修复轮。

另需产品侧收敛的遗留项（非代码缺陷）：`2026` 年 5 个调班日仍为 `null` 待北邮校历确认（PRD Q4）；ColorOS 真机的日历导入时区、后台通知到达率、PWA 断网刷新与 UI 渲染交互仍需真机/浏览器验收（见 §5）。

---

## 9. 交付总监收尾（第 2 轮之后，2026-10-22）

第 2 轮结论为 `ROUTE: NOBODY`，但交付总监在抽查单元格解析时发现 **2 条 QA 未覆盖的残留**，已直接修复并补回归用例（`tests/lead-regression.test.mjs`，共 9 条），当前基线 **183 tests / 183 pass / 0 fail**，G14/G16/G18 仍 exit=0。

| # | 原问题 | 根因 | 修复 | 用例 |
|---|---|---|---|---|
| 1 | §3.9 记录为"P2 不修"的「实验」词表问题 | `RE_LOCATION` 里 `实验`/`中心` 单独立项，`大学物理实验` 整格被判为地点 | 收窄为 `实验楼\|实验中心`（`中心` 保留），课程名重新成为课程名 | `课程名里的「实验」不得让整格被判成地点` |
| 2 | **新发现（P1，静默脏数据）**：单元格末行的纯中文人名被当成第二门课 | `splitMultiCourse` 在「已攒够骨架」时无条件 `flush` 并新起一条 | 末行短词若像人名（2–4 汉字、或拉丁名、或有称谓后缀）则记为教师 | `单元格末行的纯中文人名是教师，不是第二门课` |

第 2 条的危害：`高等数学(上)<br>1-16周<br>教三-101<br>王建民` 会产出 **两条课次**——一条正确，一条名叫「王建民」、无时间无地点的幽灵课程，界面上真实出现且不报错。修复后同一格两门课（`高数…物理…`）仍正确拆成两条，已用用例锁住，防止矫枉过正。

结论：**无未关闭的 P0/P1**；剩余为真机验证项（ColorOS 日历时区、后台通知到达率、PWA 可安装性、UI 渲染手工冒烟）与产品口径项（2026 年 5 个补班日待校历）。
