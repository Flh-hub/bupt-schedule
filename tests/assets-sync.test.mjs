/**
 * assets-sync.test.mjs — 装机包必须与源码一致。
 *
 * 【为什么要专门守这一条】
 * 1.65.0 装到手机上，「我已开启」点了没有任何检测。查了半天才发现：
 * `android/assets/www/**` 是 `src/**` 的手工拷贝，早就和源码脱节了 ——
 * 源码里补了检测，包里跑的还是旧版 `data-ng="close"`（点一下直接关窗）。
 * 这类事故不报错、不崩、测源码也全绿，只有用户装上才会发现。
 *
 * 所以把"包 = 源码"变成一条测试：改完 src 忘了同步，`npm test` 直接红。
 * 正常流程不用手动同步 —— `npm run build:android` 会在打包前自动同步。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WWW = path.join('android', 'assets', 'www');

/** 递归列出目录下的相对路径。 */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const files = (dir) => (fs.existsSync(dir) ? walk(dir) : []);

test('装机包存在（没打包过就先跑 npm run build:android）', () => {
  assert.ok(fs.existsSync(WWW), `缺少 ${WWW}：先执行 node scripts/build-android.mjs`);
});

test('src 下的每个文件都必须在装机包里，且内容完全一致', () => {
  const srcDir = 'src';
  const srcFiles = files(srcDir);
  assert.ok(srcFiles.length > 10, 'src 文件数异常，检查测试是否在仓库根目录运行');

  const drift = [];
  for (const rel of srcFiles) {
    const packed = path.join(WWW, 'src', rel);
    if (!fs.existsSync(packed)) {
      drift.push(`装机包缺文件：src/${rel}`);
      continue;
    }
    const a = fs.readFileSync(path.join(srcDir, rel));
    const b = fs.readFileSync(packed);
    if (!a.equals(b)) drift.push(`装机包是旧代码：src/${rel}`);
  }
  assert.deepEqual(drift, [], `装机包与源码不一致，先跑 node scripts/build-android.mjs：\n${drift.join('\n')}`);
});

test('装机包里不许有源码已删除的文件（否则旧模块会被继续加载）', () => {
  const packedSrc = path.join(WWW, 'src');
  if (!fs.existsSync(packedSrc)) return;
  const stale = files(packedSrc).filter((rel) => !fs.existsSync(path.join('src', rel)));
  assert.deepEqual(stale, [], `装机包残留已删除的文件：\n${stale.join('\n')}`);
});

test('index.html 与 manifest 也要同步', () => {
  for (const f of ['index.html', 'manifest.webmanifest']) {
    const packed = path.join(WWW, f);
    assert.ok(fs.existsSync(packed), `装机包缺 ${f}`);
    assert.ok(
      fs.readFileSync(f).equals(fs.readFileSync(packed)),
      `${f} 与源码不一致，先跑 node scripts/build-android.mjs`
    );
  }
});

test('样式表要同步（新组件的 class 缺了就白屏一片）', () => {
  const packed = path.join(WWW, 'assets', 'css', 'app.css');
  if (!fs.existsSync(packed)) return; // 样式不在 assets 时跳过
  assert.ok(
    fs.readFileSync(path.join('assets', 'css', 'app.css')).equals(fs.readFileSync(packed)),
    'assets/css/app.css 与源码不一致，先跑 node scripts/build-android.mjs'
  );
});

/**
 * 版本号四处一致：构建脚本 / MainActivity / 两份 <meta app-version>。
 *
 * 1.66.x 期间踩过：构建脚本和 MainActivity 都升到了 1.66.25，
 * 但两份 `<meta name="app-version">` 还停在 1.65.0 —— 而「设置 › 关于」读的就是 meta，
 * 于是界面上显示的版本号一直是旧的（用户以为没更新成功）。
 */
test('版本号在四处保持一致（含两份 app-version meta）', () => {
  const build = fs.readFileSync(path.join('scripts', 'build-android.mjs'), 'utf8');
  const java = fs.readFileSync(path.join('android', 'java', 'com', 'bupt', 'schedule', 'MainActivity.java'), 'utf8');
  const meta = (file) => {
    const m = fs.readFileSync(file, 'utf8').match(/name="app-version"\s+content="([^"]+)"/);
    return m ? m[1] : null;
  };

  const name = (build.match(/const VERSION_NAME = '([^']+)'/) || [])[1];
  const code = (build.match(/const VERSION_CODE = '([^']+)'/) || [])[1];
  const javaVer = (java.match(/static final String VERSION = "([^"]+)"/) || [])[1];

  assert.ok(name, 'build-android.mjs 里找不到 VERSION_NAME');
  assert.equal(javaVer, name, 'MainActivity.VERSION 与构建脚本不一致');
  assert.equal(meta('index.html'), name, '根目录 index.html 的 app-version 没跟着改');
  assert.equal(
    meta(path.join(WWW, 'index.html')),
    name,
    '装机包里的 app-version 没跟着改（「设置 › 关于」读的是这份）'
  );
  assert.ok(code && Number(code) > 0, 'VERSION_CODE 必须是正整数');
});
