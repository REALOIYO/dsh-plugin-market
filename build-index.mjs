/**
 * 从 npm 自动发现全部 DSH 组合包，生成 DSH 插件市场索引（format 1）。
 *
 * 关键设计：抓到一个 packument 就立刻压成索引条目（几百字节），原文立即丢弃，
 * 只把压缩后的结果写到磁盘缓存。因此内存占用与包数量无关。
 *
 * 用法：
 *   node build-index.mjs                 # 全量发现（约 10 分钟）
 *   node build-index.mjs --from-cache    # 复用缓存，秒出
 *   node build-index.mjs dsh-foo @a/b    # 只生成指定的包
 *   node build-index.mjs --config c.json
 */
import fs from 'node:fs';
import path from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'digest.json');
const SEEDS_DIR = 'seeds';
const CONCURRENCY = 24;

/** 广撒网的搜索关键词：覆盖关键字、命名约定和生态前缀。 */
const QUERIES = [
  'keywords:dsh',
  'keywords:dsh-plugin',
  'keywords:deepseek-harness',
  'keywords:deepseek',
  'dsh-plugin',
  'dsh-',
  'deepseek-harness',
  'cordis-plugin',
  'dsh',
];

const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

async function getJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === attempts) {
        warnOnce(url, `放弃 ${url}: ${error.message}`);
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  return undefined;
}

/**
 * 收集候选包名。
 *
 * 优先读种子文件 `seeds/*.json`（外部目录导出的包名清单），这样完全不依赖
 * npm 的搜索接口 —— 该接口在部分网络环境下会被中间设备拦截。
 * 没有种子时才回退到搜索接口。
 */
async function discoverNames() {
  const names = new Set();

  if (fs.existsSync(SEEDS_DIR)) {
    for (const file of fs.readdirSync(SEEDS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const list = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, file), 'utf8'));
      if (!Array.isArray(list)) continue;
      let before = names.size;
      for (const name of list) if (typeof name === 'string') names.add(name);
      console.log(`  种子 ${file.padEnd(24)} +${names.size - before}`);
    }
    console.log(`种子清单合计 ${names.size} 个包名`);
    return [...names];
  }

  console.log('未找到 seeds/，回退到 npm 搜索接口…');
  for (const query of QUERIES) {
    let before = names.size;
    for (let from = 0; from < 10000; from += 250) {
      // 注意：冒号必须原样保留，npm 搜索接口不接受 %3A 编码的 `keywords:` 语法
      const url = `${REGISTRY}/-v1/search?text=${encodeURIComponent(query).replace(/%3A/gi, ':')}&size=250&from=${from}`;
      const page = await getJson(url);
      if (page === undefined || !Array.isArray(page.objects) || page.objects.length === 0) break;
      for (const object of page.objects) names.add(object.package.name);
      if (page.objects.length < 250) break;
    }
    console.log(`  ${query.padEnd(28)} 候选累计 ${names.size}（本次 +${names.size - before}）`);
    if (names.size === before) warnOnce(`empty:${query}`, `警告：关键词 "${query}" 没有返回任何候选`);
  }
  return [...names];
}

