/**
 * scripts/fetch-jwgl.mjs — 在本机登录北邮教务系统（金智 jsxsd）并把课表页 HTML 存下来。
 *
 * 【为什么做成脚本，而不是 App 里的"账号直连"】
 * 教务系统只认登录态，纯前端网页受跨域限制拿不到 —— 所以 App 里那个入口一直是置灰的。
 * 这个脚本跑在**你自己的电脑上**：密码只进内存，不写文件、不打印、不上传，
 * 登完就把课表页 HTML 落盘，交给 App 的「导入 → HTML 源码」通道。
 *
 * 用法（在项目目录下）：
 *   node scripts/fetch-jwgl.mjs
 *   # 可选：node scripts/fetch-jwgl.mjs --account 2021xxxxxx --out jwgl-dump.html
 *
 * 只做两件事：登录 → 找课表页 → 存 HTML。不做任何写操作（不改选课、不改成绩）。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const BASE = 'https://jwgl.bupt.edu.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------------------------------------------------------- 参数 */

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const OUT = path.resolve(argOf('--out') || 'jwgl-dump.html');

/* ---------------------------------------------------------------- Cookie */

/** 极简 cookie jar（Node fetch 不自动保存 Set-Cookie）。 */
const jar = new Map();

function absorbCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of list) {
    const [pair] = String(line).split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 带 cookie 的请求（手动跟随跳转，保证每一步都吃到 Set-Cookie）。
 * @returns {Promise<{res: Response, text: string, url: string}>}
 */
async function request(url, init = {}, maxHops = 6) {
  let current = url;
  let options = { ...init };
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const res = await fetch(current, {
      ...options,
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: options.headers && options.headers.Accept ? options.headers.Accept : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': hop === 0 ? 'none' : 'same-origin',
        'Sec-Fetch-User': '?1',
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
        ...(options.headers || {})
      }
    });
    absorbCookies(res.headers);

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      // 303 / 302 跳转后按浏览器行为降级为 GET
      options = { method: 'GET' };
      continue;
    }
    const text = await res.text();
    return { res, text, url: current };
  }
  throw new Error('跳转次数过多，登录流程异常');
}

/* ---------------------------------------------------------------- 金智 encodeInp */

/**
 * 金智 jsxsd 的凭据混淆（页面 conwork.js 里的 encodeInp）。
 * 它用的是**标准 Base64 字母表**（A-Za-z0-9+/=），不是有些老教程里写的自定义表；
 * 所以这里直接用 Buffer 的 base64 即可（学号/密码都是 ASCII 时完全等价）。
 */
function encodeInp(input) {
  return Buffer.from(String(input), 'utf8').toString('base64');
}

/* ---------------------------------------------------------------- 交互输入 */

function askVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 隐藏输入的密码框（不回显、不进 shell 历史、不进日志）。 */
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // 非 TTY（比如双击运行）退化为普通输入，并明确提示
      askVisible(question).then(resolve);
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n已取消\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/* ---------------------------------------------------------------- 主流程 */

const KB_PATTERN = /(kbxx|kbcx|kb_list|xsgrxx|课程表|课表)/i;

async function main() {
  const account = argOf('--account') || (await askVisible('学号（账号）：'));
  if (!account) {
    console.error('未输入账号，已退出');
    process.exit(1);
  }
  const password = await askHidden('密码（输入时不显示）：');
  if (!password) {
    console.error('未输入密码，已退出');
    process.exit(1);
  }

  console.log('\n[1/4] 打开登录页…');
  const loginPage = await request(`${BASE}/jsxsd/framework/xsMain_bjyddx.jsp`);
  if (!/<form[^>]+LoginToXk/i.test(loginPage.text)) {
    if (KB_PATTERN.test(loginPage.url)) {
      console.log('看起来已经有登录态，直接抓课表页。');
    } else {
      console.warn('未发现登录表单，页面结构可能变了（继续尝试登录接口）。');
    }
  }

  console.log('[2/4] 提交登录…');
  const encoded = `${encodeInp(account)}%%%${encodeInp(password)}`;
  const body = new URLSearchParams({
    userAccount: account,
    userPassword: '',
    encoded
  }).toString();

  const loginRes = await request(`${BASE}/jsxsd/xk/LoginToXk`, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/jsxsd/framework/xsMain_bjyddx.jsp`,
      Origin: BASE
    }
  });

  const failed = /用户名|密码|错误|验证码|锁定|冻结/.test(loginRes.text) && /登录/.test(loginRes.text);
  if (/请输入正确的|密码错误|用户名或密码|账号或密码/.test(loginRes.text)) {
    console.error('\n登录失败：账号或密码不正确。');
    console.error('（如果是刚改过密码，请先用浏览器登录确认一次）');
    process.exit(2);
  }
  if (failed && !/jsxsd\/(framework|kbcx|xs)/.test(loginRes.url)) {
    console.warn('登录返回内容含"登录"字样，可能没成功；仍继续尝试抓课表。');
  }

  console.log('[3/4] 定位课表页…');
  const candidates = [
    '/jsxsd/kbcx/kbxx_xskb',
    '/jsxsd/kbcx/kbxx_xskb?xnxq01id=',
    '/jsxsd/framework/xsMain_bjyddx.jsp'
  ];

  const mainPage = await request(`${BASE}/jsxsd/framework/xsMain_bjyddx.jsp`);
  const hrefs = [...mainPage.text.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => KB_PATTERN.test(h))
    .slice(0, 10);
  for (const href of hrefs) {
    try {
      candidates.push(new URL(href, BASE).toString().replace(BASE, ''));
    } catch (err) {
      /* 忽略非法链接 */
    }
  }

  let best = null;
  for (const pathOrUrl of candidates) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
    try {
      const page = await request(url, {
        headers: { Referer: `${BASE}/jsxsd/framework/xsMain_bjyddx.jsp` }
      });
      const score = (page.text.match(/星期一|周一|节次|课程名称/g) || []).length;
      console.log(`  ${url.replace(BASE, '')} → ${page.text.length} 字节，课表特征 ${score}`);
      if (score >= 2 && (!best || page.text.length > best.text.length)) {
        best = { url, text: page.text, score };
      }
    } catch (err) {
      console.log(`  ${pathOrUrl} → 失败：${err.message}`);
    }
  }

  if (!best) {
    console.error('\n没找到课表页。请在浏览器里登录后打开"课表查询"，把页面地址发我，我再补上这条路径。');
    process.exit(3);
  }

  console.log('[4/4] 写入文件…');
  fs.writeFileSync(OUT, best.text, 'utf8');
  console.log(`\n完成：${OUT}（${best.text.length} 字节）`);
  console.log(`来源页：${best.url}`);
  console.log('下一步：把上面的文件路径告诉我，我来解析成课表。');
}

main().catch((err) => {
  console.error('\n出错：', err && err.message ? err.message : err);
  process.exit(1);
});
