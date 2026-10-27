/**
 * qa-syntax.test.mjs — 语法门禁：`src/**`、`sw.js`、`server.js` 每个文件都要能通过 `node --check`。
 *
 * 【为什么需要单独一条】
 * 单元测试只 import 纯逻辑层（parsers / model / calendar…），**从不加载 ui/*.js**，
 * 所以 UI 文件里的语法错误测试是绿的、装到手机上才白屏。
 * 2026-10-23 就吃过一次：脚本化删除一段模板字符串时切错了位置，`ui/import.js`
 * 直接语法错误，233 条测试全过、只有 jsdom 探针才报出来。这条把它变成必过项。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

test('所有 JS 文件通过 node --check（含 UI 层）', () => {
  const files = [...walk('src'), 'sw.js'];
  assert.ok(files.length >= 15, `源文件太少（${files.length}），walk 可能没走全`);

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      const detail = String(err.stderr || err.message || '')
        .split('\n')
        .slice(0, 4)
        .join(' ')
        .trim();
      broken.push(`${file}: ${detail}`);
    }
  }
  assert.deepEqual(broken, [], '存在语法错误的文件（装到手机上会白屏）');
});
