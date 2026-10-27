# 交接文档 · 北邮课程表（bupt-schedule）

> 面向接手这个项目的开发者 / Agent。看完这份就能继续干活。
> 更细的逐版本过程记录在 `.workbuddy-ai/memory/2026-10-2*.md`。

> **最新进展（1.66.32，2026-10-26 晚）见 [`HANDOFF-2026-10-26.md`](HANDOFF-2026-10-26.md)**：
> 隐私说明、课表滚动手势真凶（`.tt-scroll` 的 `overflow-y`）、活动超出最后一节课的显示与左侧刻度、
> 红线跟随延长区、以及本轮踩过的坑（真机测试三连错 / ColorOS 装包 -99 / 删文件别用 glob 白名单）。

---

## 1. 项目是什么

北京邮电大学的课程表 App：

- **离线 PWA**：纯静态 `index.html` + `src/**`（原生 ESM，无框架、无打包器）
- **Android 壳**：WebView 套壳，`android/java/com/bupt/schedule/*.java`（手写 Java，无 Gradle）
- 特色功能：课前提醒（含流体云/灵动岛胶囊）、桌面小组件、节假日自动静默、导入教务系统课表

**没有 git 仓库。** 改动前建议自己备份一份。

---

## 2. 构建与验证

```bash
node scripts/build-android.mjs     # 打包 APK → android/dist/bupt-schedule-<ver>.apk
npm test                           # 全量单测（当前 440/440）
node .probe-perm-fix.mjs           # jsdom 端到端探针（真实点击路径）
```

打包脚本做的事：同步 `src/**` → `android/assets/www/**`（逐字节回验）→ aapt2 编译资源 →
javac → d8 → zipalign → apksigner。

### 版本号要改两处

| 位置 | 内容 |
|---|---|
| `scripts/build-android.mjs` | `VERSION_NAME` / `VERSION_CODE` |
| `MainActivity.java` | `static final String VERSION` |

### 改 web 资源时

`sw.js` 的 `CACHE` 常量要 +1，否则用户拿到的是旧缓存。

### 守门测试

- `tests/assets-sync.test.mjs`：逐文件比对"装机包 = 源码"。**改完源码忘打包会直接失败**（历史事故）。
- `tests/widget.test.mjs`：RemoteViews 布局白名单、尺寸契约、行版式。
- `tests/permissions.test.mjs`：权限清单与真实落点是否一致。

---

## 3. 三条硬约束

### ① RemoteViews 只能用白名单里的控件

`android/res/layout/widget_*.xml` 里只能用带 `@RemoteView` 注解的类：
`TextView` / `ImageView` / `LinearLayout` / `FrameLayout` / `Button` 等。

**裸 `<View>` 会炸**，报错长这样（桌面进程里，应用侧 catch 不到）：

```
InflateException: Binary XML file line #14 in layout/widget_row:
  Error inflating class android.view.View
Caused by: Class not allowed to be inflated android.view.View
```

坑在于：**只有"有课"那天才会 inflate 到那一行**，没课的日子一切正常 —— 极易漏测。
`widget.test.mjs` 已加断言守住（会先剥掉 XML 注释再检查）。

### ② 通知设置跳转只有一条链路

```js
import { jumpToNotifyPermissionPage } from './notifyGuide.js';
```

所有"去开通知"的按钮都必须走它。**不许直接调** `NATIVE.openNotificationPermissionPage` /
`openNotificationSettingsEx` / `openNotificationCenter`。

历史教训：曾经有 4 个按钮、3 条链路、3 个落点，用户看到的就是"跳错了"。
落点固定为 **设置 › 应用 › 北邮课程表 › 权限管理 › 通知**。

### ③ 不做权限检测

1.66.4 起彻底删除了三段式检测（`src/ui/permissionCheck.js` 已不存在，
`auditVerdict` 已删，原生 `notificationProbe` / `openDndSettings` 也已删）。

「我已经开好了」= 直接收起弹层，只记用户确认。

