/**
 * .gate-json.mjs — G15：Java 侧读 JSON 必须防 `null`。
 *
 * 【为什么需要这道门】
 * org.json 的 `optString(key, fallback)` 有一个反直觉行为：
 *   fallback **只在键不存在时**生效；若值是 JSON null，它返回字符串 `"null"`。
 * 网页侧 `widget.js` 的契约里 `holidayName: string|null`，普通日子就是 null。
 * 于是 `day.optString("holidayName", "")` 得到 `"null"`（非空！），
 * 拼进 `%1$s · 放假` 后，桌面小组件右上角就印出 **「null · 放假」**
 * （2026-10-24 真机截图发现，1.27.0 修）。
 *
 * 【规则】
 * `android/java/**` 下任何 `.java` 文件里，`optString(` 只允许出现在
 * 各文件自己的 `str()` helper 里的那一行 —— 业务代码一律走 `str(obj, "key")`。
 * 这样新增字段时不会有人再把 null 读成字符串。
 *
 * 退出码：0 PASS / 1 发现越界调用 / 2 门禁自身故障。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'android/java';

/** 唯一允许写 optString 的那一行（str() helper 内部）。 */
const ALLOWED = 'String v = o.optString(key, "");';

function walk(dir) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch (e) {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.java')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
if (files.length === 0) {
  console.log('GATE15: BROKEN');
  console.log('  no-java-files-under=' + ROOT);
  process.exit(2);
}

const bad = [];
const helpers = new Set();

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.includes('optString(')) return;
    // 注释里提到 optString 不算（文档要能写清楚这个坑）
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    if (trimmed.includes(ALLOWED)) {
      helpers.add(file);
      return;
    }
    bad.push(`${file}:${i + 1}  ${trimmed}`);
  });
}

if (bad.length) {
  console.log('GATE15: FAIL');
  console.log('  裸 optString 会把 JSON null 读成字符串 "null"（fallback 不生效）。');
  console.log('  改成 str(obj, "key")：');
  for (const b of bad) console.log('    ' + b);
  process.exitCode = 1;
} else {
  console.log('GATE15: PASS');
  console.log(`  ${files.length} java files, ${helpers.size} str() helper(s), 0 裸调用`);
}
