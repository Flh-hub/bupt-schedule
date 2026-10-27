# 修改方案：「我已开启」无检测 + 电池优化跳错页面

> 版本：针对 1.65.0（VERSION_CODE 71）｜ 编写日期：2026-10-25
> **状态：已实现并打包 → `android/dist/bupt-schedule-1.66.25.apk`（versionCode 97）**

---

## 0.26 1.66.25：定稿 3×2

用户确认要的是 **3×2**（不是 4×3）。

| 尺寸 | 宽度 | 文字区 | 结论 |
|---|---|---|---|
| 2×2 | 110dp | 81dp | 第二行被截断，节次看不到 |
| **3×2** | **180dp** | **151dp** | **第二行完整放得下（24 字符 ≈ 120dp），定稿** |
| 4×2 / 4×3 | 250dp | 230dp | 信息也完整，但宽了一格 |

`CHROME_DP` = 42 → `(110-42)/32 = 2.1` → 2 行。
行版式仍是「课名一行 + 时间/地点/节次一行」。

验证：`npm test` 440/440；`aapt2 dump` 确认 180/110dp、targetCell 3×2；已装真机（1.66.25）。

---

## 0.25 1.66.24：定稿 4×3

试过 2×2 → 4×2 → 最终 4×3。取舍：

| 尺寸 | 宽度 | 文字区 | 结论 |
|---|---|---|---|
| 2×2 | 110dp | 81dp | 第二行 `13:00 · 智慧教学楼-117 · 第6-7节` 被截断，节次看不到 |
| 4×2 | 250dp | 230dp | 一行信息完整，但只放得下 2 门课 |
| **4×3** | 250dp | 230dp | **信息完整 + 放 4 门课**，定稿 |

`CHROME_DP` = 42 → `(180-42)/32 = 4.3` → 4 行，刚好装下上午 4 节。
行版式仍是「课名一行 + 时间/地点/节次一行」，不用再改。

验证：`npm test` 440/440；`aapt2 dump` 确认 250/180dp、targetCell 4×3；已装真机（1.66.24）。

---

## 0.24 1.66.23：默认改 4×2（试尺寸）

2×2 真机验证可用了（截图确认：课名一行、时间地点一行都正常），
但第二行 `13:00 · 智慧教学楼-117 · 第6-7节` 有 24 个字符，
2 列只有 81dp 文字区（约 13 个半角），节次被截成「…」。

4×2 是 250dp：文字区 230dp，第二行完整放得下，也不用再压缩信息。
行版式（上下两行）保持不变 —— 它在 2~5 列任何宽度下都成立，不需要再分叉。

| 项 | 2×2 | 4×2 |
|---|---|---|
| `minWidth` | 110dp | **250dp** |
| `minHeight` | 110dp | 110dp |
| `targetCell` | 2×2 | **4×2** |
| 可拖 | 纵向 1~5 行 | **横向 2~4 列、纵向 1~5 行** |

验证：`npm test` 440/440；`aapt2 dump` 确认 250/110dp、targetCell 4×2；已装到真机（1.66.23）。

---

## 0.23 1.66.22：默认 2×2，行版式跟着改

2 列只有 **110dp** 宽，减掉左右内边距（20dp）和色条（9dp）只剩 **81dp** 给文字。
原来"左侧固定 42dp 时间列 + 右侧课名"的版式，课名只剩 39dp ≈ 3 个字，必须改版。

### 行版式：从"左右"改成"上下"

```
旧：[色条] [8:00] [高等数学（上）      ]
                [教三-201 · 第1-2节  ]

新：[色条] [高等数学（上）           ]
           [8:00 · 教三-201 · 第1-2节]
```

- 课名独占一行，拿到全部 81dp；
- 时间从固定列改成第二行的开头，由 Java 拼 `时间 · 地点 · 节次`（`tail` 变量）；
- `w_row_time` 仍然保留 id（RemoteViews 里 `setTextViewText` 一个不存在的 id 会在桌面进程抛异常）。

### 头部窄屏适配

`widgetWidthDp(ctx, widgetId)` 读 `OPTION_APPWIDGET_MAX_WIDTH`，
小于 150dp 时头部只写「今天」，不再拼「· 10月26日」—— 否则会被截成「今天 · 10月…」。

### 尺寸

| 项 | 值 |
|---|---|
| `minWidth` / `minHeight` | 110dp（2 列）/ 110dp（2 行） |
| `targetCellWidth` / `Height` | 2 / 2 |
| `minResizeWidth` / `Height` | 110dp（横向已到底）/ 70dp（1 行） |
| 左右内边距 | 12dp → **10dp** |

`CHROME_DP` 仍是 42：`(110-42)/32 = 2.1` → 正好 2 行。

验证：`npm test` 440/440；真机 `logcat` 无 `InflateException`。

---

## 0.22 1.66.20 / 1.66.21：真凶是 `<View>`，尺寸是背锅的

### 抓到日志了

用户同意接 USB 后，`adb logcat` 一次就抓到：

```
W/AppWidgetHostView: android.view.InflateException: Binary XML file line #14
  in com.bupt.schedule:layout/widget_row: Error inflating class android.view.View
Caused by: android.view.InflateException: Class not allowed to be inflated android.view.View
  at android.view.LayoutInflater.failNotAllowed(LayoutInflater.java:810)
  at android.widget.RemoteViews$ViewGroupActionAdd.insertNewView(...)
```

`widget_row.xml` 第 14 行那个 3dp 的课程色条用了 `<View>`。
**RemoteViews 只允许 inflate 带 `@RemoteView` 注解的类**（TextView / ImageView /
LinearLayout / FrameLayout …），裸的 `android.view.View` 不在白名单里，桌面进程直接拒绝。

### 为什么"以前能用"

22:41 那张截图是**「今天没课」**：`w_rows` 隐藏，`widget_row` 根本没被 inflate，
这个雷一直没踩到。今天有课 → 要画课程行 → 一 inflate 就炸。

**这也解释了 1.66.12 之后的所有迷惑现象**：改尺寸、删 previewLayout、换 initialLayout、
清桌面缓存、重启、卸载重装 —— 全都没用，因为问题根本不在那儿。
我在尺寸上连试了 7 个版本，是彻底的误判。

### 修法

```xml
- <View android:id="@+id/w_row_bar" ... />
+ <TextView android:id="@+id/w_row_bar" ... />
```

宽度 3dp、无文字，视觉完全一致，`setInt(..., "setBackgroundColor", ...)` 照常生效。

**防线**：`widget.test.mjs` 新增一条 —— RemoteViews 布局里出现 `<View>` 就报错
（先剥掉 XML 注释再检查，注释里写「不能是 `<View>`」不算违规）。

### 1.66.21：默认尺寸改成 3×2

既然尺寸从来不是问题，就可以放心调：

| 项 | 值 |
|---|---|
| `minWidth` / `minHeight` | 180dp（3 列）/ 110dp（2 行） |
| `targetCellWidth` / `Height` | 3 / 2 |
| `minResizeWidth` / `Height` | 110dp（2 列）/ 70dp（1 行） |

同时把 `CHROME_DP` 从 48 改成 **42**（= 标题栏 26 + 上下内边距 16）：
留 6dp"安全余量"会让 110dp 的 2 行小组件只算出 1 行，白白浪费一半高度。

验证：`npm test` 439/439；`aapt2 dump` 确认 180/110dp、targetCell 3/2；
装到真机后 `logcat` 里再无 `InflateException`；`dumpsys appwidget` 能看到
`id=20 provider=com.bupt.schedule/...CourseWidget` 实例已注册。

---

## 0.21 1.66.19：小组件配置 100% 还原到 1.66.11

用户确认"是先打开 App 再退出、然后添加的"，所以 stopped 状态也不是原因。
不再猜了，直接把小组件相关的一切还原成 **22:41 那张能用截图** 对应的版本，并逐字节验证：

```
aapt2 dump xmltree --file res/xml/course_widget_info.xml  1.66.11 vs 1.66.19
  → 13 个属性、资源 id 全部相同

aapt2 dump xmltree --file res/layout/widget_course.xml    1.66.11 vs 1.66.19
  → diff 无差异
```

还原的四处（都是 1.66.12~1.66.18 期间我自己改的）：

| 项 | 改过 | 现在 |
|---|---|---|
| `minHeight` / `targetCellHeight` | 110dp / 2 | **180dp / 3** |
| `minResizeWidth` / `minResizeHeight` | 110 / 70 | **180 / 110** |
| `previewLayout` | 删除过 | **恢复** |
| `initialLayout` | 换成 widget_min | **恢复 widget_course** |
| 标题栏 / 内边距 / `CHROME_DP` | 22dp / 10·6dp / 40 | **26dp / 12·8dp / 48** |

保留的两样（都不影响渲染路径）：`widget_min.xml` 只在兜底 `minimal()` 里用；
`onCreate` 里的 `CourseWidget.refreshAll(this)` 只是提前重绘一次。

### 这一轮的结论

**小组件的这几个配置项，在 ColorOS 16 上一改就炸，而且炸了之后清缓存/重启/重装都救不回来。**
以后再要调外观，只动布局内部的文字/字号/行数，不碰 `minWidth/minHeight/minResize*/targetCell*/preview*/initialLayout`。
这条已经写进 `course_widget_info.xml` 的注释和测试。

验证：`npm test` 438/438。

---

## 0.20 1.66.18：清桌面数据也没用 → 是 stopped 状态

