/**
 * 验证线上索引：真实抓取（禁重定向）+ DSH 原版校验器。
 * 用法：node tools/verify-live.mjs <索引 URL>
 */
import { loadValidator } from './dsh-validator.mjs';

const url = process.argv[2];
if (url === undefined) {
  console.error('用法: node tools/verify-live.mjs <索引 URL>');
  process.exit(1);
}

const { module } = await loadValidator();
const started = Date.now();
const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' } });
console.log('HTTP', response.status, '| 无重定向（redirect: error 未抛错）');

const bytes = new Uint8Array(await response.arrayBuffer());
console.log('大小', (bytes.length / 1048576).toFixed(1), 'MB | 耗时', ((Date.now() - started) / 1000).toFixed(1), 's');

const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const index = module.parseMarketIndex(JSON.parse(text), url);

console.log('校验通过 format=', index.format, '| title=', JSON.stringify(index.title));
console.log('插件', index.plugins.length, '| 版本', index.plugins.reduce((n, p) => n + p.versions.length, 0));
for (const plugin of index.plugins.slice(0, 3)) {
  const version = plugin.versions[0];
  console.log('  -', plugin.name, version.version, JSON.stringify(module.marketInstallTarget(plugin.name, version)));
}
