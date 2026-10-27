/**
 * sw-precache.test.mjs — Service Worker 预缓存必须覆盖所有源码文件。
 *
 * 这个坑踩过两次（1.12.0 的 ui/dragdrop.js、1.60.0 的 ui/onboard.js + ui/notifyGuide.js）：
 * 新增模块忘了加进 PRECACHE → 网页版离线打开时 import 404，直接白屏。
 * 与其等真机发现，不如让测试遍历目录比对。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sw = fs.readFileSync('sw.js', 'utf8');

/** 递归列出 src 下的所有 js。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

test('src/ 下每个 js 都必须在 sw.js 的预缓存清单里', () => {
  const files = walk('src');
  assert.ok(files.length > 15, '源码文件数异常，检查 walk');
  const missing = files.filter((f) => !sw.includes(`'./${f}'`));
  assert.deepEqual(missing, [], `以下文件没进预缓存，离线会 404：\n${missing.join('\n')}`);
});

test('入口与静态资源也在清单里', () => {
  for (const need of ['./index.html', './manifest.webmanifest', './assets/css/app.css']) {
    assert.ok(sw.includes(`'${need}'`), `预缓存缺少 ${need}`);
  }
});

test('每次改动都要动 CACHE 版本号（防设备端 cache-first 不更新）', () => {
  const m = sw.match(/const CACHE = 'bupt-v(\d+)'/);
  assert.ok(m, 'CACHE 常量格式变了？');
  assert.ok(Number(m[1]) >= 28, 'CACHE 版本应随本次改动递增');
});
