/**
 * scripts/build-android.mjs — 零 Gradle 构建 Android APK。
 *
 * 为什么不用 Gradle：本项目定位"零构建依赖"，装 Gradle + AGP 要拉几百 MB，
 * 而这个小壳只需要 aapt2 / javac / d8 / apksigner 四个命令行工具——本机 SDK 里全都有。
 *
 * 用法：
 *   node scripts/build-android.mjs
 *   ANDROID_SDK_ROOT="D:\\Android SDK" JAVA_HOME="D:\\JDK" node scripts/build-android.mjs
 *
 * 产物：android/dist/bupt-schedule-<version>.apk（已签名，可直接安装）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const AND = path.join(ROOT, 'android');
const BUILD = path.join(AND, 'build');
const DIST = path.join(AND, 'dist');

const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || 'D:\\Android SDK';
const JDK_HOME = process.env.JAVA_HOME || 'D:\\JDK';
const BUILD_TOOLS = process.env.BUILD_TOOLS_VERSION || '35.0.0';
const PLATFORM = process.env.ANDROID_PLATFORM || 'android-36';

const BT = path.join(SDK, 'build-tools', BUILD_TOOLS);
const ANDROID_JAR = path.join(SDK, 'platforms', PLATFORM, 'android.jar');
const JAVA = path.join(JDK_HOME, 'bin', 'java.exe');
const JAVAC = path.join(JDK_HOME, 'bin', 'javac.exe');
const JAR = path.join(JDK_HOME, 'bin', 'jar.exe');
const KEYTOOL = path.join(JDK_HOME, 'bin', 'keytool.exe');
/**
 * ★ 打包必须用 aapt **v1**，不能用 aapt2。
 *   Windows 版 aapt2 的 `-A assets` 会把子目录写成反斜杠
 *   （`assets/www\src\main.js`），AssetManager 按正斜杠找不到文件，
 *   装到手机上就是一片白屏。实测 aapt v1 输出的路径是正确的 `/`。
 */
const AAPT = path.join(BT, 'aapt.exe');
const AAPT2 = path.join(BT, 'aapt2.exe');
const ZIPALIGN = path.join(BT, 'zipalign.exe');
const D8_JAR = path.join(BT, 'lib', 'd8.jar');
const APKSIGNER_JAR = path.join(BT, 'lib', 'apksigner.jar');

const VERSION_NAME = '1.13.5';
const VERSION_CODE = '135';
const MIN_SDK = '24';
const TARGET_SDK = '33';

const KEYSTORE = path.join(AND, 'keystore', 'bupt-debug.jks');
const KS_PASS = 'buptschedule';
const KS_ALIAS = 'bupt';
const OUT_APK = path.join(DIST, `bupt-schedule-${VERSION_NAME}.apk`);

/* ---------------------------------------------------------------- helpers */

const problems = [];
function check(p, what) {
  if (!fs.existsSync(p)) problems.push(`${what} 不存在：${p}`);
}

