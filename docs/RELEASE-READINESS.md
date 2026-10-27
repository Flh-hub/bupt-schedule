# 发布就绪审计 · 跨厂商适配

> 审计时间：2026-10-26 22:45 · 版本 1.66.32（code 104）
> **更新：22:50 · P1-2 已修 → 1.66.33（code 105）**
> **更新：23:10 · P1-1 + P2-3 已修 → 1.66.34（code 106）**
> **更新：23:20 · 补读小米官方文档 → 1.66.35（code 107）**
> **更新：23:30 · 补读 vivo 文档 → 1.66.36（code 108）**
> **更新：23:40 · 对齐 vivo 社区官方回复 → 1.66.37（code 109）**
> **更新：23:50 · 补读华为官方支持页 → 1.66.38（code 110）**
> **更新：23:45 · 版本号重置为 1.10.x；P0 清单卫生已做 → 1.10.2（code 114）**
> **更新：10-27 08:20 · 深色模式已实现 → 1.11.0（code 115）**
> 方法：读代码 + 跑门禁 + 查 `api-versions.xml` 核对 API 门槛 + 重新打包验证

---

## 一、结论先说

| 发布方式 | 能不能发 | 理由 |
|---|---|---|
| **同学之间传 APK（sideload）** | ✅ **可以发** | 门禁全绿；跨品牌不会崩，最差是"要用户自己去设置里找耗电管理" |
| **上架国内应用商店** | ❌ 还不行 | `targetSdk=33` 低于商店要求（普遍 ≥34）；缺可公网访问的隐私政策 URL |
| **上架 Google Play** | ❌ 基本不可行 | `targetSdk` 需 35；`USE_EXACT_ALARM` / `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 受政策限制 |

---

## 二、门禁现状（全绿）

```
npm test                    474/474 通过
.gate-shape / .gate-notice / .gate-copy / .gate-json   全部 exit=0
node scripts/build-android.mjs                         ✅ 构建成功，资源逐字节回验一致
APK                                                   android/dist/bupt-schedule-1.66.32.apk (0.39MB)
```

---

## 三、跨品牌适配：已经做对的

| 项 | 实现 | 评价 |
|---|---|---|
| 品牌识别 | `Build.MANUFACTURER` → `detectBrand()` 子串匹配 | 覆盖 小米系 / OPPO 系 / vivo 系 / 华为荣耀 / 三星，其余落 `aosp` 兜底（共 6 套路径数据） |
| 厂商深链 | 先试厂商 Component，失败退标准 `Settings.*` Intent | 每条都过 `tryStartActivity()`（全 catch），**非 ColorOS 上不会崩，只会降级** |
| 精确闹钟 | 同时声明 `USE_EXACT_ALARM`(13+ 免授权) + `SCHEDULE_EXACT_ALARM`(12) | ✅ 这是国内 ROM 上闹钟准不准的关键，做对了 |
| 前台服务 | `foregroundServiceType="specialUse"` + `<property>`，`startForeground(id,n,type)` 有 `SDK_INT>=34` 门槛 | ✅ Android 14+ 不会崩 |
| 胶囊提升 | `setShortCriticalText` / 提升请求全部包在 `SDK_INT>=36` 里 | ✅ 低版本走普通通知 |
| 小组件 | RemoteViews 只用白名单控件（裸 `<View>` 已修） | ✅ 各桌面都能 inflate |
| 桌面小组件尺寸 | `targetCell*` 是 API 31+，低版本自动忽略 | ✅ 兼容 |

---

## 四、发现的问题

### P1 · 影响功能（不崩，但用户要自己找）

**1. ~~「耗电管理」直达只在 ColorOS 生效~~ ✅ 1.66.34 已修**

新增 `openBrandBatteryPage()`，排在运行时枚举**之前**。按证据等级分三档：

| 品牌 | 方式 | 证据 |
|---|---|---|
| 三星 | `action=com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY` + `setPackage("com.samsung.android.lool")` + `activity_type=2` | **官方文档**（developer.samsung.com/mobile/app-management.html，2 = never sleeping apps） |
| 小米 / Redmi / POCO | `com.miui.powerkeeper/.ui.HiddenAppsConfigActivity` | **官方允许跳转**（pId=1628：「任何应用都可以调用小米的页面来查看对自己的限制」），但类名仍来自社区实践 |
| 华为 / 荣耀 | `com.huawei.systemmanager|com.hihonor.systemmanager/.startupmgr.ui.StartupNormalAppListActivity` | 社区实践（多篇） |
| vivo / 其它 | **不写** —— 找不到任何可靠来源 | — |

`<queries>` 补了 4 个包（Android 11+ 包可见性，否则显式 ComponentName 起不来）。
每次 `startActivity` 都过 `tryStartActivity()`，打不开就继续往下走，最终仍退应用详情。
测试断言：`MainActivity` 里**不许出现 `com.vivo.`**（没证据就别猜）。

**2. ~~原生后台权限弹窗文案写死 ColorOS 路径~~ ✅ 1.66.33 已修**

`MainActivity#requestBackgroundPermissionIfNeeded()` 的正文和兜底 Toast
都改成读 `backgroundPath()`，按 `Build.MANUFACTURER` 取「页面名 + 选项名」：