**理由**：横幅 / 锁屏没有查询 API，读到的开关状态和"到底会不会弹"不等价，
给出的结论半真半假反而误导；探针通知还会打扰用户。真有没有开全，靠课前那条测试通知暴露。

例外是 `src/ui/returnCheck.js`（见下），它只读**系统真有 API** 的三项。

---

## 4. 关键模块

| 文件 | 职责 |
|---|---|
| `src/ui/reminderView.js` | 提醒页 + 后台保活设置页 + `#/reminder/battery-mode` |
| `src/ui/onboard.js` | 首次引导清单（含 `checklistReady()` 供提醒页复用） |
| `src/ui/notifyGuide.js` | 通知指引弹层 + **唯一的通知跳转函数** |
| `src/ui/promoted.js` | 课前胶囊（流体云/灵动岛）试发，两个入口共用 |
| `src/ui/returnCheck.js` | 从系统设置回来自动复查（按机型给路径） |
| `src/ui/batteryMode.js` | 「修改后台运行模式」页 |
| `src/permissions.js` | 权限清单 `buildSteps` / `NOTIFY_MANUAL_ITEMS` / 落地文案 |
| `src/model.js` | `timeToRowUnits` / `periodRangeForTime` / `timePlacement`（活动按时间定位的纯函数） |
| `src/keepalive.js` | 六个厂商的保活路径数据 |
| `ClassCard.java` | 通知卡与胶囊文案（`timeChipText` / `CHIP_USE_CHRONOMETER`） |
| `ClassRefreshService.java` | 胶囊文字按整分钟边界刷新（`nextBoundaryDelay`） |
| `CourseWidget.java` | 桌面小组件渲染（`build` / `buildRow` / `safeRender` 三层兜底） |
| `res/xml/course_widget_info.xml` | 小组件尺寸契约 |

---

## 5. 平台特性（踩过的坑）

### WebView 里 `visibilitychange` 不可靠

Activity 暂停时 WebView 也会被 `onPause`，部分机型回来时不派发 `visibilitychange`。
回前台靠原生回调：

```java
// MainActivity.onResume
web.evaluateJavascript("window.__buptResume&&window.__buptResume()", null);
```

```js
// main.js：两条路汇到同一入口，pending 只消费一次
window.__buptResume = () => { setTimeout(runReturnCheck, 600); };
```

### 浮层层级：提示条必须在所有弹层之上

`.snackbar-host` 的 z-index 曾经是 60，而 `.sheet-host` 是 70 —— 在「补课 / 活动」表单里
点「添加活动」但名称没填时，红色错误提示被画在弹层遮罩**下面**，用户完全看不到（以为点了没反应）。

现在：`snackbar-host` = 100（高于 sheet 70 / dialog 80 / picker 90），并且弹层打开时
`snackbar()` 会把提示条抬到 `.sheet-foot`（按钮行）之上，键盘弹起时也不会被盖住。
守门：`tests/layer-order.test.mjs`。

### 浮层打开时必须锁住页面滚动

弹层只是 `position: fixed`，**下面的文档照旧能滚**：
① 在遮罩上拖动 → 后面的课表跟着走；② 表单比屏幕高时在 `.sheet-body` 滑到底 → 滚动链传给文档；
③ 键盘弹起时 Chromium 为了露出焦点输入框会**程序化**滚动文档，整页抖一下。

现在 `components.js` 的 `syncScrollLock()` 在 sheet / picker / dialog 开关时统一切换
`html.is-overlay-open`（`overflow: hidden` + `clip`），并用 `scrollGuard()` 把程序化滚动弹回原位；
`.sheet-body` 加 `overscroll-behavior: contain`，`.sheet-mask` 加 `touch-action: none`。

### 弹层弹出时不要"闪一下"