1.66.17 把 `initialLayout` 换成了 `<LinearLayout><TextView/></LinearLayout>`，
用户清完桌面数据**仍然报错**。到这一步可以排除布局：那个布局不可能 inflate 失败。

### 真正的原因：sideload 装完，应用处于 stopped 状态

Android 规定：应用**安装后必须被用户启动过一次**，才退出 stopped 状态。
在 stopped 状态下：

- 收不到 `MY_PACKAGE_REPLACED`、`APPWIDGET_UPDATE` 等广播；
- 桌面因此拿不到任何 RemoteViews，`AppWidgetHostView` 超时后显示
  「载入窗口小部件时出现问题」；
- **清桌面数据、重启都没用** —— 因为缺的不是桌面缓存，是应用没跑过。

这解释了全部现象：为什么同一个包有人正常有人报错，为什么清缓存无效。

### 修法

`MainActivity.onCreate` 里主动 `CourseWidget.refreshAll(this)`：

```java
// 装完新包第一次启动时，把桌面小组件立刻重画一遍。
// sideload 安装后应用处于 stopped 状态，连 MY_PACKAGE_REPLACED 都收不到 ——
// 桌面拿不到任何 RemoteViews，「添加小组件」界面就会显示「载入窗口小部件时出现问题」。
try { CourseWidget.refreshAll(this); } catch (Throwable ignored) {}
```

### 正确的使用顺序

**装包 → 打开一次 App（看到课表）→ 回桌面添加小组件。**
跳过头一步，任何版本都会报那个错。

验证：`npm test` 439/439；dex 内 `refreshAll` 存在、`widget_min.xml` 已打包。

---

## 0.19 1.66.17：报错的是「添加小组件」界面的预览

用户截图显示：报错发生在 **添加小组件（选择器）界面**，不是桌面实例。
那一屏画的是 `initialLayout`（`onUpdate` 还没跑），也就是**我们的复杂布局在桌面进程里 inflate 失败**。

### 联网查到的

中文社区对「载入窗口小部件时出现问题」的答案高度一致，且都是**桌面侧**：

1. 设置 › 应用 › 应用管理 › **桌面（OPPO 桌面）** › 存储 › **清除数据**；
2. 重启手机；
3. 重新添加小组件。

也就是说：这个错误多半是**桌面缓存坏了**，不是应用代码每次都必错 ——
否则不会出现"同一个包，有人正常有人报错"。

### 代码侧的两道保险（1.66.17）

1. **`initialLayout` 换成 `widget_min`**（一个 `LinearLayout` + 一个 `TextView`）。
   选择器预览和首绘画的都是 `initialLayout`；换成极简布局后，
   即使桌面渲染失败也只会显示一张朴素的占位卡，**不会再抛系统错误块**。
   真正内容仍由 `onUpdate` 用 `widget_course` 画，添加后一瞬间替换。
2. **尺寸契约整体退回 1.66.11**：`minResizeWidth/Height` 也回到 180/110dp。
   现在 `course_widget_info.xml` 与 1.66.11 的差别只剩
   "去掉 previewLayout + initialLayout 换成极简布局"。

验证：`npm test` 437/437；`aapt2 dump resources` 确认 `initialLayout → 0x7f040001 = layout/widget_min`。

---

## 0.18 1.66.16：默认尺寸退回 4×3（止损）

1.66.15 去掉了 `previewLayout` 并加了极简兜底，**仍然报错**。说明问题不在预览、也不在布局复杂度，
而在 **1.66.12 改动的那三个尺寸契约本身**（`minHeight` 180→110、`targetCellHeight` 3→2）。

两次尝试都失败，就不该再赌。这一版把默认尺寸**原样退回** 1.66.11 的状态：

| 项 | 1.66.12（坏） | 1.66.16（回退） |
|---|---|---|
| `minHeight` | 110dp | **180dp** |
| `targetCellHeight` | 2 | **3** |
| `minResizeWidth` | 110dp | 110dp（保留，可拖窄） |
| `minResizeHeight` | 70dp | 70dp（保留，可拖矮） |
| `previewLayout` | — | 仍然去掉 |
| 极简兜底 `widget_min` | — | 保留 |

也就是说：**默认还是 4×3，但你可以自己拖小**（最少能缩到 1~2 行）。
想更小的诉求用"手动缩放"满足，而不是改默认值 —— 后者会连带把已放置的实例搞坏。

### 教训（写进代码注释了）

改 appwidget 的 `minWidth/minHeight/targetCell*` 会**影响所有已放置的实例**，
而 RemoteViews 的失败发生在**桌面进程**，应用侧 `try/catch` 兜不住 ——
一旦踩雷，用户看到的就是"载入窗口小部件时出现问题"，且删掉重拖也不一定救得回来。
以后要改外观就改布局内部（padding/字号/行高），别动尺寸契约。

验证：`npm test` 436/436；`aapt2 dump` 确认 `minHeight=180dp / targetCellHeight=3`、
`previewLayout` 不存在、`minResizeHeight=70dp` 仍在。

---

## 0.17 1.66.15：小组件「载入窗口小部件时出现问题」

1.66.12 把默认尺寸从 4×3 改成 4×2 之后，桌面上报了这个错。

### 排查过程

| 检查项 | 结论 |
|---|---|
| `widget_course.xml` / `widget_row.xml` / `course_widget_info.xml` 合法性 | XML 都合法 |
| 布局结构 diff（1.66.11 vs 1.66.14） | 只有标题栏 26→22dp、内边距 12/8→10/6dp，结构完全一致 |
| `R.id.*` 是否都能在布局里找到 | 10 个 id 全部存在，无缺失 |
| dex 里 `CourseWidget` / `ClassRefreshService` | 都在 |
| 清单里的 `APPWIDGET_UPDATE` receiver | 完好 |
| `MY_PACKAGE_REPLACED` 会不会重绘 | 会（`ReminderReceiver` 里已调 `CourseWidget.refreshAll`） |

代码侧本来就是防御性的（`safeRender` 会 catch 并退化成空状态卡），所以问题不在我们的进程里 ——
**是桌面进程 apply RemoteViews 失败**，那边的异常我们 catch 不到。

### 两条同时下的修复

1. **去掉 `previewLayout`**（1.66.12 之前就有，但 4×2 之后触发了）。
   ColorOS 16 的选择器/首帧在渲染它时直接报错。改回 `previewImage`（静态图，一直可用）。
   代价：选择器里看不到实时预览，拖到桌面后立刻就是真的。
2. **加第三层兜底 `widget_min.xml`**：只有一个 `LinearLayout` + 一个 `TextView`。
   `safeRender` 现在是 `build → fallback → minimal` 三层，
   布局越简单，桌面越不可能 inflate 失败。

> ⚠️ **已经坏掉的那个实例不会自愈** —— 桌面上存的是坏掉的那份 RemoteViews。
> 请长按删掉，再重新拖一个。新拖出来的会用新配置。

验证：`npm test` 436/436；APK 内 `previewLayout` 已消失、`previewImage` 保留、
`widget_min.xml` 已打包、`minHeight=110dp / targetCellHeight=2` 未变。

---

## 0.16 1.66.14：文案去掉「还有」

一句话改动：`"还有" + mins + "分钟上课"` → `mins + "分钟后上课"`。

| 剩余 | 显示 |
|---|---|
| 4:30 | 5分钟后上课 |
| 3:59 | 4分钟后上课 |
| 0:00 | 马上上课 |
| ≥60 分钟 | N小时后上课 |

取整规则和整分钟边界刷新（`nextBoundaryDelay`）都不变，只是少了两个字。
测试里加了一条 `assert.equal(/"还有"/.test(cc), false)`，防止以后又被加回来。

验证：`npm test` 434/434；dex 内 `还有` 已不存在，`分钟后上课` 存在。

---

## 0.15 1.66.13：胶囊文案改成「还有N分钟上课」

1.66.12 把胶囊换成了系统 chronometer（`02:45`），准但不好读。用户要求改回文字，
并明确了取整规则：

| 剩余 | 显示 |
|---|---|
| 4:30 | 还有5分钟上课 |
| 3:59 | 还有4分钟上课 |
| 0:00 | 马上上课 |
| ≥60 分钟 | 还有N小时上课 |

也就是**向上取整**（只要还有零头分钟就进一位）——「最晚 N 分钟后上课」的安全读法。

### 关键：换字必须落在整分钟边界

文字形式的老问题是"靠定时器轮询，换字会晚"。原来 `ClassRefreshService` 每 15 秒
重发一次通知，文字最多滞后 15 秒；现在改成**睡到下一个边界**：

```java
static long nextBoundaryDelay(long startEpoch, long now) {
    long ms = startEpoch - now;
    if (ms <= 0) return 0L;
    long mins = (ms + 59_999L) / 60_000L;            // 当前显示的分钟数
    long nextAt = startEpoch - (mins - 1) * 60_000L; // 数字变成 mins-1 的时刻
    ...
}
```

- 换字延迟从「≤15 秒」降到「≈0」；
- 唤醒次数从 4 次/分钟降到 1 次/分钟（省电）；
- `HEARTBEAT_TIMEOUT_MS` 40s → **75s**：两次心跳正常就会隔 50 多秒，
  还用 40 秒会把活着的服务误判成死的，每次回前台白重启一遍。

验算（node 跑同一套公式，从剩 6:00 逐秒走到 0:00）：

```
360s -> 还有6分钟上课
300s -> 还有5分钟上课
240s -> 还有4分钟上课
...
 60s -> 还有1分钟上课
  0s -> 马上上课
剩 4:30 -> 还有5分钟上课   下一次换字延迟 30 秒
剩 3:59 -> 还有4分钟上课   下一次换字延迟 59 秒
```

