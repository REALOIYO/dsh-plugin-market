/**
 * 只补下载量：对缺 downloads 的包逐个查 npm API。
 *
 * npm 的批量接口明确拒绝 scoped 包
 * （{"error":"scoped packages are not currently supported in bulk lookups"}），
 * 所以只能逐个查。这里用并发 + 超时 + 进度输出，避免像单线程版本那样卡死。
 */
import fs from 'node:fs';

const [indexFile, metricsFile, outFile] = process.argv.slice(2);
if (!indexFile || !metricsFile || !outFile) {
  console.error('用法: node fill-downloads.mjs <index.json> <metrics.json> <out.json>');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));

const targets = index.plugins
  .map((p) => p.name)
  .filter((n) => !Number.isInteger((metrics[n] ?? {}).downloads));

console.log(`待补下载量: ${targets.length} 个包`);

async function one(name) {
  const url = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body.downloads === 'number' ? body.downloads : null;
    } catch {
      if (attempt === 2) return null;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return null;
}

const out = JSON.parse(JSON.stringify(metrics));
const queue = [...targets];
let done = 0;
let hit = 0;
const CONCURRENCY = 20;

async function worker() {
  while (queue.length > 0) {
    const name = queue.shift();
    const d = await one(name);
    if (d !== null) {
      if (out[name] === undefined) out[name] = {};
      out[name].downloads = d;
      hit += 1;
    }
    done += 1;
    if (done % 200 === 0) {
      process.stdout.write(`\r  ${done}/${targets.length}  命中 ${hit}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write(`\r  ${done}/${targets.length}  命中 ${hit}\n`);

fs.writeFileSync(outFile, JSON.stringify(out));
const total = Object.keys(out).length;
const withD = Object.values(out).filter((v) => Number.isInteger(v.downloads)).length;
const withS = Object.values(out).filter((v) => Number.isInteger(v.stars)).length;
console.log(`\n已写出 ${outFile}`);
console.log(`条目 ${total}，有下载量 ${withD}，有星数 ${withS}`);