| 机型 | 页面 | 该选的选项 |
|---|---|---|
| 小米 / Redmi / POCO | 省电策略 | 无限制 |
| OPPO / OnePlus / realme | 耗电管理 | 允许完全后台行为 |
| vivo / iQOO | 后台耗电管理 | 允许后台高耗电 |
| 华为 / 荣耀 | 应用启动管理 | 允许后台活动 |
| 三星 | 电池 | 不受限制 |
| 其它 | 电池优化 | 不优化 |

正文里那句 ColorOS 专属的「别选「智能优化」」也改成了通用的「别选更省电的那一档」。
测试钉死：正文不许出现 `点「耗电管理」`，且 `backgroundPath()` 必须有 6 个分支。

### P2 · 文案口径不一致

**3. ~~通知落地文案按 ColorOS 命名~~ ✅ 1.66.34 已修**

`landingGuideText(landing, brandId)` 现在收品牌参数：非 ColorOS 时
「权限管理」「通知与控制中心」这些 ColorOS 菜单名一律换成中性说法
（「通知权限页」「通知设置」），兜底路径也从
`设置 › 应用 › 北邮课程表 › 权限管理 › 通知` 变成 `… › 通知`。
`notifyGuide.js` / `onboard.js` 两处调用都传了 `detectBrand(NATIVE.deviceBrand())`。

同一轮还把**电池页**的文案接上了品牌：`keepalive.js` 给 6 个品牌各加了
`power: {page, option}`，`batteryMode.js` 的三选项表、状态行、顶部告示、入口路径全部走
`powerTerms()` —— 小米用户看到的是「省电策略 / 无限制」，不再是「耗电管理 / 允许完全后台行为」。

**4. 主题固定浅色**

`android:theme="@android:style/Theme.Material.Light.NoActionBar"`。
深色模式下系统栏和原生 AlertDialog 仍是浅色，与网页内容（支持深色）不一致。

### P3 · 边界情况

**5. `minSdk 24` 但依赖 ESM**

页面用 `<script type="module">`，需要 WebView ≥ 61（Chrome 61 / 2017）。
Android 7 老机型若 WebView 从未更新过会白屏。国内 ROM 一般跟随系统更新，风险不高但存在。

**6. 纯血鸿蒙（HarmonyOS NEXT）装不了 APK**

华为 Mate 70 及之后的纯鸿蒙机型无法安装，属平台级限制，不是适配问题。
`keepalive.js` 里的 `harmony` 条目只对**兼容 Android 的鸿蒙（HarmonyOS 4 及以前）**有效。

---

## 五、发布前 checklist

### 走 sideload（推荐，成本最低）