### 已知取舍

文字版仍然依赖 `ClassRefreshService` 活着（chronometer 不依赖）。
服务被杀时文字会冻住 —— 这是文字形式的固有代价。缓解手段都在：
`START_STICKY` + `restore()` + `ensureAlive()` + 引导「完全后台运行」。

验证：`npm test` 434/434；APK 内 dex 含 `还有` / `分钟上课` / `nextBoundaryDelay`。

---

## 0.14 1.66.12：流体云时间 + 小组件尺寸

### 一、胶囊时间"不准"的两个来源

**① 标题里混进了一个诊断时间（真 bug）**

`ReminderScheduler.buildCard` 以前会给**测试通知**的标题拼上 `@HH:mm:ss`，
本意是肉眼确认刷新链有没有在跑（真机接不了 logcat）。但它显示成
「高等数学（上） @22:39:52」，用户只会把它当上课时间 —— 而那是上一次刷新的时刻。
已删除，标题只留课程名；诊断看 `ClassCard.lastVerdict` / `promoteDiagnostics`。

**② 胶囊和展开卡用了两个时间源**

| 位置 | 原来的时间源 |
|---|---|
| 展开卡 `02:45 距上课` | `setUsesChronometer(true)`，SystemUI 逐秒渲染，**永远准** |
| 胶囊 `3分后上课` | `setShortCriticalText(timeChipText(...))`，发通知时算死，靠 `ClassRefreshService` 每 15 秒重发才更新 |

服务一被杀（哪怕"完全允许后台"也可能被杀），胶囊文字就冻住不动，而展开卡还在正常跳 ——
两个数字对不上，看着就是"不准"。而且 `timeChipText` 是**向上取整**，2:45 会显示「3分后上课」，
和卡片的 `02:45` 又差一档。

改成 `CHIP_USE_CHRONOMETER = true`：胶囊直接用系统 chronometer，和展开卡**同一个时间源**，
不依赖任何后台服务。

> 代价：胶囊显示 `02:45` 而不是「3分后上课」。如果你更想要文字版（能接受服务被杀时冻住），
> 把 `ClassCard.CHIP_USE_CHRONOMETER` 改回 `false` 即可。

### 二、小组件默认尺寸 4×3 → 4×2

| 项 | 原 | 现 |
|---|---|---|
| `minWidth` | 250dp（4 列） | 250dp（4 列） |
| `minHeight` | 180dp（3 行） | **110dp（2 行）** |
| `targetCellHeight` | 3 | **2** |
| `minResizeWidth/Height` | 180 / 110 | **110 / 70**（能拖更小） |
| 标题栏高度 | 26dp | 22dp |
| 内边距 | 12 / 8dp | 10 / 6dp |
| `CHROME_DP`（行数预算） | 48 | 40 |

仍是双向可调：往下拖最多 5 行，往上缩到 1 行。

⚠️ **已经放在桌面上的小组件不会自动变小** —— 启动器记着用户当初放下的尺寸。
要么长按拖边缘缩一下，要么删掉重新拖一个。

验证：`npm test` 433/433；APK 内 `aapt2 dump xmltree` 确认
`minHeight=110dp / targetCellHeight=2 / minResizeHeight=70dp`。

---

## 0.13 1.66.10 / 1.66.11：让"改了"真的看得见

用户反馈「没看到改了啥」，查到两个原因：

### ① WebView 里 `visibilitychange` 不可靠（1.66.10）

Activity 暂停时 WebView 也会被 `onPause`，部分机型回来时不派发 `visibilitychange`，
复查压根没跑。改成**双通道**：

```java
// MainActivity.onResume
web.onResume();
web.evaluateJavascript("window.__buptResume&&window.__buptResume()", null);
```

```js
// main.js：两条路汇到同一个入口，pending 只会被消费一次
window.__buptResume = () => { setTimeout(runReturnCheck, 600); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) window.__buptResume(); });
```

同时补了一个"静默失败"：**三项都开着时也要说一句**。
以前全满足就 `return 'ok'`，用户从设置回来一片安静，根本不知道复查跑过。
现在弹一条 `已复查：通知权限、精确闹钟、后台运行都开着`（2.6 秒）。

### ② 入口开完还一直占着屏幕（1.66.11）

「后台运行」那三条（后台保活设置 / 修改后台运行模式 / 权限一键检查）是**一次性任务**，
但开完还常年挂在提醒页上。现在：

- `onboard.js` 导出 `checklistReady()`，**复用引导那套判定**（`buildSteps` + `requiredPending`），
  两处口径一致，不会出现"引导说开好了、提醒页还在催"。
- 就绪时整组收进一个折叠项 **「后台运行 · 已就绪」**（默认关闭）；
  没就绪时保持原来的平铺三条。
- 没有直接删掉：ColorOS 的「耗电行为控制」系统读不到，用户仍可能需要回去复查。

验证：`npm test` 429/429；`node .probe-perm-fix.mjs` 60/60
（新增：`__buptResume` 已挂载、全开时给"已复查"、不重复提示、就绪收起 / 未就绪平铺）。

---

## 0.12 1.66.9：从系统设置返回 → 按机型复查并弹提示

这些入口点出去都是**离开 App**：用户在系统页改完按返回，回到课表什么反馈都没有，
改没改成只能等下次提醒响不响来赌。现在补上"回来就查一遍"。

### 触发条件（只在点过入口时）

`armReturnCheck(kind)` 在**跳转前**登记要查什么，`runReturnCheck()` 在
`visibilitychange → visible` 后 600ms 执行（等系统页退场，否则读到的是切换瞬间的旧状态）。

| 入口 | 登记 |
|---|---|
| 后台保活设置 · 应用设置 | notify + exact + battery |
| 提醒页 · 打开「耗电管理」/ 电池优化列表 | battery |
| 通知权限 · 去开启 / 再打开一次 | notify |
| 引导 · 精确闹钟 | exact |
| 引导 · 打开「耗电管理」 | battery |

没点过入口就切回前台（比如只是看眼微信）**不打扰** —— `pending` 为 null 直接返回。

### 弹什么

1. **通知还处于「未询问」** → 直接 `requestPermissions` 拉起系统权限弹窗。
   这是唯一一次"系统愿意弹"的机会，比任何文字都直接。
2. **其余缺失项** → App 内对话框，按机型给具体路径：

```
1 项还没开好
你的 OPPO PLG110 需要手动确认：

· 后台运行：设置 → 应用 → 北邮课程表 → 耗电管理，选「允许完全后台行为」
                                    [知道了]  [去打开]
```

点「去打开」→ 跳到该项系统页，并重新登记 → 回来再查一遍，形成闭环。

### 明确的边界

- 只查**系统有 API** 的三项：通知权限、精确闹钟、电池豁免。
- **厂商自启动读不到**，所以只给路径、绝不判"没开"（`returnCheck.js` 里连
  `autostart` 这个词都不出现，测试钉死）。
- 引导弹层 / 通知指引开着时跳过：那两个弹层自己会随状态重画，再叠对话框只会打架。
- 每项只提醒一次；没重新点入口就不重复弹。

验证：`npm test` 425/425；`node .probe-perm-fix.mjs` 50/50
（新增 8 项：自动拉权限框、不叠提示、按机型列路径、带机型名、点知道了收起、不重复打扰）。

---

## 0.11 1.66.8：「后台保活设置」页重构（信息分层）

那一页的问题是**同一批内容说了两遍**：「必做的三件事」列了一遍，
下面「你的系统」又用五条长句把同样的事再说一遍；再加上小组件、验证、其它系统，
一屏根本看不完，按钮文字还折成两行。

### 结构改成两段 + 三个折叠

| 位置 | 现在 |
|---|---|
| 第一张卡 | 标题「**只做三件事**」+ 状态行 + 三条短清单 + `[应用设置] [耗电管理]` + 一句「不做也能看课表，只是提醒可能不响。」 |
| 你的机型 | 只留两行：**入口**（路径）与**不设会怎样**（一句后果） |
| 折叠 1 | 逐步操作（原五条长句） |
| 折叠 2 | 桌面小组件（原来是一整张卡） |
| 折叠 3 | 怎么验证有没有生效（三句） |
| 其它系统 | 保持折叠 |

### 文案

| 位置 | 原文 | 现文 |
|---|---|---|
| 标题 | 必做的三件事 | **只做三件事** |
| 清单 2 | 电池优化：把本应用设为「不优化 / 不受限制 / 允许后台高耗电」 | **后台运行：耗电管理里选「允许完全后台行为」** |
| 清单 3 | 自启动（有的系统叫「应用启动管理」）：允许自启动 + 允许后台活动 | **自启动：允许自启动（有的系统叫「应用启动管理」）** |
| 状态行 | 电池优化：已豁免（系统不会因为省电清掉本应用的闹钟） | **电池优化：已豁免** |
| 按钮 | 打开本应用设置 / 修改后台运行模式（折成两行） | **应用设置 / 耗电管理** |
| 说明 | 「电池优化」类入口都收敛到这一页：先讲清要选「完全后台运行」，再跳系统页。 | **删掉**（那是给开发者看的） |
| 页脚 | 这些开关都写在系统设置里，本应用无法替你打开，也不会要求你关闭系统省电。 | **这些开关只能在系统设置里开，本应用不会替你关省电。** |

