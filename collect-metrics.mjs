/**
 * 采集排序用的指标：GitHub 星数 + npm 周下载量。
 *
 * 星数来自社区目录 dsh.so 的快照（它已按仓库聚合过星数）。
 * 下载量来自 npm 官方 API —— 注意该接口**不支持 scoped 包批量查询**，
 * 所以 @scope/name 必须逐个查。
 *
 * 用法：node collect-metrics.mjs <dshso.json> <index.json> [输出.json]
 */
import fs from 'node:fs';

const [externalFile, indexFile, outFile = 'metrics.json'] = process.argv.slice(2);
if (externalFile === undefined || indexFile === undefined) {
  console.error('用法: node collect-metrics.mjs <dshso.json> <index.json> [输出.json]');
  process.exit(1);
}

const external = JSON.parse(fs.readFileSync(externalFile, 'utf8'));
const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

/** 从 dsh.so 的 install 命令解析 npm 包名。 */
function npmNameOf(command) {
  if (typeof command !== 'string') return undefined;
  const match = /add\s+(\S+)/.exec(command);
  if (match === null) return undefined;
  const spec = match[1];
  if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('http')) return undefined;
  return spec.replace(/@[\^~]?[0-9][^\s]*$/, '');
}

/** 包名 -> 星数；同一包出现多次时取最大值。 */
const stars = new Map();
/**
 * 无 scope 包名 -> 星数。
 *
 * 社区目录可能把某个包记成 GitHub 源、并用 `@作者/包名` 作为条目名，
 * 而它在 npm 上其实是无 scope 的正式包（例如 dsh-our-free-model）。
 * 这里按「scope 之后的名字」建一份索引，作为精确匹配不到时的兜底。
 * 同名条目可能对应同项目的不同来源，取星数最大的那个。
 */
const starsByBasename = new Map();

for (const entry of external.plugins ?? []) {
  if (typeof entry.stars !== 'number') continue;

  const name = npmNameOf(entry.install);
  if (name !== undefined) {
    const key = name.toLowerCase();
    stars.set(key, Math.max(stars.get(key) ?? 0, entry.stars));
  }

  // 从条目名（alias 或 name）取 scope 之后的部分
  const label = typeof entry.alias === 'string' ? entry.alias : entry.name;
  if (typeof label !== 'string') continue;
  const basename = label.includes('/') ? label.slice(label.lastIndexOf('/') + 1) : label;
  starsByBasename.set(basename, Math.max(starsByBasename.get(basename) ?? 0, entry.stars));
}

/** 查询星数：先精确匹配包名，再按 basename 兜底（同名取最大）。 */
function starsOf(packageName) {
  const key = packageName.toLowerCase();
  if (stars.has(key)) return stars.get(key);
  const basename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  return starsByBasename.get(basename);
}

console.log(`星数索引 ${stars.size} 个包（另有 ${starsByBasename.size} 个按名兜底）`);

const wanted = index.plugins.map((plugin) => plugin.name);
const plain = wanted.filter((name) => !name.startsWith('@'));
const scoped = wanted.filter((name) => name.startsWith('@'));

/** 无 scope 包支持批量查，每批 100 个。遇到 429 退避重试。 */
async function bulkDownloads(names) {
  const result = new Map();
  const CHUNK = 100;
  for (let offset = 0; offset < names.length; offset += CHUNK) {
    const chunk = names.slice(offset, offset + CHUNK);
    const url = `https://api.npmjs.org/downloads/point/last-week/${chunk.join(',')}`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await fetch(url);
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        for (const [name, value] of Object.entries(body)) {
          if (typeof value?.downloads === 'number') result.set(name.toLowerCase(), value.downloads);
        }
        break;
      } catch (error) {
        if (attempt === 5) console.warn(`\n  批量查询失败（${offset}）: ${error.message}`);
        else await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    process.stdout.write(`\r  无 scope 下载量 ${Math.min(offset + CHUNK, names.length)}/${names.length}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  process.stdout.write('\n');
  return result;
}

/** scoped 包只能逐个查。 */
async function scopedDownloads(names, concurrency = 12) {
  const result = new Map();
  const queue = [...names];
  let done = 0;

  async function worker() {
    while (queue.length > 0) {
      const name = queue.shift();
      try {
        const response = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
        if (response.ok) {
          const body = await response.json();
          if (typeof body.downloads === 'number') result.set(name.toLowerCase(), body.downloads);
        }
      } catch {
        // 单个失败不影响整体
      }
      done += 1;
      if (done % 100 === 0) process.stdout.write(`\r  scoped 下载量 ${done}/${names.length}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(`\r  scoped 下载量 ${done}/${names.length}\n`);
  return result;
}

console.log(`查询下载量：无 scope ${plain.length} 个（批量），scoped ${scoped.length} 个（逐个）`);
const downloads = new Map([...(await bulkDownloads(plain)), ...(await scopedDownloads(scoped))]);

const metrics = {};
let withStars = 0;
let withDownloads = 0;
for (const name of wanted) {
  const key = name.toLowerCase();
  const entry = {};
  if (starsOf(name) !== undefined) {
    entry.stars = starsOf(name);
    withStars += 1;
  }
  if (downloads.has(key)) {
    entry.downloads = downloads.get(key);
    withDownloads += 1;
  }
  if (Object.keys(entry).length > 0) metrics[name] = entry;
}

fs.writeFileSync(outFile, JSON.stringify(metrics));
console.log(`\n已写出 ${outFile}`);
console.log(`有星数 ${withStars}/${wanted.length}，有下载量 ${withDownloads}/${wanted.length}`);