- [x] 门禁全绿
- [x] 跨品牌不崩
- [x] 原生后台弹窗按品牌换文案（P1-2，1.66.33 已修）
- [ ] 真机复验隐私弹层（1.66.32 遗留项）

### 走应用商店（还需）

- [ ] **`targetSdk` 33 → 34/35**
      ⚠️ 注意：升到 35 会触发 Android 15 强制 edge-to-edge，
      会动全屏 WebView 的版面（`AndroidManifest.xml` 注释里写明当初停在 33 就是为了躲这个）。
      这是一次**需要真机回归**的改动，不是改个数字。
- [ ] 隐私政策做成可公网访问的 URL（应用内已有 `#/settings/privacy` 全文页）
- [ ] 各商店的实名 / 软著 / 签名流程
- [x] P1-1：品牌直达（三星官方 API / 小米 / 华为）+ `<queries>` 补齐（1.66.34）
- [x] P2-3：通知与电池文案全部按品牌（1.66.34）

---

## 五之二、小米官方文档的两条可用信息

翻了 `dev.mi.com/xiaomihyperos`，和本项目直接相关的有两篇：

**1. 《Powerkeeper 对应用的管控说明》（pId=1628）**

> 2. **任何应用都可以调用小米的页面来查看对自己的限制**；
> 6. 当应用程序调用 `isBackgroundRestricted()` 方法时，返回 true；
> 9. 我们会在未来通过 usagestats 来报告这些专有限制条件。

两条都被用上了：

- 第 2 条 → 我们跳「省电策略」页**有官方依据**（虽然具体类名还是社区给的）。
- 第 6 条 → **厂商那层第一次有了可读信号**。`permissionSnapshot` 新增 `bgRestricted`
  （`ActivityManager.isBackgroundRestricted()`，API 28+ 门槛），
  电池页在它为 `true` 时直接说「系统当前把本应用限制在后台」，
  而不是含糊地说"读不到"。

  ⚠️ 反过来 **`false` 不能当"没被限制"**：其它 ROM 上这个值只反映标准后台限制开关。
  代码和测试都钉死了"只判 true"。

**2. 《自启动权限管理说明》（pId=1624）**

只说原则（默认不可自启动、需告知用户、用户可自行开启），**没有提供任何 API/Intent**。
所以自启动仍然只能给手动路径 —— 和现在的做法一致。

---

## 五之三、vivo 官方文档：没有深链，但查出一处文案错误

翻了 `dev.vivo.com.cn`，文档中心里只有**适配指南**（Android 16/17）、审核规范、广告开通 ——
**没有任何「后台耗电管理」的深链 API**，也没有白名单申请入口。

所以 vivo 维持原判：**不猜深链**，只给手动路径。但顺手查出一处错的：

> 我们原来写「最近任务 → 长按卡片 → 点锁图标锁定」，那是 **MIUI** 的操作。
> vivo 官方社区口径是「**按住卡片往下拉**」锁定，加锁后右上角出现锁形图标。

已在 `keepalive.js` 的 originos 步骤里改正（1.66.36）。

### vivo 社区里有官方技术支持的完整回复

`bbs.vivo.com.cn` 的两个帖子（thread 35976033、38032186）里，
**官方技术支持 / 运营**给的是同一套四步：

1. 设置 → 电池 → **后台耗电管理**（部分机型叫「后台高耗电」）→ 本应用选「允许后台高耗电」
2. **i管家 → 应用管理 → 权限管理 → 权限 → 自启动** → 开启
3. 多任务卡片界面 → **按住卡片往下拉** → 加进加速白名单（右上角出现锁形图标）
4. 设置 → 电池 → 更多设置 → **关闭「睡眠模式」**（夜间会自动清后台）

还有一条值得记：*"若软件被隐藏了，请把软件取消隐藏或移出原子隐私系统"* ——
以及 *"因软件异常占用内存被智慧引擎强行关闭，则是软件自身原因不支持设置"*。

`keepalive.js` 的 originos 条目已按这四步重写（原来写的是「设置 → 应用与权限」，
现在主路径改成 i管家，并补上了**睡眠模式**这一条）。