六个品牌的「不设会怎样」也统一压成一句后果（不再解释机制），
ColorOS 的五步里删掉了重复的第 5 条（长按图标 → 应用信息 → 耗电管理）。

验证：`npm test` 422/422；`node .probe-perm-fix.mjs` 42/42
（新增 7 项：标题已改、旧解释已删、按钮变短、三个面板默认收起、旧长句不再出现）。

---

## 0.10 1.66.7：文案精简（两屏都砍掉一半）

原则：**一行只说一件事**，技术名词留在该出现的地方（设置页里），不在列表里铺。

### 原生弹窗（`MainActivity#requestBackgroundPermissionIfNeeded`）

| | 原文 | 现文 |
|---|---|---|
| 标题 | 让上课提醒保持准时 | **让提醒更准时** |
| 正文 | 系统会在大约一分钟后清理后台应用，胶囊上的「N分后上课」可能因此停住不再变化。下一步会打开…把「耗电行为控制」改成「允许完全后台行为 / 完全后台运行」。★ 别停在「智能优化」…选择「暂不」也可以正常使用，只是倒计时可能中途停下。 | 下一步打开「设置 › 应用 › 北邮课程表」，点「耗电管理」，选「允许完全后台行为」。<br>别选「智能优化」—— 省电时会把已排的闹钟清掉。<br>选「暂不」也能用，只是倒计时可能中途停住。 |
| 按钮 | 去开启完全后台运行 | **去开启** |

### 引导清单（`permissions.js#buildSteps`）

| 项 | 原文 | 现文 |
|---|---|---|
| 通知权限 | 不给就收不到任何上课提醒（闹钟到点了，但屏幕上什么都没有）。课前的流体云 / 灵动岛胶囊也走这条通知，开完可以当场试一张。 | **不开就收不到任何提醒。课前胶囊也走这条通知。** |
| 精确闹钟 | 不开的话系统会把提醒合并到"唤醒窗口"，课前提醒可能晚十几分钟。 | **不开的话，提醒可能晚十几分钟。** |
| 后台运行（原「允许后台运行（别停在"智能"）」） | 入口是 设置 › 应用 › 北邮课程表 › 耗电管理，默认多是「智能优化 / 智能限制」，省电时仍会清掉已排的闹钟；要选「允许完全后台行为 / 完全后台运行」。 | **省电时会清掉已排的闹钟。要在「耗电管理」里选「允许完全后台行为」，别选「智能优化」。** |
| 自启动（原「自启动 / 后台活动（看你手机品牌）」） | 小米、OPPO、vivo、华为、三星都要单独放开，否则重启后闹钟会失效。点进去有逐机型路径。 | **有的手机重启后会关掉闹钟，点进去有路径。** |

卡片头/尾：

- `还有 N 项必开权限没开，开完才能继续用。点各项右边的按钮，一项一项来。` → `还差 N 项，点右边按钮逐项打开。`
- `这几项不影响看课表，但会让课前提醒不响或不准，所以先开完再继续。全部在系统设置里，本应用无法代开。` → `不影响看课表，只是提醒可能不响。这些开关只能在系统设置里开。`
- 逃生口 `我知道有风险，先看课表` → `先看课表`

### 通知清单（`NOTIFY_MANUAL_ITEMS`）

`where` 从"两张手机图下面的「锁屏」复选框"收敛成"同一页，「锁屏」打勾"；
`why` 从解释机制改成一句后果。跳转提示 `如果哪一项是灰色、点不动，说明上一层的「允许通知」还没打开 —— 先返回上一层把它打开。`
→ `开关是灰的？先返回上一层把「允许通知」打开。`

验证：`npm test` 422/422；`node .probe-perm-fix.mjs` 35/35。

---

## 0.9 1.66.6：把「课前流体云卡片」合并进「通知权限」

引导清单里原来有 5 行，其中「通知权限」和「课前流体云卡片」两行都跟通知有关，
用户看着像重复项。现在合并成一项：

- `buildSteps` 删掉 `promoted` 那一步（任何快照下都不再单独成行）；
  「通知权限」的说明补一句"课前的流体云 / 灵动岛胶囊也走这条通知，开完可以当场试一张"。
- 新增 `src/ui/promoted.js`：`promotedBlockHtml()` + `tryPromote()` + `describePromoteResult()`，
  **两个入口共用一份**（`notifyGuide.js` 的落地页、`onboard.js` 的通知弹层）。
- 区块内容：标题「课前胶囊（流体云 / 灵动岛）」+ 一句说明 + 「试一张」+「打开流体云设置」，
  试完把结论（已发出 / 没权限 / 系统没允许提升）就地显示。
- 删掉引导里那个独立的 `promoted` 弹层和 `onboard-promoted` 动作。

CSS 新增 `.pm-*`；`sw.js` 预缓存补 `promoted.js`（CACHE → v59）。

验证：`npm test` 422/422；`node .probe-perm-fix.mjs` 35/35
（其中 6 项专门验合并：清单无独立行、弹层有区块、点「试一张」真的调了 promoteDemo）。

---

## 0.8 1.66.5：跳转目标改回「权限管理 › 通知」

1.66.4 把落点统一到了**渠道页**（上课提醒），方向反了。用户要的是：

> 设置 › 应用 › 北邮课程表 › **权限管理 › 通知**

改回 `openNotificationPermissionPage()`（原生链路：ColorOS 权限管理器 → 标准应用通知设置 → 应用详情）。

**同时揪出了真正的根因**：App 里其实有**三条**通知跳转链路 ——

| 入口 | 原调用 |
|---|---|
| 通知指引弹层 · 去设置 | `openNotificationPermissionPage()` |
| 通知指引弹层 · 再打开一次 | `openNotificationSettingsEx()` → 渠道页 |
| 引导弹层 · 去设置 | `openNotificationCenter() \|\| openNotificationSettingsEx()` |
| 引导弹层 · 再打开一次 | `openNotificationSettingsEx()` |

同一件事，四个按钮、三个落点。现在统一成 `notifyGuide.jumpToNotifyPermissionPage()`，
`onboard.js` 直接 import 复用 —— **全 App 只剩一条通知跳转链路**，并加了测试钉死。

清单文案同步：落点是权限页，那一页只有「允许通知」一个开关，
所以第 2~4 项写明"返回上一级 →「通知管理」→「上课提醒」"才找得到横幅/锁屏/静默。

验证：`npm test` 420/420；`node .probe-perm-fix.mjs` 28/28；
APK 内 `notifyGuide` 只调用 `openNotificationPermissionPage`（+ 最后兜底的 `openNotificationCenter`），
`onboard` 不含任何独立链路。

---

## 0.7 1.66.4：删掉检测 + 修掉"跳转不一致"

### 一、删掉检测

「我已经开好了（检测）」→ **「我已经开好了」**，点了就是收起弹层。电池那边同理：
「我已改好，检测一下」→ **「我已开好」**，只记用户确认，不读系统状态。

理由（也是把之前的方案推翻的理由）：
- 横幅/锁屏**没有查询 API**，读到的开关状态和"到底会不会弹"并不等价，
  给出的结论半真半假，反而误导；
- 探针通知会往通知栏发东西，用户点一下检测就被打扰一次；
- 真有没有开全，**课前那条测试通知**会直接暴露，比读开关更接近事实。

删掉的东西：`src/ui/permissionCheck.js`（整个模块）、`permissions.js#auditVerdict`、
`native.js#notificationProbe` / `openDndSettings`、`MainActivity#notificationProbe` /
`openDndSettings`、`ReminderScheduler#buildProbeNotification`、`.pc-*` 样式。
`notificationAudit` 保留（只读状态，未删，留给后续诊断用）。

### 二、跳转不一致（这才是"跳错"的真相）

同一张卡片里两个按钮走了**两条不同的链路**：

| 按钮 | 原链路 | 落点 |
|---|---|---|
| 去设置 | `openNotificationPermissionPage()` | 权限管理 / 应用通知设置 |
| 再打开一次 | `openNotificationSettingsEx()` | 渠道页 |

所以第一次跳过去是一个页面，再点一次又是另一个页面 —— 用户当然觉得跳错了。

现在**两个按钮都走 `jumpToSettings()`**，内部只用 `openNotificationSettingsEx()`，
落点稳定在「北邮课程表 › 上课提醒」渠道页（截图里那一页）。
选它是因为要开的四项**全在这一页**，一次到位。

### 三、清单改成和那一页一一对应

渠道页从上到下是：允许通知 → 静默通知 → 锁屏 / 横幅 → 锁屏隐藏内容。
原清单第 4 项写的是「流体云」，**那一页根本没有这一项**，用户照着找会找不到。
现在改为：**允许通知 / 静默通知（必须关闭）/ 锁屏 / 横幅**，
其中「静默通知」是新加的 —— 它开着就是"只进通知中心、不响不弹"，最坑的一项。

验证：`npm test` 419/419；`node .probe-perm-fix.mjs` 27/27；
APK 内 `permissionCheck.js`、`notificationProbe`、`openDndSettings` 均已不存在。

---

## 0.6 1.66.3：只挑 exported 的候选 + 诊断可截图

1.66.2 装了之后**还是**停在应用详情 —— 说明枚举没命中，或者命中了但打不开。

两个新判断：

1. **非 exported 的 Activity 第三方根本调不动**（`startActivity` 直接抛 `SecurityException`）。
   1.66.2 只是"找到就试"，找到的如果不可导出，等于白试。现在分两轮：
   先只挑 `android:exported="true"` 的，一轮都不行再退回不要求 exported 的。
