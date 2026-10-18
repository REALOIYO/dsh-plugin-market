/**
 * 用 GitHub API 补全缺失的星数。
 *
 * 只处理 index.json 中缺 metrics 的记录，按 repository.url 取 owner/repo，
 * 调用 /repos/{owner}/{repo} 读 stargazers_count。
 *
 * 隐私：不写任何本机路径、用户名或 token 到输出；token 只从环境变量读。
 */
import fs from 'node:fs';

const [indexFile, metricsFile, outFile] = process.argv.slice(2);
if (!indexFile || !metricsFile || !outFile) {
  console.error('用法: node fill-stars.mjs <index.json> <metrics.json> <out.json>');
  process.exit(1);
}

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));

/** 从 repository.url 取 {owner, repo}，只接受 github.com。 */
function githubSlug(url) {
  if (typeof url !== 'string') return undefined;
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url.trim());
  if (m === null) return undefined;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  if (!owner || !repo) return undefined;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  return `${owner}/${repo}`;
}

// 只处理完全没有 metrics 的插件
const targets = [];
for (const plugin of index.plugins) {
  if (metrics[plugin.name] !== undefined) continue;
  const slug = githubSlug(plugin.repository?.url);
  if (slug === undefined) continue;
  targets.push({ name: plugin.name, slug });
}

// 同一个仓库可能被多个包引用，去重后只查一次
const uniqueSlugs = [...new Set(targets.map((t) => t.slug.toLowerCase()))];
console.log(`待补星数: ${targets.length} 个插件 -> ${uniqueSlugs.length} 个唯一仓库`);

async function getRepo(slug) {
  const url = `https://api.github.com/repos/${slug}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${TOKEN}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'dsh-plugin-market-index',
      },
    });
    if (res.ok) {
      const body = await res.json();
      return { stars: body.stargazers_count, full: body.full_name };
    }
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      const waitMs = attempt * 2000;
      console.warn(`\n  速率限制 remaining=${remaining} reset=${reset}，等待 ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (attempt === 4) return null;
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return null;
}

const starOf = new Map(); // slug(小写) -> stars
let done = 0;
let hit = 0;
let miss = 0;

const CONCURRENCY = 8;
const queue = [...uniqueSlugs];

async function worker() {
  while (queue.length > 0) {
    const slug = queue.shift();
    const res = await getRepo(slug);
    if (res === null) {
      miss += 1;
    } else if (typeof res.stars === 'number') {
      starOf.set(slug, res.stars);
      hit += 1;
    }
    done += 1;
    if (done % 50 === 0) {
      process.stdout.write(`\r  仓库 ${done}/${uniqueSlugs.length}  命中 ${hit}  失败 ${miss}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write(`\r  仓库 ${done}/${uniqueSlugs.length}  命中 ${hit}  失败 ${miss}\n`);

// 回填到 metrics 副本
const out = JSON.parse(JSON.stringify(metrics));
let filled = 0;
for (const { name, slug } of targets) {
  const stars = starOf.get(slug.toLowerCase());
  if (stars === undefined) continue;
  if (out[name] === undefined) out[name] = {};
  if (out[name].stars === undefined) {
    out[name].stars = stars;
    filled += 1;
  }
}

fs.writeFileSync(outFile, JSON.stringify(out));
const total = Object.keys(out).length;
const withStars = Object.values(out).filter((v) => typeof v.stars === 'number').length;
console.log(`\n已写出 ${outFile}`);
console.log(`新补星数: ${filled} 个插件`);
console.log(`metrics 总条目: ${total}，其中有星数: ${withStars}`);
