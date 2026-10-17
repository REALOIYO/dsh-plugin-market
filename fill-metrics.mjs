/**
 * 补采缺失的下载量：读现有 metrics.json，只查没有 downloads 的包，合并回去。
 * 用法：node fill-metrics.mjs <index.json> [metrics.json]
 */
import fs from 'node:fs';

const [indexFile, metricsFile = 'metrics.json'] = process.argv.slice(2);
if (indexFile === undefined) {
  console.error('用法: node fill-metrics.mjs <index.json> [metrics.json]');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const metrics = fs.existsSync(metricsFile) ? JSON.parse(fs.readFileSync(metricsFile, 'utf8')) : {};

const missing = index.plugins
  .map((plugin) => plugin.name)
  .filter((name) => metrics[name]?.downloads === undefined);

const plain = missing.filter((name) => !name.startsWith('@'));
const scoped = missing.filter((name) => name.startsWith('@'));
console.log(`缺下载量 ${missing.length} 个（无 scope ${plain.length}，scoped ${scoped.length}）`);

function record(name, value) {
  if (typeof value !== 'number') return;
  metrics[name] = { ...(metrics[name] ?? {}), downloads: value };
}

async function withRetry(url, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
        continue;
      }
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return undefined;
}

let done = 0;
for (let offset = 0; offset < plain.length; offset += 100) {
  const chunk = plain.slice(offset, offset + 100);
  const body = await withRetry(`https://api.npmjs.org/downloads/point/last-week/${chunk.join(',')}`);
  if (body !== undefined) {
    for (const [name, value] of Object.entries(body)) record(name, value?.downloads);
  }
  done += chunk.length;
  process.stdout.write(`\r  无 scope ${done}/${plain.length}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
}
process.stdout.write('\n');

let doneScoped = 0;
async function worker() {
  while (scoped.length > 0) {
    const name = scoped.shift();
    const body = await withRetry(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, 3);
    if (body !== undefined) record(name, body.downloads);
    doneScoped += 1;
    if (doneScoped % 100 === 0) process.stdout.write(`\r  scoped ${doneScoped}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
process.stdout.write(`\r  scoped 完成\n`);

fs.writeFileSync(metricsFile, JSON.stringify(metrics));
const keys = Object.keys(metrics);
console.log(`已更新 ${metricsFile}`);
console.log(`有星数 ${keys.filter((k) => metrics[k].stars !== undefined).length}/${index.plugins.length}`);
console.log(`有下载量 ${keys.filter((k) => metrics[k].downloads !== undefined).length}/${index.plugins.length}`);