2. **`com.oplus.appdetail` 很可能是宿主**：「应用详情」这一页就是它，
   「耗电管理」是从这一页点进去的，那一页大概率也挂在同一个包里。已加入枚举包列表
   （同步补进清单 `<queries>`）。

另外把提示词从 4 个扩到 8 个（`PowerUsageModel` / `PowerUsageDetail` / `AppPowerUsage` /
`PowerUsage` / `PowerConsumption` / `PowerConsume` / `BatteryUsage` / `BatteryDetail`），
宁可多试几个，也别直接掉回应用详情。

**最关键的一条：加了可截图的诊断。**
页面底部有「诊断：本机能打开的耗电页」，跳转落点不是 `powerPage` 时**自动展开**，列出：

```
com.oplus.battery：com.oplus.powermanager.fuelgaue.PowerUsageModelActivity、xxx（不可导出）
com.oplus.appdetail：无匹配
com.coloros.oppoguardelf：不可见
```

有了这段，下一轮不用再猜 —— 真实类名和 exported 状态一眼可见。

验证：`npm test` 434/434；`node .probe-perm-fix.mjs` 36/36；
`aapt2 dump xmltree` 确认 `<queries>` 四个包都在。

---

## 0.5 1.66.2 修正：再跳一步，直达「耗电行为控制」

1.66.1 落在「应用详情」，用户还要自己点「耗电管理」。要的是**再跳一步**，
直达「耗电行为控制」那三个单选项（完全允许后台行为 / 智能优化后台运行 / 限制后台运行）。

**为什么前两次都跳错了**：ColorOS 没有公开这一页的深链文档，只能靠类名猜。
1.66.0 猜 `PowerUsageModelActivity` 等三个候选 → 落到「应用的电池使用情况」列表；
1.66.1 退回应用详情 → 少一步但不够。**猜类名这条路本身不可靠**：类名随版本变，
同一个名字在不同 ROM 上可能是列表页、也可能是详情页。

**1.66.2 改成运行时枚举，不再猜**：

```java
POWER_PKGS = { com.oplus.battery, com.coloros.oppoguardelf, com.oplus.powermanager }
POWER_ACTIVITY_HINTS = { PowerUsageModel, PowerUsageDetail, AppPowerUsage, PowerConsumption }
// 外层按 hint（越靠前越像目标页），内层按包，逐个 getPackageInfo(GET_ACTIVITIES) 找类名
```

- `PowerUsageModel` 里的 **model 就是"完全允许 / 智能优化 / 限制"这三种模式**，
  命中它基本就是目标页；`PowerConsumption` 更像耗电统计列表，排最后。
- 类名换版本、换包名都能自适应；一个都找不到才退回应用详情 —— 不会因为猜错丢到别的页。
- `buildPowerIntent()` 带全 extra（`package_name` / `packageName` / `pkg_name` / `package` /
  `app_package` / `android.provider.extra.APP_PACKAGE` / `app_uid`）+ `package:` data，
  因为各家读的字段不一样，有的读 `getData()` 有的读 extra。
- **清单加 `<queries>`**：Android 11+ 的包可见性会让未声明的包 `getPackageInfo` 直接抛异常。
  只声明这三个系统电池包，不申请 `QUERY_ALL_PACKAGES`。
- 新增 `batteryActivities()` 诊断接口：网页在**退回应用详情**时把候选列表显示成一行小字，
  用户截图就能反馈，不用再靠猜。

落点标签：`powerPage / appDetail / ignoreList / requestIgnore / none`。
页面主按钮文案：**「打开「耗电管理」页」**。

验证：`npm test` 434/434；`node .probe-perm-fix.mjs` 31/31；
APK 内 `findActivityContaining` / `buildPowerIntent` / `PowerUsageModel` 均在，
`aapt2 dump xmltree` 确认 `<queries>` 已进包。

---

## 0.4 1.66.1 修正：电池落点错了

1.66.0 先试 `com.oplus.battery/...PowerUsageModelActivity`，真机上落到了
**「应用的电池使用情况」**——一个所有应用的列表页，用户还得自己找到本应用、
再点进去才有「耗电管理」。多一层，还容易点错行。

**查证结论**：ColorOS 没有公开的「耗电管理」深链文档（OPPO 开放平台只讲推送/上架，
官方支持文档给的路径是 `设置 > 电池 > 手机电池使用情况 > 选择应用`，正是那个列表页）。
网上流传的厂商 Activity 类名（`PowerUsageModelActivity` / `PowerConsumptionActivity`）
各版本不一致，且实测指向的就是列表页，不可靠。

**正确落点是应用信息页**：`Settings.ACTION_APPLICATION_DETAILS_SETTINGS`（带 `package:` URI），
即 **设置 › 应用 › 北邮课程表**。「耗电管理」和权限、存储、流量并列挂在这一页里。
它是 AOSP 公开常量，任何 ROM 都认，100% 能打开。

改动：

| 项 | 1.66.0 | 1.66.1 |
|---|---|---|
| 链路首选 | `com.oplus.battery/...PowerUsageModelActivity` | `ACTION_APPLICATION_DETAILS_SETTINGS`（+ `:settings:fragment_args_key=battery` 高亮） |
| 厂商 ComponentName | 3 个候选 | **全部删除**（实测落错页） |
| 落点标签 | batteryMode / batteryModeOld / consumption / ignoreList / requestIgnore / detail | appDetail / ignoreList / requestIgnore / none |
| 新增接口 | — | `openAospBatteryList()`：单独打开 AOSP 电池优化列表（Doze 白名单是另一层） |
| 页面按钮 | 「打开系统「修改后台运行模式」页」 | 「打开「北邮课程表」应用设置页」+「另外打开「电池优化」列表」 |
| 路径文案 | 设置 › 电池 › 应用耗电管理 | **设置 › 应用 › 北邮课程表 › 耗电管理** |

同步改了：`keepalive.js` 的 ColorOS 步骤、`permissions.js` 的电池项说明、
`MainActivity` 启动弹窗文案与 Toast、`sw.js` 缓存版本（v54）。

验证：`npm test` 431/431；`node .probe-perm-fix.mjs` 31/31；
APK 内 `com.oplus.battery` / `PowerUsageModelActivity` 已不存在，
`android.settings.APPLICATION_DETAILS_SETTINGS` 存在。

---

## 0. 落地结果（1.66.0）

### 0.1 改动清单

| 文件 | 改动 |
|---|---|
| `android/java/.../MainActivity.java` | `notificationAudit` 扩到 8 个字段；新增 `notificationProbe` / `openDndSettings`；`openBatteryModeChain` 扩到 6 级；启动弹窗改走厂商链路；`openBatterySettings` 改为委派（老调用方也不会再落错页） |
| `android/java/.../ReminderScheduler.java` | 新增 `PROBE_RC` + `buildProbeNotification` |
| `src/native.js` | 新增 `notificationProbe` / `openDndSettings`；`BATTERY_LANDING_HINT` 补 3 个落点 |
| `src/permissions.js` | `auditVerdict(health, probe, seen)` 改三态 + `problems[].code/fix` |
| `src/ui/permissionCheck.js` | **新增**：三段式检测，两个入口共用 |
| `src/ui/batteryMode.js` | **新增**：「修改后台运行模式」内容（三选项对照表 + 必须选完全） |
| `src/ui/notifyGuide.js` | 按钮改 `check`；删自动关窗；删「发测试通知→直接置 ok」的假通过 |
| `src/ui/onboard.js` | 同上；电池弹层换成共用内容 |
| `src/ui/reminderView.js` | 新增 `#/reminder/battery-mode` 页 + 入口 |
| `src/main.js` | `keepalive-battery` 改导航；新增 `battery-open-system` / `battery-verify`；回前台刷新 |
| `assets/css/app.css` | 新增 `.pc-*` / `.bm-*` 样式 |
| `sw.js` | 预缓存补两个新模块，CACHE → `bupt-v53` |
| `scripts/build-android.mjs` | 同步后**逐字节回验**，不一致直接 fail；版本 1.66.0 / 72 |
| `tests/permissions.test.mjs` | 13 条新用例（三态口径） |
| `tests/native-intents.test.mjs` | 7 条新用例（链路顺序、接口存在、入口收敛） |
| `tests/assets-sync.test.mjs` | **新增**：装机包必须与源码逐字节一致 |
| `.probe-perm-fix.mjs` | **新增**：jsdom 端到端探针，29 项断言全过 |

### 0.2 实现时对原方案的三处修正

1. **`ok` 的语义收紧了**：原方案说"硬事实过了但没确认横幅 = partial 且 `ok:false`"，
   落地时按这个口径实现 —— `ok` 现在**只**在「L1 无问题 + L2 投递成功 + L3 亲眼看到横幅」时为 true。
   代价是 `tests/permissions.test.mjs` 里三条老用例按新口径重写（老口径"importance=4 就通过"
   正是要修的 bug）。
2. **探针通知不做静音**：framework 的 `Notification.Builder` 没有 `setSilent`（编译报错才发现，
   `setSilent` 只在 `NotificationCompat.Builder` 上）。改成不静音 + `setOnlyAlertOnce`，
   理由反而更充分：探针走的就是「上课提醒」那条渠道，让它按真实提醒的方式响一次，
   用户才能判断"我到底会不会被打断"。
3. **电池链路多了一级**：除方案里的 4 级外，把 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
   插在 `ignoreList` 之后、应用详情之前 —— 它管不到厂商那层，但比应用详情离目标近。
   落点标签因此是 6 个：`batteryMode / batteryModeOld / consumption / ignoreList / requestIgnore / detail`。