function run(cmd, args, label) {
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (res.error) throw new Error(`${label} 启动失败：${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label} 失败（exit=${res.status}）`);
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function fresh(dir) {
  // 不直接 rm -rf 目录本身：某些环境里目录被占用（编辑器 / 沙箱回收站）会整体失败。
  // 逐项删，删不掉的跳过即可——残留文件最多被覆盖，不会污染产物。
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      } catch (err) {
        console.warn(`  ! 未能清理 ${entry}（${err.message}），继续`);
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 读 APK 的中央目录，检查三件装到手机上会"白屏/装不上"的事：
 *   1. 条目名里不能有反斜杠（AssetManager 只认 `/`）
 *   2. resources.arsc 必须是 STORE（不压缩），Android 11+ 强制要求
 *   3. 关键文件必须在包里
 */
function inspectApk(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP / APK');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  let arscCompressed = false;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    names.push(name);
    if (name === 'resources.arsc' && method !== 0) arscCompressed = true;
    p += 46 + nameLen + extraLen + cmtLen;
  }
  const badNames = names.filter((n) => n.includes('\\'));
  return { names, badNames, arscCompressed };
}

/* ---------------------------------------------------------------- 0. 预检 */

check(ANDROID_JAR, 'android.jar');
check(AAPT, 'aapt');
check(AAPT2, 'aapt2');
check(ZIPALIGN, 'zipalign');
check(D8_JAR, 'd8.jar');
check(APKSIGNER_JAR, 'apksigner.jar');
check(JAVA, 'java');
check(JAVAC, 'javac');
check(KEYTOOL, 'keytool');
if (problems.length) {
  console.error('\n构建环境不完整：');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n用 ANDROID_SDK_ROOT / JAVA_HOME 指定路径后重试。');
  process.exit(1);
}

/* ---------------------------------------------------------------- 1. 整理目录 */

console.log('准备构建目录…');
fresh(BUILD);
fs.mkdirSync(path.join(BUILD, 'classes'), { recursive: true });
fs.mkdirSync(path.join(BUILD, 'gen'), { recursive: true });
fs.mkdirSync(path.join(BUILD, 'gen'), { recursive: true });
fs.mkdirSync(path.join(BUILD, 'dex'), { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

/* ---------------------------------------------------------------- 2. 打包网页 */

const WWW = path.join(AND, 'assets', 'www');
fresh(WWW);
for (const item of ['index.html', 'manifest.webmanifest', 'src', 'assets']) {
  const from = path.join(ROOT, item);
  const to = path.join(WWW, item);
  fs.cpSync(from, to, { recursive: true });
  process.stdout.write(`  · ${item}\n`);
}
// sw.js 不进 APK：资源在本地，注册 SW 只会多一层缓存（src/main.js 里已跳过）
fs.rmSync(path.join(WWW, 'sw.js'), { force: true });

/* 同步完立刻回验一遍。
 * 【为什么值得多这一步】1.65.0 出过一次事故：源码里补了「我已开启」的检测，
 * 但装机包里跑的还是旧版（点一下直接关窗），用户装上才发现。
 * cpSync 正常时这里必然全等；一旦有人改动路径/过滤规则导致漏拷，这里会当场红。
 */
{
  const drift = [];
  const cmp = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        cmp(full, sub);
        continue;
      }
      const packed = path.join(WWW, sub);
      if (!fs.existsSync(packed) || !fs.readFileSync(full).equals(fs.readFileSync(packed))) {
        drift.push(sub);
      }
    }
  };
  // 只比"被同步进包"的那四项，其它目录（android/ docs/ tests/）本来就不该进包
  for (const item of ['index.html', 'manifest.webmanifest', 'src', 'assets']) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).isDirectory()) cmp(from, item);
    else {
      const packed = path.join(WWW, item);
      if (!fs.existsSync(packed) || !fs.readFileSync(from).equals(fs.readFileSync(packed))) {
        drift.push(item);
      }
    }
  }
  if (drift.length) {
    throw new Error(`打包内容与源码不一致（同步失败）：\n  ${drift.join('\n  ')}`);
  }
  console.log('  · 回验：装机内容与源码逐字节一致');
}

/* ------------------------------------------------- 2.5 生成带版本号的清单
 * aapt v1 的 --version-code / --version-name 只在清单「没有」该属性时才生效，
 * 清单里写了就一定以清单为准（1.10.0 / 1.11.0 两个包因此都还是 1.9.0）。
 * 这里改成构建时从源清单派生一份、把版本写死进去，让 VERSION_* 成为唯一来源。
 */
const MANIFEST = path.join(BUILD, 'AndroidManifest.xml');
{
  const src = fs.readFileSync(path.join(AND, 'AndroidManifest.xml'), 'utf8');
  const patched = src
    .replace(/android:versionCode="[^"]*"/, `android:versionCode="${VERSION_CODE}"`)
    .replace(/android:versionName="[^"]*"/, `android:versionName="${VERSION_NAME}"`);
  if (patched === src && !src.includes(`android:versionCode="${VERSION_CODE}"`)) {
    throw new Error('清单里找不到 android:versionCode，无法写入版本号');
  }
  fs.writeFileSync(MANIFEST, patched);
  console.log(`  · AndroidManifest.xml → versionCode=${VERSION_CODE} versionName=${VERSION_NAME}`);
}

/* ---------------------------------------------------------------- 3. 资源 + 壳 + assets */

run(
  AAPT,
  [
    'package',
    '-f',
    '-M',
    MANIFEST,
    '-S',
    path.join(AND, 'res'),
    '-A',
    path.join(AND, 'assets'),
    '-I',
    ANDROID_JAR,
    '-J',
    path.join(BUILD, 'gen'),
    '-F',
    path.join(BUILD, 'base.apk'),
    '--min-sdk-version',
    MIN_SDK,
    '--target-sdk-version',
    TARGET_SDK,
    '--version-code',
    VERSION_CODE,
    '--version-name',
    VERSION_NAME
  ],
  'aapt package（清单 + 资源 + assets）'
);

/* ---------------------------------------------------------------- 5. 编译 Java */

// R.java 由 aapt -J 生成（Java 里引用了 R.drawable.ic_notify 这类资源 id）
const javaFiles = [
  ...walk(path.join(AND, 'java'), (f) => f.endsWith('.java')),
  ...walk(path.join(BUILD, 'gen'), (f) => f.endsWith('.java'))
];
console.log(`\nJava 源文件 ${javaFiles.length} 个（含 aapt 生成的 R.java）`);
run(
  JAVAC,
  [
    '-encoding',
    'UTF-8',
    '-source',
    '8',
    '-target',
    '8',
    '-bootclasspath',
    ANDROID_JAR,
    '-classpath',
    ANDROID_JAR,
    '-d',
    path.join(BUILD, 'classes'),
    ...javaFiles
  ],
  'javac（编译）'
);