两个来源：① 旧代码在 260ms 就 focus 输入框，而滑入动画是 280ms —— 动画没完就弹键盘，
adjustResize 把可视高度改小，贴着底边的面板被瞬间顶上去；
② `.sheet` 的 `max-height` 用 `88vh`，而键盘后的可视高度是另一个口径。
现在：`focusSheetField()` 等 `transitionend`（兜底 360ms）再 `focus({preventScroll:true})`，
`max-height` 改成 `88%`（相对 `.sheet-host`）。
守门：`tests/layer-order.test.mjs` + `.probe-overlay-scroll.mjs`。

### 提交被拦下时**不要**给整个面板做淡入

`sheet()` 的失败分支原来会重放 `.fade-in`（`opacity: 0 → 1` + `translateY(4px)`），
而且加在 `<form class="sheet">` —— 那就是面板本身。于是每点一次「添加活动」，
整块弹层先变透明（能看见后面的课表）再淡回来，用户描述为"闪一下"。
录屏逐帧验证：弹层区域亮度 244 → 166，面板 ghosting。

现在改成 `.sheet.is-nope`：只做 ±5px 水平抖动，keyframes 里**不允许出现 opacity**；
`prefers-reduced-motion` 下不抖。守门：`tests/sheet-feedback.test.mjs`。

### 换页的滚动落点：进入归零、返回还原

`render()` 只替换 `#view` 的 innerHTML，**从不碰滚动** —— 所以从滚到 420px 的课表点进课程详情，
新页会被旧位置钳制（实测停在 21px，顶栏 top = -11px，用户看到"跳转不在顶部"）。

现在（`main.js`）：
- 换页**之前**（DOM 还是旧的）把离开时的 `scrollY` 记进 `routeScrollMemo[routeKey]`；
- 换页后：`popstate` 置位的 `routeFromHistory` 为真 → 还原记忆值，否则 → `scrollTo(0, 0)`；
- 系统返回键走 `web.goBack()`，会触发 popstate，所以"返回回到原位置"自动成立；
- 同页重绘（改节次时间等）`routeChanged === false`，完全不受影响。

守门：`tests/route-scroll.test.mjs`（4 条，钉住"记录早于替换 DOM""只有回退才还原"）。

### 正式版不做"测试通知 / 试发"

1.66.31 起从界面和原生桥里删掉了开发期的三个排障入口：

| 移除 | 位置 |
|---|---|
| 「发一条测试通知」 | `reminderView` 权限卡 + `main.js` 的 `notify-test` + 原生 `notifyTest()` |
| 流体云「试一张」 | `ui/promoted.js`（整文件）+ `notifyGuide` / `onboard` 的 `data-pm` + 原生 `promoteDemo()` |
| 电池页诊断块 | `reminderView.diagHtml()` + `battery-diag` + 原生 `batteryActivities()` / `listPowerActivities()` |
| `TEST_RC = 900001` | `ReminderScheduler` |

**为什么删**：这些入口发的是**假课**（"高等数学（上）5 分钟后"），普通用户看到只会困惑，
点一下还会在通知栏留下一条与真实课表无关的卡片；诊断块更是纯开发者语言。
"到底有没有开全"交给**真实的课前提醒**暴露，而不是让用户点按钮自测。

**保留不变**：真实提醒链路（`ReminderScheduler.notifyNow` / `buildCard` / `ReminderReceiver`）、
课前胶囊（`ClassCard.canPromote`，随真实课程自动出现）、桌面小组件、账号抓取、权限清单与保活指引。

守门：`tests/product-surface.test.mjs`（6 条：三个入口 + `TEST_RC` 不许回来，
同时断言提醒/胶囊/小组件/跳转/清单仍在）。

### sideload 装完应用处于 stopped 状态

Android 规定应用**必须被启动过一次**才退出 stopped。stopped 状态下收不到
`MY_PACKAGE_REPLACED` / `APPWIDGET_UPDATE`，桌面拿不到 RemoteViews，超时就显示
「载入窗口小部件时出现问题」—— 清桌面数据、重启都无效。

`MainActivity.onCreate` 里主动 `CourseWidget.refreshAll(this)` 补一次。

### 改了小组件尺寸，旧实例不会自动变