### 0.3 验证

```
npm test                 → 430/430 通过
node .probe-perm-fix.mjs → 29/29 通过（真实点击路径，jsdom）
apksigner verify         → 签名正常，证书与 1.65.0 相同（可原地升级）
APK 内检查               → assets/www 与 src 逐字节一致；dex 含
                           notificationProbe / getActiveNotifications /
                           areNotificationsEnabled / getCurrentInterruptionFilter /
                           PowerUsageModelActivity / buildProbeNotification
```

⚠️ **仍需真机确认的一点**：ColorOS 的耗电行为控制 Activity 类名各版本有差异。
代码里三个候选都只是 `tryStartActivity`，进不去会自动降级并回报落点
（`batteryMode` → `batteryModeOld` → `consumption` → `ignoreList` …）。
装到机器上点一次「打开系统「修改后台运行模式」页」，看它是否直达三选项页；
若落到 `ignoreList`，用下面命令查本机真实类名后补进 `vendor` 数组：

```
adb shell dumpsys package com.oplus.battery | findstr Activity
adb shell cmd package resolve-activity --brief com.oplus.battery/com.oplus.powermanager.fuelgaue.PowerUsageModelActivity
```

---

## 一、问题 1：「我已开启」点击后没有任何检测

### 1.1 根因（三层，从致命到次要）

**根因 1-A｜装机包是旧代码（致命）**

`android/assets/www/**` 是 `src/**` 的手工拷贝，目前已与源码脱节。实测：

```
$ grep -c "notificationAudit" android/assets/www/src/native.js android/assets/www/src/ui/onboard.js
android/assets/www/src/native.js:0
android/assets/www/src/ui/onboard.js:0
```

装机包里的按钮长这样（`android/assets/www/src/ui/notifyGuide.js:102`）：

```html
<button type="button" class="btn btn-primary" data-ng="close">我已经开好了</button>
```

`data-ng="close"` → `closeNotifyGuide()`，**只有关窗，一行检测都没有**。用户看到的就是"点一下窗口就没了，等于我说开好了它就信了"。

源码 `src/ui/notifyGuide.js` 已经补了检测，但**没重新打包**，所以真机上跑的还是旧逻辑。

**根因 1-B｜源码里的检测口径不足**

即使重新打包，现有 `auditVerdict()`（`src/permissions.js:186`）只读两项：

| 读到的 | 没读的 | 后果 |
|---|---|---|
| `POST_NOTIFICATIONS` 运行时权限 | `areNotificationsEnabled()` 应用级总开关 | Android 12 及以下用户关掉总开关，`granted` 仍为 `true` → **误判通过** |
| 渠道 `importance` | 勿扰模式（DND） | 勿扰下横幅根本不弹，仍判通过 |
| — | 横幅开关本身 | 无公开 API；ColorOS 关横幅会把渠道降到 `IMPORTANCE_DEFAULT(3)`，而现在的判定是 `importance <= 2` 才拦 → **横幅关了照样 ✅** |
| — | 通知是否真的投递成功 | 应用级/渠道被拦时，代码层面一切"正常" |

**根因 1-C｜还有两处"假装校验"**

- `src/ui/notifyGuide.js:180-189`：点「发一条测试通知」直接把结论写成 `ok: true` 并画绿勾，实际没有确认用户看到了什么。
- `src/ui/notifyGuide.js:170-177`：校验通过后 `setTimeout(() => closeNotifyGuide(), 900)` 自动关窗，用户来不及看清结论，体验上仍是"点一下就没了"。

### 1.2 修改方案：三级检测（硬事实 → 实测投递 → 人工确认）

思路是把"能不能检测"拆成三档，每一档都**只声明它真的能证明的事**，绝不越界。

#### L1 硬事实（原生可读，确定结论）

`MainActivity.Bridge.notificationAudit()` 扩展字段（保留旧字段，向后兼容）：

```java
@JavascriptInterface
public String notificationAudit() {
    JSONObject o = new JSONObject();
    try {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        // ① 运行时权限（13+ 才有意义）
        o.put("granted", ReminderScheduler.canNotify(this));

        // ② 应用级总开关：API 24+；13 以下这是唯一的总开关
        boolean appEnabled = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && nm != null) {
            appEnabled = nm.areNotificationsEnabled();
        }
        o.put("appEnabled", appEnabled);

        // ③ 渠道 importance + 横幅代理判定
        int importance = -1;
        boolean channelExists = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = nm.getNotificationChannel(ReminderScheduler.CHANNEL_ID);
            if (ch != null) {
                channelExists = true;
                importance = ch.getImportance();
            }
        }
        o.put("importance", importance);
        o.put("importanceLabel", importanceLabelOf(importance));
        o.put("channelExists", channelExists);
        // 横幅没有公开 API；ColorOS 关掉横幅会把渠道降到 DEFAULT(3)，
        // 所以 importance >= HIGH 只能算"很可能能弹横幅"，必须标注为代理判定
        o.put("bannerLikely", importance >= NotificationManager.IMPORTANCE_HIGH);

        // ④ 勿扰：不等于 ALL 就说明横幅会被压掉
        boolean dndActive = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm != null) {
            dndActive = nm.getCurrentInterruptionFilter()
                    != NotificationManager.INTERRUPTION_FILTER_ALL;
        }
        o.put("dndActive", dndActive);

        // ⑤ 提升通知（流体云），API 36+
        if (Build.VERSION.SDK_INT >= 36) {
            o.put("promoted", nm != null && nm.canPostPromotedNotifications());
        } else {
            o.put("promoted", JSONObject.NULL);
        }
    } catch (Exception e) {
        // 读失败保持字段缺省，前端按 unknown 处理，不许当通过
    }
    return o.toString();
}
```

#### L2 实测投递（唯一能证明"通知真的进了通知栏"）

新增 `notificationProbe()`：发一条静默测试通知 → 查它是否真的 active → 立刻撤销。

```java
/**
 * 实测投递：发一条通知，再查系统里"自己这条"在不在。
 *
 * 为什么这是最硬的证据：被应用级开关 / 渠道关闭 / 权限拦截的通知
 * **不会进入 getActiveNotifications()**，所以它同时覆盖了 L1 的所有拦截点。
 * 反过来说，它证明不了"横幅弹出来了"——那是 L3 的事。
 */
@JavascriptInterface
public String notificationProbe() {
    JSONObject o = new JSONObject();
    try {
        ReminderScheduler.ensureChannel(this);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        int id = 0x5EED;
        boolean posted = false;
        try {
            Notification n = ReminderScheduler.buildProbeNotification(this); // 见下
            nm.notify(id, n);
            posted = true;
        } catch (Throwable t) {
            posted = false;
        }
        // 给系统一点时间把它挂到通知栏
        Thread.sleep(300);
        boolean visible = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm != null) {
            StatusBarNotification[] list = nm.getActiveNotifications();
            for (StatusBarNotification sbn : list == null ? new StatusBarNotification[0] : list) {
                if (sbn.getId() == id) { visible = true; break; }
            }
        } else {
            visible = posted; // 23 以下没有查询接口，只能退化成"发出去了"
        }
        try { nm.cancel(id); } catch (Throwable ignored) { }
        o.put("posted", posted);
        o.put("visible", visible);
        o.put("queryable", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M);
    } catch (Throwable t) {
        o.put("posted", false);
        o.put("visible", false);
        o.put("queryable", false);
    }
    return o.toString();
}
```

`ReminderScheduler` 里加一个探针通知构造（渠道同 `CHANNEL_ID`，`setSilent(true)` 避免打扰，`setTimeoutAfter` 兜底自动消失）：

```java
static Notification buildProbeNotification(Context ctx) {
    Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(ctx, CHANNEL_ID)
            : new Notification.Builder(ctx);
    return b.setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("通知检测")
            .setContentText("看到这条说明通知能正常送达")
            .setAutoCancel(true)
            .setTimeoutAfter(8000L)
            .build();
}
```

`native.js` 对应加 `notificationProbe()`，与 `notificationAudit()` 同款 try/catch 风格，读不到返回 `null`。

#### L3 人工确认（横幅 / 锁屏，系统不给 API）

L2 通过后，UI 直接问一句，把"读不到"变成"用户确认"：

> 刚才那条「通知检测」你看到了吗？
> 　[看到了横幅]　[只看到状态栏图标]　[什么都没看到]

- 看到了横幅 → 通过
- 只看到图标 → 横幅没开：红条 + 「打开通知设置（横幅开关就在这一页）」
- 什么都没看到 → 回退到 L1/L2 的问题清单

这一步是**唯一的关窗前提**，不再有"点了就算过"的分支。

#### 逻辑层：`auditVerdict` 改三态

`src/permissions.js`：

```js
/**
 * @param {{granted?:boolean, appEnabled?:boolean, importance?:number,
 *          importanceLabel?:string, channelExists?:boolean,
 *          bannerLikely?:boolean, dndActive?:boolean}} health
 * @param {{posted?:boolean, visible?:boolean, queryable?:boolean}|null} [probe]
 * @param {'banner'|'icon'|'none'|null} [seen] 用户肉眼确认结果
 * @returns {{ok:boolean, level:'ok'|'partial'|'blocked'|'unknown',
 *            problems:Array<{code:string,text:string,fix:string}>, note:string}}
 */
export function auditVerdict(health, probe = null, seen = null) { /* ... */ }
```

判定顺序与 `fix` 取值（UI 据此决定给哪个按钮）：