---

## 五之四、华为：没有开发者深链文档，但官方支持页给了准确路径

`developer.huawei.com` 上只有 AGC（发布/测试/分发）和 HarmonyOS 的受限权限说明，
**没有「应用启动管理」的深链 API**，也没有保活白名单申请入口。
所以华为维持社区类名（`StartupNormalAppListActivity`）+ `tryStartActivity` 兜底。

华为**官方支持页**（consumer.huawei.com `zh-cn15850065`）给的路径是：

> 手机管家 → 应用启动管理 → **手动管理** → 关闭「自动管理」→
> 打开**允许自启动**、**允许关联启动**、**允许后台活动**

据此修正了 `keepalive.js` 里一条写糊涂的步骤（原来写「关闭『休眠时始终保持网络连接』
以外的省电限制项」，逻辑绕且反了）→ 改成
「设置 → 电池 → 更多电池设置 → **打开**『休眠时始终保持网络连接』（否则息屏后会断网）」。

---

## 五之五、发版前的清单卫生（1.10.2 已做）

| 项 | 原状 | 现在 |
|---|---|---|
| `android:usesCleartextTraffic` | `"true"`，和 `network_security_config` 打架 | **删除**（config 已接管：默认禁明文，只放行 `bupt.edu.cn`） |
| `android:allowBackup` | `"true"` | **`false`** —— 备份里有学号课表和 Keystore 加密的口令，换机恢复时密钥不跟走，解密必然失败 |
| 清单里的版本号 | 停在 `103 / 1.66.31`（构建时被覆盖，纯误导） | 同步成当前值 + 注释说明"以构建脚本为准" |
| `android/dist/` | 44 个历史 APK，18MB | **只剩 1.10.2，440KB** |

三条都加了测试（`native-intents.test.mjs`），防止偷偷回来。

### 深色模式：已于 1.11.0 实现

上一版的判断「网页端没有深色样式」是对的，所以做的是**整页方案**：

1. 先把 81 处硬编码颜色收进 14 个语义令牌（1.10.2 那一轮做的重构）；
2. `@media (prefers-color-scheme: dark)` 只覆盖令牌，组件规则不动；
3. 组件级覆盖（课程块兜底色、`today-bar` 渐变、遮罩层）放在**文件末尾** ——
   写在 `:root` 后面会被同权重规则盖掉；
4. 课程块透明度按模式切换：浅色 12% / 深色 25%；
5. 原生侧 `applySystemBars()` + `onConfigurationChanged` 重刷状态栏/导航栏/根背景，
   原生对话框按深浅色选主题。

验证：`npm test` 491/491、四 gate 全绿。
⚠️ 做的时候设备没连上，**还没在真机上切过深色确认观感**。

### 原判断（留档）

上一版审计里写的「深色模式下原生弹窗仍是浅色」只对了一半：
**网页端根本没有深色样式**（`assets/css/app.css` 里 0 条 `prefers-color-scheme`）。
所以现在"整体固定浅色"其实是自洽的；只把原生主题改成 DayNight 会造成
「系统栏变黑、页面还是白」的更差观感。

要做就得整页做（设计令牌 + 每个组件过一遍），单独排期。

---

## 六、已做的修复

**1.66.34 已修 P1-1 + P2-3**：品牌直达链路（三星走官方 deeplink，小米/华为走社区实践，
vivo 不猜）+ 电池页与通知页文案全部品牌化。`npm test` 480/480、四 gate 全绿、已装真机。

**P1-2 已修（1.66.33）**：`requestBackgroundPermissionIfNeeded()` 的弹窗文案按品牌分支，
兜底 Toast 同步。`npm test` 476/476、四道 gate 全绿、已装真机（PLOG110 上
`backgroundPath()` 命中 OPPO 分支，文案与旧版一致，没有回归）。

剩下的按优先级：P1-1（其他品牌的耗电页直达）> P2-3（通知文案口径）> P2-4（深色主题）> P3。
