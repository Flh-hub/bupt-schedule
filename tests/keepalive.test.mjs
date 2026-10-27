/**
 * keepalive.test.mjs — 各品牌保活指引的契约。
 *
 * 这份清单是"照着做就能生效"的操作说明，写错一步用户就白折腾，所以钉死：
 *   ① 常见品牌串都能识别到对应分支；
 *   ② 每个分支都必须覆盖三件核心事（通知 / 电池优化 / 自启动或后台活动）；
 *   ③ 每步都是**具体路径**（含 → 或明确开关名），不是"去设置里找找"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BRANDS, CORE_CHECKLIST, WIDGET_NOTES, detectBrand, guideFor, orderedBrands } from '../src/keepalive.js';

test('品牌串识别：常见厂商都能归位', () => {
  assert.equal(detectBrand('Xiaomi'), 'xiaomi');
  assert.equal(detectBrand('Redmi'), 'xiaomi');
  assert.equal(detectBrand('POCO'), 'xiaomi');
  assert.equal(detectBrand('OPPO'), 'coloros');
  assert.equal(detectBrand('OnePlus'), 'coloros');
  assert.equal(detectBrand('realme'), 'coloros');
  assert.equal(detectBrand('vivo'), 'originos');
  assert.equal(detectBrand('iQOO'), 'originos');
  assert.equal(detectBrand('HUAWEI'), 'harmony');
  assert.equal(detectBrand('HONOR'), 'harmony');
  assert.equal(detectBrand('samsung'), 'oneui');
});

test('认不出的品牌走通用 Android，不能报错也不能返回空', () => {
  for (const raw of ['', null, undefined, 'Sony', 'Nokia', '未知厂商']) {
    assert.equal(detectBrand(raw), 'aosp');
  }
  assert.ok(guideFor(detectBrand('Sony')).steps.length >= 2);
});

test('每个品牌都覆盖三件核心事', () => {
  for (const brand of BRANDS) {
    const joined = brand.steps.join(' ');
    assert.ok(/通知/.test(joined) || brand.id === 'aosp', `${brand.id} 缺少通知权限说明（aosp 由通用页承担）`);
    assert.ok(/电池|省电|耗电|不受限制|不优化/.test(joined), `${brand.id} 缺少电池优化步骤`);
    assert.ok(/自启动|后台活动|永不休眠|不受限制/.test(joined), `${brand.id} 缺少后台运行开关`);
    assert.ok(brand.impact.length > 10, `${brand.id} 必须说明"不设会怎样"`);
  }
});

test('每一步都写成了具体路径，不是"去设置里找找"', () => {
  for (const brand of BRANDS) {
    for (const step of brand.steps) {
      assert.ok(step.length >= 8, `${brand.id} 的步骤太短：${step}`);
      assert.ok(
        /→|设置|选择|勾|关闭|打开|选「/.test(step),
        `${brand.id} 的步骤缺少可执行动作：${step}`
      );
    }
    assert.ok(Array.isArray(brand.path) && brand.path.length >= 1, `${brand.id} 缺少设置根路径`);
  }
});

test('核心清单与顺序：当前品牌排第一，其余不重复', () => {
  assert.ok(CORE_CHECKLIST.length === 3);
  const { current, others } = orderedBrands('Redmi');
  assert.equal(current.id, 'xiaomi');
  assert.equal(others.length, BRANDS.length - 1);
  assert.ok(!others.some((b) => b.id === current.id), '其它品牌里不能再出现当前品牌');
  // 品牌 id 唯一
  assert.equal(new Set(BRANDS.map((b) => b.id)).size, BRANDS.length);
});

test('每个品牌都给出「怎么加桌面小组件」的具体路径', () => {
  for (const brand of BRANDS) {
    assert.ok(typeof brand.widget === 'string' && brand.widget.length >= 10, `${brand.id} 缺少小组件添加路径`);
    assert.ok(brand.widget.includes('→'), `${brand.id} 的小组件路径必须是可点的步骤：${brand.widget}`);
    assert.ok(/长按|桌面/.test(brand.widget), `${brand.id} 的小组件路径没说从桌面开始：${brand.widget}`);
  }
});

test('小组件注意事项覆盖：尺寸 / 刷新限制 / 不支持的平台', () => {
  const all = WIDGET_NOTES.join(' ');
  assert.ok(/4×3|250/.test(all), '要说明默认尺寸');
  assert.ok(/30 分钟/.test(all), '要说明冷启动刷新间隔的系统限制');
  assert.ok(/iOS/.test(all) && /鸿蒙|HarmonyOS/.test(all), '要说明 iOS 与纯血鸿蒙不支持');
});