| code | 触发条件 | 文案要点 | fix |
|---|---|---|---|
| `no_bridge` | `health` 为 null | 当前版本读不到系统状态，请更新 App | — |
| `perm_denied` | `granted === false` | 运行时权限没给 | `perm` |
| `app_disabled` | `appEnabled === false` | 应用级「允许通知」总开关是关的 | `notify` |
| `channel_missing` | `channelExists === false` | 渠道还没建（老包或系统清过） | `notify` |
| `channel_off` | `importance === 0` | 渠道被关掉 | `notify` |
| `importance_low` | `importance <= 2` | 渠道重要性过低，可能无横幅/声音 | `notify` |
| `probe_failed` | `probe && !probe.visible && probe.queryable` | 测试通知没能进通知栏 | `probe` |
| `banner_off` | `seen === 'icon'` 或 `bannerLikely === false` | 横幅没开（按 ColorOS 语义说明） | `notify` |
| `dnd` | `dndActive === true` | 勿扰模式压掉了横幅 | `dnd` |

`level` 语义：
- `blocked`：L1/L2 有硬伤 → 必须改
- `partial`：通知能到，但横幅/锁屏不确定 → 需 L3 确认
- `ok`：L1 全过 + L2 visible + L3 看到横幅
- `unknown`：原生接口缺失（旧包 / 浏览器）→ **绝不显示通过**

> 兼容：`auditVerdict(health)` 单参调用保持可用，此时 `level` 最多到 `partial`，不会返回 `ok`。现有 3 条单测仍过，新增用例见 §3。

#### UI 层改造

`src/ui/notifyGuide.js` 与 `src/ui/onboard.js` 共用同一个检测片段（建议抽到 `src/ui/permissionCheck.js`，两处 `import`，避免第三次出现两份不同实现）：

```js
// 点击「我已开启」→ 三段式，全程不关窗
function runCheck() {
  const health = NATIVE.notificationAudit();
  const first = auditVerdict(health);           // 只做 L1
  if (first.level === 'blocked' || first.level === 'unknown') {
    render(first);                              // 红条/灰条 + 问题清单，停在这里
    return;
  }
  const probe = NATIVE.notificationProbe();     // L2
  const second = auditVerdict(health, probe);
  if (second.level === 'blocked') { render(second); return; }
  renderAskBanner(second);                      // L3：问"看到了吗"
}
```

按钮行为矩阵（`data-ng` / `data-obd`）：

| 按钮 | 旧行为 | 新行为 |
|---|---|---|
| 我已开启 | `close`（直接关窗） | `check`：跑三段式 |
| 发一条测试通知 | 写死 `ok:true` | 合并进 L2，不再单独存在 |
| 通过后 | 900ms 自动关窗 | 显示绿条 + 用户手动点「完成」 |
| 检测失败 | 只列问题 | 每个问题后跟对应修复按钮（`notify` / `perm` / `dnd` / `probe`） |

`dnd` 对应的原生跳转新增：

```java
@JavascriptInterface
public void openDndSettings() {
    runOnUiThread(() -> {
        if (tryStartActivity(new Intent("android.settings.ZEN_MODE_SETTINGS"))) return;
        if (tryStartActivity(new Intent("android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS"))) return;
        openAppDetail();
    });
}
```

#### 修打包（必做，否则以上全部无效）

`scripts/build-android.mjs` 增加两步，放在 `aapt` 之前：

```js
/* 1) 同步：src + index.html + manifest + assets → android/assets/www（先清空） */
function syncWebAssets() {
  const dst = path.join(AND, 'assets', 'www');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(dst, 'src'), { recursive: true });
  for (const f of ['index.html', 'manifest.webmanifest']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dst, f));
  }
  // assets/ 里的图片、css 按需保留
  if (fs.existsSync(path.join(ROOT, 'assets'))) {
    fs.cpSync(path.join(ROOT, 'assets'), path.join(dst, 'assets'), { recursive: true });
  }
}

/* 2) 校验：同步后逐文件比对，不一致直接 fail —— 让"改完忘打包"变成构建错误 */
function verifyWebAssets() {
  const dst = path.join(AND, 'assets', 'www');
  for (const rel of walkFiles(path.join(ROOT, 'src'))) {
    const a = fs.readFileSync(path.join(ROOT, 'src', rel));
    const b = fs.readFileSync(path.join(dst, 'src', rel));
    if (!a.equals(b)) problems.push(`assets/www 与 src 不一致：src/${rel}`);
  }
}
```

同时在 `tests/` 加一条守卫（见 §3），CI 跑 `npm test` 就能拦住。

---

## 二、问题 2：电池优化跳错页面，且没有"完全后台运行"提醒

### 2.1 根因

**2-A｜跳的是 AOSP 那层，ColorOS 那层根本没碰**

三个入口（提醒页「电池优化」按钮、首启引导的电池行、启动弹窗「去开启」）最终都落到 `openBatterySettings()`（`MainActivity.java:204`）：

```java
Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
```

这是 Android 原生的"忽略电池优化"确认框。而 ColorOS 真正决定后台生死的开关是 **设置 › 电池 › 应用耗电管理 › 北邮课程表 › 耗电行为控制**（三选一：智能优化 / 允许完全后台行为 / 限制后台行为）。两层互不相通——把 AOSP 白名单加了，ColorOS 仍按"智能优化"清后台。

`docs/BACKGROUND-KEEPALIVE.md` 里已经写清这是"第 3 层管不到第 4 层"，但代码没有据此实现。

**2-B｜`openBatteryModePage()` 存在，但没接上**

`MainActivity.java:354` 的 `openBatteryModeChain()` 只有两级：`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` → 应用详情。既没有 ColorOS 耗电行为控制的 Activity 候选，也只被引导页调用一次；提醒页 `keepalive-battery`（`main.js:1362`）和启动弹窗仍走旧的 `openBatterySettings()`。

**2-C｜没有常驻的"必须选完全"提醒**

提示语目前散在三处（Toast、`BATTERY_LANDING_HINT`、引导弹层一段文字），用户跳出去之后就再也看不到"要选哪个"，回来也没有任何检测。

### 2.2 修改方案

#### A. 原生链路扩到五级，并回报落点

```java
/** 「修改后台运行模式」页链路：ColorOS 耗电行为控制优先，AOSP 白名单其次。 */
private String openBatteryModeChain() {
    final String[][] vendor = {
        // ColorOS 12+（oplus）
        {"com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"},
        // ColorOS 7~11（coloros）
        {"com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"},
        // 应用耗电详情（上面两个都进不去时的近邻页）
        {"com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerConsumptionActivity"},
    };
    for (String[] c : vendor) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(c[0], c[1]));
        i.putExtra("package_name", getPackageName());
        i.putExtra("pkg_name", getPackageName());
        i.putExtra("package", getPackageName());
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (tryStartActivity(i)) return "batteryMode";
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (tryStartActivity(list)) return "ignoreList";
    }
    if (tryStartActivity(new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())))) {
        return "detail";
    }
    return "none";
}
```

> 候选类名**必须真机验证**（不同 ColorOS 版本类名有差异）。验证命令：
> `adb shell dumpsys package com.oplus.battery | findstr Activity`
> 或 `adb shell cmd package resolve-activity --brief com.oplus.battery/com.oplus.powermanager.fuelgaue.PowerUsageModelActivity`
> 代码里的 `tryStartActivity` + 落点回报保证验证不过也不会崩，只是降级到下一级并给出对应文案。

`BATTERY_LANDING_HINT` 同步补两个 key：

```js
export const BATTERY_LANDING_HINT = {
  batteryMode: '已打开「耗电行为控制」：把本应用改成「允许完全后台行为 / 完全后台运行」',
  consumption: '已打开耗电详情：点「耗电行为控制」→ 选「允许完全后台行为」',
  ignoreList: '只打开了「电池优化」列表：这层管不到 ColorOS 的后台限制，请继续到 电池 › 应用耗电管理',
  detail: '已打开应用详情：点「耗电管理」→「耗电行为控制」→ 选「允许完全后台行为」',
  none: '没能打开系统页：请到 设置 › 电池 › 应用耗电管理 › 北邮课程表 → 完全允许后台行为'
};
```

#### B. 新增 App 内页面 `#/reminder/battery-mode`「修改后台运行模式」

放在 `src/ui/reminderView.js`，走现有二级路由（`parseHash` 已支持 `#/reminder/<sub>`，零改动）。页面结构：

```
┌ 修改后台运行模式 ──────────────────────────┐
│ 当前状态：未豁免 / 已豁免 / 无法读取        │  ← batteryExempt() + visibilitychange 回刷
├───────────────────────────────────────────┤
│ ⚠ 必须选「完全后台运行」                    │  ← 页面第一屏，红色强调块
│   选「智能优化」＝ 省电时清掉已排的闹钟，    │
│   课前提醒可能不响。                        │
├───────────────────────────────────────────┤
│ 三个选项对照表                              │
│  智能优化（默认）→ 会清后台，不选            │
│  完全允许后台行为 → ✅ 选这个                │
│  限制后台行为 → 最差，别选                   │
├───────────────────────────────────────────┤
│ [ 打开系统「修改后台运行模式」页 ]          │  ← 主 CTA
│ [ 我已改好，检测一下 ]                       │  ← 读 batteryExempt
│ 落地提示：按落点给不同路径                   │  ← BATTERY_LANDING_HINT
└───────────────────────────────────────────┘
```

关键实现点：

