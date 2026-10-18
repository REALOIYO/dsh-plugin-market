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
import semver from 'semver';

const REGISTRY = 'https://registry.npmjs.org';
const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'digest.json');
const SEEDS_DIR = 'seeds';
const METRICS_FILE = 'metrics.json';
const CONCURRENCY = 24;

/**
 * 搜索关键词。
 *
 * 只保留 `keywords:dsh-plugin`：抽样 750 个包全部带该关键词（精确率 100%），
 * 且 250 抽样里 239 个（95.6%）声明了 `dsh.bundle`。`keywords:dsh` 总量更大
 * （11,003）但 `dsh` 三字母在其它语境也常用，会混入大量非插件包并把索引撑大一倍。
 */
const QUERIES = ['keywords:dsh-plugin'];

const warned = new Set();

/** 搜索翻页参数。npm 搜索接口 from 上限 10000。 */
const SEARCH_PAGE_SIZE = 250;
const SEARCH_MAX_FROM = 10000;
/** 单页遇到 429 时的最大重试次数与退避基数（毫秒）。 */
const SEARCH_MAX_RETRIES = 6;
const SEARCH_BACKOFF_MS = 3000;

/**
 * 关键词切片的追加词。
 *
 * 背景：npm 搜索的 `from` 超过约 5000 后会**从头重复返回第 0 页**
 * （实测 from=5250 与 from=0 的 250 条完全重合），因此单靠翻页
 * 一个关键词最多只能拿到 ~5,250 个结果，而 `keywords:dsh-plugin` 声明有 8,782 个。
 *
 * npm 的 `text` 不是结构化查询，`published:` 之类的过滤器只改变排序起点、
 * 不做真正过滤（实测 12 个月切片并集仅 560 个）。但**把裸词叠加进 text
 * 会真正参与匹配**，从而把结果集切成互不相同的子集：
 * 加 `a` 后与基线重叠 59/250，加 `dsh-` 后 75/250。
 *
 * 因此用「单字母 + 数字 + 连字符前缀」做切片，每个切片独立翻页，
 * 最后取并集。切片是**补充**而非替代：基线切片必须保留，
 * 否则会漏掉那些不与任何切片词匹配的包。
 */
const SEARCH_SLICES = [
  '', // 基线：不带追加词，保证不遗漏
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'dsh-', 'plugin', 'bundle', 'agent', 'skill', 'tool', 'mcp', 'ui', 'web',
];

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
 * 用 curl 取 JSON。
 *
 * 这里用 Node 原生 fetch 而不是外部 curl：本机 curl 走 Windows schannel，
 * 在连续请求时会频繁出现 `failed to receive handshake` / 证书吊销检查失败，
 * 串行翻页时整轮发现会卡死。fetch 走同一网络路径但没有这个问题（已实测 200）。
 *
 * 注意：npm 搜索接口的正确路径是 `/-/v1/search`（`/-/` 前缀不能省）。
 * 曾因写成 `/-v1/search` 导致搜索恒返回 404，而失败被静默吞掉，
 * 使「自动发现」长时间空转却无任何报错。
 */
async function curlJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.trim() === '') throw new Error('空响应');
      return JSON.parse(text);
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
 * 取一页搜索结果，遇到 429 / 5xx 时指数退避重试。
 *
 * npm 搜索接口没有 `Retry-After` 也没有限流响应头，无法预知配额，
 * 只能靠失败后退避。429 是「请求太快」而非「翻到某一页」触发的，
 * 所以退避重试通常能在同一位置继续，不必放弃整个关键词。
 *
 * 返回 undefined 表示这一页确实取不到（重试耗尽），调用方据此停止翻页。
 */