/** git+https://github.com/a/b.git#main -> https://github.com/a/b */
function repoUrl(value) {
  if (!value) return undefined;
  const raw = typeof value === 'string' ? value : value.url;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let text = raw.trim();
  if (text.startsWith('git+')) text = text.slice(4);
  const ssh = /^git@([^:]+):(.+)$/.exec(text);
  if (ssh !== null) text = `https://${ssh[1]}/${ssh[2]}`;
  if (text.startsWith('github:')) text = `https://github.com/${text.slice('github:'.length)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = `https://github.com/${text}`;
  text = text.replace(/\.git(#.*)?$/, '').replace(/\/+$/, '').replace(/(?:\/tree\/.*|\/blob\/.*)$/, '');
  if (!/^https?:\/\//.test(text)) return undefined;
  try {
    const url = new URL(text);
    if (!/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return undefined;
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function authorName(value) {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value.name === 'string' && value.name.trim() !== '') return value.name.trim();
  return undefined;
}

function dshRange(manifest) {
  const range = manifest.engines && manifest.engines.dsh;
  if (typeof range !== 'string' || range.trim() === '' || range.startsWith('workspace:')) return undefined;
  return range.trim();
}

/** 仓库内的相对目录：各段只能是 ASCII 字母数字和 ._@+-，且不能是 . 或 .. */
function packagePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const segments = value.replace(/^\.\//, '').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return undefined;
    if (!/^[A-Za-z0-9._@+-]+$/.test(segment)) return undefined;
  }
  return value.replace(/^\.\//, '');
}

/**
 * 把一个 packument 压成索引条目；没有可安装版本时返回 undefined。
 * 返回值只保留索引需要的字段，packument 本身随后可被 GC 回收。
 */
function digest(doc) {
  if (doc === null || typeof doc !== 'object' || typeof doc.name !== 'string') return undefined;
  const versions = [];

  for (const [version, manifest] of Object.entries(doc.versions ?? {})) {
    if (!manifest || !manifest.dsh || !manifest.dsh.bundle) continue;
    const published = doc.time && doc.time[version];
    if (typeof published !== 'string') continue;
    const publishTimestamp = Math.floor(Date.parse(published) / 1000);
    if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) continue;
    const engines = dshRange(manifest);
    versions.push({
      version,
      publishTimestamp,
      source: { type: 'npm' },
      ...(engines === undefined ? {} : { engines: { dsh: engines } }),
    });
  }

  if (versions.length === 0) return undefined;

  const latest = doc['dist-tags'] && doc['dist-tags'].latest;
  const shown = doc.versions[latest] ?? doc.versions[versions.at(-1).version] ?? {};
  const listed = new Set(versions.map((entry) => entry.version));
  const distTags = Object.fromEntries(
    Object.entries(doc['dist-tags'] ?? {}).filter(([, target]) => listed.has(target)),
  );

  const description =
    typeof shown.description === 'string' && shown.description.trim() !== '' ? shown.description.trim() : undefined;
  const author = authorName(shown.author);
  const repository = repoUrl(shown.repository);
  const homepage = typeof shown.homepage === 'string' && /^https?:\/\//.test(shown.homepage) ? shown.homepage : undefined;

  return {
    name: doc.name,
    ...(description === undefined ? {} : { description: description.slice(0, 400) }),
    ...(author === undefined ? {} : { author }),
    ...(repository === undefined
      ? {}
      : {
          repository: {
            url: repository,
            ...(typeof shown.repository === 'object' && packagePath(shown.repository.directory) !== undefined
              ? { directory: packagePath(shown.repository.directory) }
              : {}),
          },
        }),
    ...(homepage === undefined ? {} : { homepage }),
    metadata: {
      keywords: Array.isArray(shown.keywords)
        ? shown.keywords.filter((keyword) => typeof keyword === 'string').slice(0, 15)
        : [],
    },
    ...(Object.keys(distTags).length === 0 ? {} : { 'dist-tags': distTags }),
    versions,
  };
}

/** 读取压缩缓存（只含索引条目）。 */
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
}

function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/** 并发抓取，边抓边压，定期落盘。 */
async function fetchAll(names, cache) {
  const queue = names.filter((name) => cache[name] === undefined);
  const total = queue.length;
  let done = 0;
  let found = 0;
  let savedAt = Date.now();

  async function worker() {
    while (queue.length > 0) {
      const name = queue.shift();
      const doc = await getJson(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`);
      // 立刻压缩，然后让原文失去引用，内存只保留几百字节的条目
      const entry = doc === undefined ? null : digest(doc);
      cache[name] = entry ?? null;
      if (entry !== undefined) found += 1;
      done += 1;

      if (done % 500 === 0) {
        console.log(`  已抓取 ${done}/${total}（命中 ${found}）`);
        saveCache(cache);
        savedAt = Date.now();
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveCache(cache);
  return { found, total, savedAt };
}

const argv = process.argv.slice(2);
let config = { title: 'My DSH Market', plugins: [] };
let useCache = false;
let explicit = false;

if (argv[0] === '--config') {
  config = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  explicit = true;
} else {
  const rest = argv.filter((value) => !value.startsWith('--'));
  useCache = argv.includes('--from-cache');
  config.plugins = rest;
  explicit = rest.length > 0;
}

let cache = loadCache();
console.log(`缓存中已有 ${Object.keys(cache).length} 个条目，其中 ${Object.values(cache).filter(Boolean).length} 个是组合包`);

if (explicit) {
  console.log(`抓取指定的 ${config.plugins.length} 个包…`);
  await fetchAll(config.plugins, cache);
} else {
  if (useCache) {
    console.log('使用缓存，跳过发现与抓取');
  } else {
    console.log('发现候选包名…');
    const names = await discoverNames();
    console.log(`共 ${names.length} 个候选，开始抓取（边抓边压，内存占用恒定）…`);
    const result = await fetchAll(names, cache);
    console.log(`抓取完成：${result.total} 个新增查询，命中 ${result.found} 个组合包`);
  }
  config.plugins = Object.keys(cache);
}

const plugins = [];
const seen = new Set();
for (const name of config.plugins) {
  const plugin = cache[name];
  if (plugin === null || plugin === undefined) continue;
  if (seen.has(plugin.name)) continue;
  // 兜底清洗：旧缓存可能带着不合规的 directory（例如 "."）
  if (plugin.repository !== undefined) {
    const directory = packagePath(plugin.repository.directory);
    if (directory === undefined) delete plugin.repository.directory;
    else plugin.repository.directory = directory;
  }
  seen.add(plugin.name);
  plugins.push(plugin);
}
plugins.sort((left, right) => left.name.localeCompare(right.name));

const index = {
  format: 1,
  title: config.title ?? 'My DSH Market',
  ...(config.description === undefined ? {} : { description: config.description }),
  ...(config.metadata === undefined ? {} : { metadata: config.metadata }),
  plugins,
};

const out = path.resolve(config.out ?? 'index.json');

// 保护：结果异常为空时不覆盖已有索引（网络故障 / 接口变更都会导致这种情况）
if (plugins.length === 0) {
  console.error(`\n没有任何插件，拒绝写出 ${out}（已保留原文件）。`);
  console.error('常见原因：网络不可用、npm 搜索接口变更，或缓存为空。');
  process.exit(1);
}

fs.writeFileSync(out, `${JSON.stringify(index)}\n`);
console.log(`\n已写出 ${out}`);
console.log(
  `插件 ${plugins.length} 个，版本 ${plugins.reduce((n, p) => n + p.versions.length, 0)} 个，` +
    `${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`,
);
