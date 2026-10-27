/**
 * server.js — 仅用于「服务器能不能访问教务系统」的可验证探针。
 *
 * 除了照常发静态文件，只多一个接口：
 *   GET /api/probe  → 从**这台服务器**发起一次到 jwgl.bupt.edu.cn 的请求，回报结果
 *
 * 为什么需要它：静态托管时代码跑在浏览器里，永远反映不了服务器出口的网络。
 * 只有让服务器自己去访问一次，才能知道云端环境能不能登教务系统。
 *
 * 注意：`/.cloud/**` 由平台的网关直接接管（云服务数据面），不该经过这里；
 * 若请求真的落到这里，返回明确的 JSON 而不是 HTML，便于排查。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

/** 从服务器出口测一次教务系统。 */
async function probeUrl(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bytes: text.length,
      isLoginPage: /<title>\s*登录\s*<\/title>/.test(text),
      hasLoginForm: /LoginToXk/.test(text)
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      reason: err && err.name === 'AbortError' ? 'timeout' : 'fetch-failed',
      // cause.code 才是根因：ENOTFOUND=DNS 解析不到，ECONNREFUSED=出口被拒，ETIMEDOUT=不通
      cause: (err && err.cause && (err.cause.code || err.cause.message)) || null,
      error: err && err.name === 'AbortError' ? '超时（12s 无响应）' : String((err && err.message) || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // sw.js 必须每次回源，否则缓存版本升不上去
      'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/probe') {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    // 同时测两个目标：教务系统 + 一个普通公网站点
    // 用来区分「容器完全出不了网」和「只是学校/目标站不通」
    Promise.all([
      probeUrl('https://jwgl.bupt.edu.cn/jsxsd/framework/xsMain_bjyddx.jsp'),
      probeUrl('https://example.com/')
    ]).then(([jwgl, ref]) => json(res, 200, { jwgl, ref }));
    return;
  }

  if (url.pathname.startsWith('/.cloud/')) {
    json(res, 404, { ok: false, error: 'cloud data plane is served by the platform gateway, not the app' });
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  // 只打印端口，不打印任何环境内容
  process.stdout.write(`listening on ${PORT}\n`);
});