启动器记着用户当初放下的尺寸。改完必须让用户**删掉重拖**。

### 胶囊时间

- 展开卡用 `setUsesChronometer(true)`（SystemUI 渲染，永远准）
- 胶囊文字是应用自己算的，靠 `ClassRefreshService` 刷新
- 刷新策略是**睡到下一个整分钟边界**，不是固定轮询：

```java
nextBoundaryDelay(start, now) = start - (ceil(ms/60000)-1)*60000 - now
```

换字延迟 ≈0，唤醒 1 次/分钟。`HEARTBEAT_TIMEOUT_MS` 必须 > `MAX_GAP_MS`（现 75s / 60s）。

---

## 6. 文案风格（用户明确要求过多次）

- **一行只说一件事**，短句，不铺技术名词（细节留在设置页里）
- 列表项固定三段：**做什么 / 在哪做 / 不设会怎样**
- 不要出现"检测"字样；不要在标题里拼任何调试信息（曾把 `@22:39:52` 拼进通知标题，
  用户当成上课时间 → "时间不准"）
- 长页面先看**有没有重复表达**，再谈删字（保活页曾把"做什么"和"在哪做"各写了一遍）

---

## 7. 调试手段（重要）

```bash
ADB="D:/Android SDK/platform-tools/adb.exe"   # 路径含空格，必须加引号

"$ADB" devices
"$ADB" install -r android/dist/bupt-schedule-<ver>.apk
"$ADB" logcat -c && "$ADB" logcat -v time > log.txt
"$ADB" logcat -b crash -d                      # 崩溃缓冲
"$ADB" shell dumpsys appwidget | grep -A5 bupt # 小组件实例/Provider 状态
"$ADB" shell dumpsys package com.bupt.schedule | grep versionName
"$ADB" exec-out screencap -p > shot.png        # 截图（存到工作区才能用 Read 打开）
"$ADB" shell input keyevent KEYCODE_HOME
```

设备：**PLG110**（OPPO，ColorOS 16 / Android 16 / SDK 36）。

---

## 8. 当前状态（1.66.31 / versionCode 103）

已装到真机（1.66.31）。用户待做：删掉桌面旧实例 → 重拖一个 → 确认 3×2 观感。

| 项 | 值 |
|---|---|
| 小组件 | 3×2（180×110dp），`targetCell 3/2`，可拖 2~3 列 / 1~5 行 |
| 行版式 | 课名一行 + `时间 · 地点 · 节次` 一行，行高 32dp |
| 胶囊 | 文字版「N分钟后上课」，向上取整，整分钟边界刷新 |
| 测试 | `npm test` 473/473，`node .probe-perm-fix.mjs` 58/58 |
| 活动 | 表单录**具体时间**（08:20–09:00），块按时间比例落格；节次由 `periodRangeForTime` 反推 |

---

## 9. 待办 / 已知问题

1. **ColorOS「耗电管理」直达页仍未命中**。落点是应用详情页，页面底部有诊断块
   （`batteryActivities()` 列出本机能打开的候选页），需要用户截图才能继续定位。
2. 小组件尺寸试过 2×2 / 4×2 / 4×3 / 3×2，用户最终选 **3×2**。
   再改只动 `course_widget_info.xml` 的 `minWidth/minHeight/targetCell*`，
   并提醒用户删掉重拖。
3. 桌面实例的「今天 · 10月26日」在窄屏（< 150dp）会自动省略日期，
   逻辑在 `CourseWidget.widgetWidthDp()`。

---

## 10. 代价最高的一条经验

**1.66.12 → 1.66.19 一共 7 个版本，全在错误假设上打转**：
以为是尺寸契约、以为是预览布局、以为是 stopped 状态，改了又改都不对。
真凶只是 `widget_row.xml` 里一个裸 `<View>`。

接上 USB 跑一次 `adb logcat` 就定位了，30 秒的事。

> **遇到"界面上什么都不显示"的系统级错误，先要日志，再动手。**
> 没有日志就连续猜测，代价是 7 个版本。