```js
// 从系统页返回时自动复检（复用 main.js 现有 visibilitychange 模式）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentRoute.sub === 'battery-mode') paint();
});
```

检测逻辑要**如实分层**：

```js
const exempt = NATIVE.batteryExempt();   // 只反映 AOSP 白名单
// exempt === true  → 只能说"AOSP 层已豁免"，不能宣称 ColorOS 层也放开了
// exempt === false → 明确未豁免
// exempt === null  → 浏览器/旧包，读不到
```

所以文案必须是：

- `exempt === true`：`AOSP 电池优化已豁免。ColorOS 的「耗电行为控制」系统不提供查询，请确认那一页选的是「允许完全后台行为」。`
- `exempt === false`：`系统仍显示未豁免 —— 回到那一页，把「耗电行为控制」改成「允许完全后台行为」。`
- `exempt === null`：`当前环境读不到系统状态。`

**行为验证（可选增强，用于 ColorOS 层读不到时给硬证据）**：`ClassRefreshService` 已有后台心跳，记录最近一次心跳时间戳，页面展示"上次后台心跳：x 分钟前"。若用户改完设置后心跳连续，即为有效证据；若长时间无心跳，说明仍被杀。这条不进必开判定，只作参考展示。

#### C. 所有电池入口统一收敛

| 位置 | 现在 | 改为 |
|---|---|---|
| `main.js:1362` `keepalive-battery` | `NATIVE.openBatterySettings()` | `navigate('#/reminder/battery-mode')` |
| `onboard.js` `onboard-battery` | 弹层 → `openBatteryModePage()` | 保留弹层，按钮跳同一路由（保持一致） |
| `onboard.js` `battery-mode` | `openBatteryModePage()` | 不变，但用新的 `BATTERY_LANDING_HINT` |
| `MainActivity.requestBackgroundPermissionIfNeeded()`「去开启」 | `openBatterySettings()` | `openBatteryModeChain()`，按钮文案改「去开启完全后台运行」 |

`openBatterySettings()`（AOSP 对话框那条）保留但**不再作为任何入口的首选**，只作为链路最后一级兜底。

#### D. 文案统一

全项目只保留一个说法：**「完全后台运行」**（并在括号里标注 ColorOS 的叫法「允许完全后台行为」）。删掉"忽略电池优化"作为用户可见主文案的用法（它在 AOSP 层是对的，但会让用户以为改完就没事了）。

---

## 三、测试

### 新增/修改的单测

`tests/permissions.test.mjs`（现有 3 条保持通过，新增 6 条）：

```js
test('应用级总开关关了 → 打回，且指向通知设置', () => {
  const v = auditVerdict({ granted: true, appEnabled: false, importance: 4 });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === 'app_disabled' && p.fix === 'notify'));
});

test('勿扰模式 → 打回，且指向勿扰设置', () => {
  const v = auditVerdict({ granted: true, appEnabled: true, importance: 4, dndActive: true });
  assert.ok(v.problems.some((p) => p.code === 'dnd' && p.fix === 'dnd'));
});

test('渠道降到 DEFAULT（ColorOS 关横幅）→ 判横幅未开', () => {
  const v = auditVerdict({ granted: true, appEnabled: true, importance: 3, bannerLikely: false });
  assert.equal(v.level, 'partial');
  assert.ok(v.problems.some((p) => p.code === 'banner_off'));
});

test('实测投递失败 → blocked', () => {
  const v = auditVerdict(
    { granted: true, appEnabled: true, importance: 4, bannerLikely: true },
    { posted: true, visible: false, queryable: true }
  );
  assert.equal(v.level, 'blocked');
});

test('只有硬事实通过、用户没确认横幅 → 最多 partial，绝不 ok', () => {
  const v = auditVerdict({ granted: true, appEnabled: true, importance: 4, bannerLikely: true },
                         { posted: true, visible: true, queryable: true });
  assert.notEqual(v.level, 'ok');
  assert.equal(v.ok, false);
});

test('用户确认看到横幅 → 才 ok', () => {
  const v = auditVerdict({ granted: true, appEnabled: true, importance: 4, bannerLikely: true },
                         { posted: true, visible: true, queryable: true }, 'banner');
  assert.equal(v.ok, true);
  assert.equal(v.level, 'ok');
});
```

`tests/native-intents.test.mjs`（新增 3 条）：

```js
test('电池链路：厂商耗电行为控制排在 AOSP 列表之前', () => {
  const body = src.slice(src.indexOf('private String openBatteryModeChain'));
  const vendorAt = body.indexOf('com.oplus.battery');
  const listAt = body.indexOf('ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
  assert.ok(vendorAt > 0 && vendorAt < listAt, 'ColorOS 耗电行为控制必须优先');
});

test('电池链路必须回报落点', () => {
  for (const tag of ['batteryMode', 'ignoreList', 'detail']) {
    assert.ok(src.includes(`"${tag}"`), `缺少落点 ${tag}`);
  }
});

test('检测接口必须查应用级开关与勿扰', () => {
  assert.match(src, /areNotificationsEnabled\(\)/);
  assert.match(src, /getCurrentInterruptionFilter\(\)/);
});
```

新增 `tests/assets-sync.test.mjs`（防复发，最关键的一条）：

```js
test('android/assets/www 必须与 src 完全一致（防止发旧包）', () => {
  for (const rel of walk('src')) {
    const a = fs.readFileSync(path.join('src', rel));
    const b = path.join('android/assets/www/src', rel);
    assert.ok(fs.existsSync(b), `装机包缺文件：${rel}`);
    assert.ok(a.equals(fs.readFileSync(b)), `装机包是旧代码：src/${rel}`);
  }
});
```

### 手工验收清单

**问题 1**
1. 全新安装 → 首启引导 → 通知项点「去开启」→ 系统权限窗 → 允许 → 跳设置页 → 什么都不改，直接点「我已开启」→ 必须显示**未通过**并列出"应用级/渠道"具体项。
2. 把渠道横幅关掉（ColorOS 通知设置里关「横幅」）→ 点检测 → 必须判**未通过**，且文案指向横幅开关。
3. 打开勿扰 → 点检测 → 必须判**未通过**，且给出「去关闭勿扰」。
4. 全开 → 点检测 → 发出一条测试通知 → 页面问"看到了吗" → 选「看到了横幅」→ 绿条 → 手动点「完成」才关窗。
5. 断网/浏览器打开网页版 → 点检测 → 显示"无法检测"，**不显示通过**。
6. `npm run build:android` 后 `grep -c notificationAudit android/assets/www/src/native.js` 必须 > 0。

**问题 2**
1. 提醒页 →「电池优化」按钮 → 落在 `#/reminder/battery-mode`（不是直接甩系统页）。
2. 点「打开系统「修改后台运行模式」页」→ 落点提示与 `BATTERY_LANDING_HINT` 一致；ColorOS 真机应直达「耗电行为控制」三选项页。
3. 在系统页选「智能优化」→ 返回 App → 页面自动复检并**仍显示未通过**。
4. 在系统页选「允许完全后台行为」→ 返回 → 自动复检显示已豁免（AOSP 层）+ 提示确认 ColorOS 层。
5. 首启引导电池行、启动弹窗「去开启」→ 都必须先看到"必须选完全后台运行"的说明，再跳系统页。

---

## 四、改动文件清单与工作量

| 文件 | 改动 | 量级 |
|---|---|---|
| `scripts/build-android.mjs` | 加 `syncWebAssets` + `verifyWebAssets` | 小 |
| `android/java/.../MainActivity.java` | `notificationAudit` 扩字段、新增 `notificationProbe` / `openDndSettings`、`openBatteryModeChain` 扩五级、启动弹窗改链路 | 中 |
| `android/java/.../ReminderScheduler.java` | 新增 `buildProbeNotification` | 小 |
| `src/native.js` | 新增 `notificationProbe` / `openDndSettings`，`BATTERY_LANDING_HINT` 补 key | 小 |
| `src/permissions.js` | `auditVerdict` 改三态 + `problems[].code/fix` | 中 |
| `src/ui/permissionCheck.js`（新建） | 三段式检测片段，供两处复用 | 中 |
| `src/ui/notifyGuide.js` | 按钮改 `check`、删自动关窗、删 `test` 假通过 | 中 |
| `src/ui/onboard.js` | 同上 + 电池入口改路由 | 中 |
| `src/ui/reminderView.js` | 新增 `battery-mode` 页面 | 中 |
| `src/main.js` | `keepalive-battery` 改导航 | 小 |
| `tests/*.mjs` | 新增 9 条用例 + `assets-sync` | 小 |

**建议合入顺序**（每步可独立验证）：

1. **打包同步 + `assets-sync` 守卫**（根因 1-A）— 这一步就能让真机上的「我已开启」从"没检测"变成"有检测"，用户感知最直接。
2. **L1 硬事实**（`notificationAudit` 扩字段 + `auditVerdict` 三态 + UI 不关窗）。
3. **L2 实测投递 + L3 人工确认**。
4. **电池链路五级 + `battery-mode` 页面 + 入口收敛**。

---

## 五、明确不做的事（避免过度承诺）

- **不尝试伪造"已开启"**：横幅/锁屏无 API，只能用 L2 实测 + L3 人工确认，文案里必须写清边界，不能让用户以为系统状态被改写了。
- **不引导关闭系统省电**：只引导把本应用设为"允许完全后台行为"，不碰全局省电设置。
- **不把 AOSP 对话框当主路径**：`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 在 ColorOS 上误导性太强，降级为兜底。