/* ---------------------------------------------------------------- 6. dex */

const classFiles = walk(path.join(BUILD, 'classes'), (f) => f.endsWith('.class'));
run(
  JAVA,
  [
    '-cp',
    D8_JAR,
    'com.android.tools.r8.D8',
    '--min-api',
    MIN_SDK,
    '--lib',
    ANDROID_JAR,
    '--output',
    path.join(BUILD, 'dex'),
    ...classFiles
  ],
  'd8（生成 classes.dex）'
);

/* ---------------------------------------------------------------- 7. 合包 */

run(
  JAR,
  ['--update', '--file', path.join(BUILD, 'base.apk'), '-C', path.join(BUILD, 'dex'), 'classes.dex'],
  'jar（把 classes.dex 装进 APK）'
);

/* ---------------------------------------------------------------- 7.5 自检包内容 */

{
  const report = inspectApk(path.join(BUILD, 'base.apk'));
  const required = [
    'AndroidManifest.xml',
    'resources.arsc',
    'classes.dex',
    'assets/www/index.html',
    'assets/www/src/main.js',
    'assets/www/src/native.js',
    'assets/native/capture.js'
  ];
  const missing = required.filter((n) => !report.names.includes(n));
  const fatal = report.badNames.length || report.arscCompressed || missing.length;
  console.log(
    `\n▶ 包内容自检：${report.names.length} 个条目` +
      (fatal ? '' : '，路径 / arsc / 关键文件全部正常')
  );
  for (const n of report.badNames.slice(0, 5)) console.error(`  ✗ 条目名含反斜杠：${n}`);
  if (report.arscCompressed) console.error('  ✗ resources.arsc 被压缩了（Android 11+ 装不上）');
  for (const n of missing) console.error(`  ✗ 缺少 ${n}`);
  if (fatal) process.exit(1);
}

/* ---------------------------------------------------------------- 8. 对齐 */

run(
  ZIPALIGN,
  ['-f', '4', path.join(BUILD, 'base.apk'), path.join(BUILD, 'aligned.apk')],
  'zipalign（4 字节对齐）'
);

/* ---------------------------------------------------------------- 9. 签名 */

if (!fs.existsSync(KEYSTORE)) {
  fs.mkdirSync(path.dirname(KEYSTORE), { recursive: true });
  run(
    KEYTOOL,
    [
      '-genkeypair',
      '-keystore',
      KEYSTORE,
      '-alias',
      KS_ALIAS,
      '-storepass',
      KS_PASS,
      '-keypass',
      KS_PASS,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-dname',
      'CN=BUPT Schedule, OU=Personal, O=Personal, L=Beijing, ST=Beijing, C=CN'
    ],
    'keytool（生成签名证书）'
  );
} else {
  console.log('\n▶ 复用已有签名证书');
}

if (fs.existsSync(OUT_APK)) fs.rmSync(OUT_APK, { force: true });
run(
  JAVA,
  [
    '-jar',
    APKSIGNER_JAR,
    'sign',
    '--ks',
    KEYSTORE,
    '--ks-key-alias',
    KS_ALIAS,
    '--ks-pass',
    `pass:${KS_PASS}`,
    '--key-pass',
    `pass:${KS_PASS}`,
    '--min-sdk-version',
    MIN_SDK,
    '--out',
    OUT_APK,
    path.join(BUILD, 'aligned.apk')
  ],
  'apksigner（签名）'
);

/* ---------------------------------------------------------------- 10. 自检 */

run(JAVA, ['-jar', APKSIGNER_JAR, 'verify', '--min-sdk-version', MIN_SDK, OUT_APK], 'apksigner verify（校验签名）');

// 包信息必须和 VERSION_* 一致：aapt v1 会以清单为准，写错一次就发错版本，所以硬校验。
{
  const res = spawnSync(AAPT2, ['dump', 'badging', OUT_APK], { encoding: 'utf8', cwd: ROOT });
  const out = res.stdout || '';
  console.log(out);
  const code = /versionCode='(\d+)'/.exec(out)?.[1];
  const name = /versionName='([^']*)'/.exec(out)?.[1];
  if (code !== VERSION_CODE || name !== VERSION_NAME) {
    console.error(
      `\n✗ 包版本与构建常量不一致：包内 ${name}(${code})，期望 ${VERSION_NAME}(${VERSION_CODE})`
    );
    process.exit(1);
  }
}

const sizeMb = (fs.statSync(OUT_APK).size / 1024 / 1024).toFixed(2);
console.log(`\n✅ 构建完成：${OUT_APK}  (${sizeMb} MB)`);
