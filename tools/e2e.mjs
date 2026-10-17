/**
 * 完整复现 DSH 的读取流程：本地 HTTP 服务 + 与 Host 相同的抓取方式 + 严格校验。
 * 用来确认「托管出去之后，DSH 真的能读」。
 *
 * 用法：node tools/e2e.mjs <索引文件.json>
 */
import http from 'node:http';
import fs from 'node:fs';
import { loadValidator } from './dsh-validator.mjs';

const file = process.argv[2];
if (file === undefined) {
  console.error('用法: node tools/e2e.mjs <索引文件.json>');
  process.exit(1);
}

const { module } = await loadValidator();
const { marketInstallTarget, parseMarketIndex } = module;

const body = fs.readFileSync(file);
const server = http.createServer((request, response) => {
  if (request.url === '/index.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  } else {
    response.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/index.json`;
console.log('服务器:', url);

try {
  // 与 dsh-plugin-market 的 fetchIndex 一致：拒绝重定向、只接受 application/json
  const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' } });
  console.log('HTTP', response.status, 'ok=', response.ok);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const index = parseMarketIndex(JSON.parse(text), url);
  console.log('解析成功 format=', index.format, 'title=', JSON.stringify(index.title));
  for (const plugin of index.plugins) {
    const version = plugin.versions[0];
    console.log('  -', plugin.name, version.version, 'install=', JSON.stringify(marketInstallTarget(plugin.name, version)));
  }
  console.log(`\n共 ${index.plugins.length} 个插件，${body.length} 字节。`);
} catch (error) {
  console.log('失败:', error.message);
  process.exitCode = 2;
} finally {
  server.close();
}
