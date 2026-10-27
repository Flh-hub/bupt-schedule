/**
 * scripts/check-apk-assets.mjs — 校验 APK 里解出来的 www 是否自洽。
 *
 * 装到手机上白屏的最常见原因不是代码错，而是**包里的文件不全/路径对不上**：
 * 某个 src 文件没被打进去、HTML 引用的 css 名字改了、模块相对路径写错。
 * 这里就查这一件事：所有相对引用都能在包内找到。
 *
 *   node scripts/check-apk-assets.mjs android/build/www-check/assets/www
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'android/build/www-check/assets/www');
if (!fs.existsSync(root)) {
  console.error(`目录不存在：${root}`);
  process.exit(2);
}

const problems = [];
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(root);

const has = (abs) => fs.existsSync(abs);

/* 1. HTML 里的本地引用 */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
  const target = path.join(root, m[1]);
  if (!has(target)) problems.push(`index.html 引用了不存在的文件：${m[1]}`);
}

/* 2. JS 模块的相对 import */
for (const file of files.filter((f) => f.endsWith('.js'))) {
  const code = fs.readFileSync(file, 'utf8');
  for (const m of code.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,200}?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!has(target)) {
      problems.push(`${path.relative(root, file)} 引用了不存在的模块：${m[1]}`);
    }
  }
  for (const m of code.matchAll(/import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!has(target)) problems.push(`${path.relative(root, file)} 动态引用了不存在的模块：${m[1]}`);
  }
}

/* 3. 关键文件必须在 */
for (const required of [
  'index.html',
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/icons/icon-192.png',
  'src/main.js',
  'src/native.js',
  'src/ui/import.js',
  'src/parsers/html.js'
]) {
  if (!has(path.join(root, required))) problems.push(`缺少关键文件：${required}`);
}

console.log(`检查 ${files.length} 个文件，引用问题 ${problems.length} 个`);
for (const p of problems) console.error('  ✗ ' + p);
process.exit(problems.length ? 1 : 0);