async function searchPage(url, query, from) {
  for (let attempt = 1; attempt <= SEARCH_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(45000),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (response.status === 404) {
        console.warn(`  ${query} from=${from} 返回 404，停止翻页`);
        return undefined;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.trim() === '') throw new Error('空响应');
      return JSON.parse(text);
    } catch (error) {
      if (attempt === SEARCH_MAX_RETRIES) {
        console.warn(`  ${query} from=${from} 重试 ${SEARCH_MAX_RETRIES} 次仍失败（${error.message}），停止翻页`);
        return undefined;
      }
      // 3s, 6s, 12s … 封顶 60s
      const wait = Math.min(SEARCH_BACKOFF_MS * 2 ** (attempt - 1), 60000);
      console.warn(`  ${query} from=${from} ${error.message}，${(wait / 1000).toFixed(0)}s 后重试（${attempt}/${SEARCH_MAX_RETRIES}）`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return undefined;
}

/**
 * 收集候选包名：种子清单 + npm 搜索。
 *
 * 两者都要 —— 种子覆盖社区已知的包，搜索覆盖种子里没有的（例如只在 npm 发布、
 * 但社区目录把它记成 GitHub 源的那些）。
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
  }

  const seedCount = names.size;
  console.log('npm 搜索补充（按切片翻页，取并集）…');
  for (const query of QUERIES) {
    for (const slice of SEARCH_SLICES) {
      const text = slice === '' ? query : `${query} ${slice}`;
      const before = names.size;
      let pages = 0;
      for (let from = 0; from < SEARCH_MAX_FROM; from += SEARCH_PAGE_SIZE) {
        // 冒号必须原样保留：npm 不接受 %3A 编码的 `keywords:` 语法
        const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text).replace(/%3A/gi, ':')}&size=${SEARCH_PAGE_SIZE}&from=${from}`;
        const page = await searchPage(url, text, from);
        if (page === undefined) break;
        if (!Array.isArray(page.objects) || page.objects.length === 0) break;

        let fresh = 0;
        for (const object of page.objects) {
          const name = object?.package?.name;
          if (typeof name !== 'string') continue;
          if (names.has(name)) continue;
          names.add(name);
          fresh += 1;
        }
        pages += 1;
        // 整页都是已收录的包，说明这个切片已经翻到头（或进入重复区），停止
        if (fresh === 0) break;
        if (page.objects.length < SEARCH_PAGE_SIZE) break;
      }
      const added = names.size - before;
      // 只有带来新包的切片才值得打印，否则 40 多个切片会刷屏
      if (added > 0 || slice === '') {
        console.log(`  ${(slice === '' ? '(基线)' : slice).padEnd(10)} 页=${String(pages).padStart(2)} +${String(added).padStart(4)}  累计 ${names.size}`);
      }
    }
  }

  console.log(`合计 ${names.size} 个候选（搜索新增 ${names.size - seedCount}）`);
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

/** 从 maintainers 数组取第一个名字。 */
function maintainerName(value) {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const name = authorName(entry);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** 从仓库地址取 owner，例如 https://github.com/Nagi-ovo/x -> Nagi-ovo */
function ownerFromRepo(url) {
  if (typeof url !== 'string') return undefined;
  const match = /^https?:\/\/[^/]+\/([^/]+)\//.exec(url);
  return match === null ? undefined : match[1];
}

/** npm scope 作为作者兜底：@michengai/x -> michengai */
function scopeOf(name) {
  const match = /^@([^/]+)\//.exec(name);
  return match === null ? undefined : match[1];
}

/**
 * 作者：依次尝试 manifest.author、maintainers、仓库 owner、包名 scope。
 * 索引的 author 是自由字符串，够用来搜索和判断来源即可。
 */
function resolveAuthor(manifest, repositoryUrl, packageName) {
  return (
    authorName(manifest.author) ??
    maintainerName(manifest.maintainers) ??
    ownerFromRepo(repositoryUrl) ??
    scopeOf(packageName)
  );
}

/**
 * 提取一个版本对 DSH 的版本要求，用于索引里的 `engines.dsh`。
 *
 * 规则必须与 DSH 自身判断兼容性的逻辑保持一致（`dsh-app-boot` 的
 * `unmetRequirements`）：**有 `engines.dsh` 时就只认它，忽略 peerDependencies；
 * 没有 `engines.dsh` 时才逐个检查 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*`
 * 的 peerDependencies 范围，全部满足才算兼容。**
 *
 * 索引格式只允许 `engines.dsh` 一个字段，表达不了「多个 peer 各自的范围」，
 * 所以这里把多个 peer 范围**取交集**合并成一个范围。这样得到的范围可能比
 * 真实要求更宽松（peer 各自描述的是不同包的兼容区间），但方向是对的：
 * 不会出现「本该判为不兼容却被判为兼容」之外的新误报。
 *
 * 实测抽样中，同一版本的多个 dsh peer 范围几乎总是一致的，
 * 因此取交集在实践中等同于取任意一个。
 */
function dshRange(manifest) {
  const engines = manifest.engines && manifest.engines.dsh;
  if (typeof engines === 'string' && engines.trim() !== '' && !engines.startsWith('workspace:')) {
    return engines.trim();
  }

  const peers = manifest.peerDependencies;
  if (peers === null || typeof peers !== 'object') return undefined;

  const ranges = [];
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string') continue;
    // 只有 dsh 本体的包才参与兼容判断，与 DSH 的规则一致
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    // workspace: 范围在官方逻辑里指向当前运行时，索引里无法表达，直接跳过
    if (range.startsWith('workspace:')) continue;
    const trimmed = range.trim();
    if (trimmed === '' || semver.validRange(trimmed) === null) continue;
    ranges.push(trimmed);
  }
  if (ranges.length === 0) return undefined;

  // 取交集：把所有范围用空格连接即 semver 的 AND 语义
  const unique = [...new Set(ranges)];
  const merged = unique.length === 1 ? unique[0] : unique.join(' ');
  return semver.validRange(merged) === null ? undefined : merged;
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

  // 与 DSH 读取器一致：按 SemVer 降序（相等时保留发布顺序），versions[0] 即最高版本
  versions.sort((left, right) => semver.rcompare(left.version, right.version));

  const latest = doc['dist-tags'] && doc['dist-tags'].latest;
  const shown = doc.versions[latest] ?? doc.versions[versions.at(-1).version] ?? {};
  const listed = new Set(versions.map((entry) => entry.version));
  const distTags = Object.fromEntries(
    Object.entries(doc['dist-tags'] ?? {}).filter(([, target]) => listed.has(target)),
  );

  const description =
    typeof shown.description === 'string' && shown.description.trim() !== '' ? shown.description.trim() : undefined;
  const repository = repoUrl(shown.repository);
  const author = resolveAuthor(shown, repository, doc.name);
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
/**
 * 索引标题与描述。格式允许纯字符串，但双语对象才能让界面按用户语言显示，
 * 且校验器要求对象必须含 `en`。
 */
const DEFAULT_TITLE = {
  en: 'DSH Plugin Index',
  zh: 'DSH 插件索引',
};
const DEFAULT_DESCRIPTION = {
  en: 'Full catalog of every installable DSH bundle on npm, rebuilt daily.',
  zh: 'npm 上全部可安装 DSH 组合包的完整索引，每天自动重建。',
};
let config = { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, plugins: [] };
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
  // 旧缓存可能缺 author，用仓库 owner / 包名 scope 回填
  if (plugin.author === undefined) {
    const fallback = ownerFromRepo(plugin.repository?.url) ?? scopeOf(plugin.name);
    if (fallback !== undefined) plugin.author = fallback;
  }
  // 旧缓存的版本顺序可能不是 SemVer 降序，这里统一重排
  plugin.versions.sort((left, right) => semver.rcompare(left.version, right.version));
  seen.add(plugin.name);
  plugins.push(plugin);
}
plugins.sort((left, right) => left.name.localeCompare(right.name));

/** 排序键声明：来自 metrics.json 的指标自动登记，可在 config 里覆盖标题。 */
const METRIC_SORT_KEYS = {
  stars: { title: { en: 'GitHub stars', zh: 'GitHub 星数' }, order: 'desc' },
  downloads: { title: { en: 'Weekly downloads', zh: '周下载量' }, order: 'desc' },
};

/**
 * 热度分档标签。
 *
 * format 1 没有「任意展示字段」，sortKeys 只用于排序、界面不显示数值。
 * 能显示在卡片上的只有 labels，所以把星数和下载量按量级折成标签，
 * 让用户在列表里就能看出热度。
 */
const HEAT_TIERS = [
  { key: 'stars', tiers: [20000, 10000, 5000, 2000, 1000, 500, 100], format: (n) => `★ ${n >= 1000 ? `${n / 1000}k` : n}+` },
  { key: 'downloads', tiers: [100000, 50000, 10000, 5000, 1000], format: (n) => `↓ ${n >= 1000 ? `${n / 1000}k` : n}/wk` },
];

/** 声明所有可能的标签，界面按本地化标题显示。 */
function heatLabelDeclarations() {
  const declarations = {};
  for (const { key, tiers, format } of HEAT_TIERS) {
    for (const tier of tiers) {
      const title = format(tier);
      declarations[`${key}-${tier}`] = { title: { en: title, zh: title } };
    }
  }
  return declarations;
}

/** 把一个指标值折成最高满足档位的标签 id。 */
function heatLabelOf(key, value) {
  const spec = HEAT_TIERS.find((entry) => entry.key === key);
  if (spec === undefined || typeof value !== 'number') return undefined;
  const tier = spec.tiers.find((candidate) => value >= candidate);
  return tier === undefined ? undefined : `${key}-${tier}`;
}

const metrics = fs.existsSync(METRICS_FILE) ? JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')) : {};
const metricNames = Object.keys(metrics).length > 0 ? Object.keys(METRIC_SORT_KEYS) : [];
const usedHeatLabels = new Set();

if (metricNames.length > 0) {
  let enriched = 0;
  for (const plugin of plugins) {
    const values = metrics[plugin.name];
    if (values === undefined) continue;
    const sortKeys = {};
    for (const key of metricNames) {
      if (typeof values[key] === 'number') sortKeys[key] = values[key];
    }
    if (Object.keys(sortKeys).length === 0) continue;

    // 热度标签：每个指标只取最高档
    const labels = [];
    for (const key of metricNames) {
      const label = heatLabelOf(key, values[key]);
      if (label !== undefined) {
        labels.push(label);
        usedHeatLabels.add(label);
      }
    }

    plugin.metadata = {
      ...(plugin.metadata ?? {}),
      sortKeys,
      ...(labels.length === 0 ? {} : { labels }),
    };
    enriched += 1;
  }
  console.log(`已注入排序指标：${enriched}/${plugins.length} 个插件`);
}

// 合并排序键声明：config 里声明的优先（可改标题），其余用默认
const declaredSortKeys = { ...(config.metadata?.sortKeys ?? {}) };
for (const key of metricNames) {
  if (declaredSortKeys[key] === undefined) declaredSortKeys[key] = METRIC_SORT_KEYS[key];
}

// 标签声明：config 里声明的优先，再补上实际用到的热度标签
const declaredLabels = { ...(config.metadata?.labels ?? {}) };
const allHeatLabels = heatLabelDeclarations();
for (const label of usedHeatLabels) {
  if (declaredLabels[label] === undefined) declaredLabels[label] = allHeatLabels[label];
}

const declaredCategories = config.metadata?.categories ?? {};
const hasMetadata =
  Object.keys(declaredSortKeys).length > 0 ||
  Object.keys(declaredLabels).length > 0 ||
  Object.keys(declaredCategories).length > 0;

const index = {
  format: 1,
  title: config.title ?? DEFAULT_TITLE,
  ...(config.description === undefined ? {} : { description: config.description }),
  ...(hasMetadata
    ? {
        metadata: {
          ...(Object.keys(declaredCategories).length === 0 ? {} : { categories: declaredCategories }),
          ...(Object.keys(declaredLabels).length === 0 ? {} : { labels: declaredLabels }),
          ...(Object.keys(declaredSortKeys).length === 0 ? {} : { sortKeys: declaredSortKeys }),
        },
      }
    : {}),
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
