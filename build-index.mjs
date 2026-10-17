#!/usr/bin/env node
/**
 * 从 npm 包名生成 DSH 插件市场索引（format 1）。
 *
 * 用法：
 *   node build-index.mjs dshmarket dsh-better-sidebar @scope/some-plugin
 *   node build-index.mjs --config market.config.json
 *
 * 产物：index.json（可用任意静态托管发布，URL 必须是 http/https 且不能经过重定向）
 */
import fs from 'node:fs';
import path from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** git+https://github.com/a/b.git#main -> https://github.com/a/b */
function repoUrl(value) {
  if (!value) return undefined;
  const raw = typeof value === 'string' ? value : value.url;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let text = raw.trim();
  if (text.startsWith('git+')) text = text.slice(4);
  if (text.startsWith('git@github.com:')) text = 'https://github.com/' + text.slice('git@github.com:'.length);
  if (text.startsWith('github:')) text = 'https://github.com/' + text.slice('github:'.length);
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = 'https://github.com/' + text;
  text = text.replace(/\.git(#.*)?$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(text)) return undefined;
  const url = new URL(text);
  if (!/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return undefined;
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function authorName(value) {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value.name === 'string' && value.name.trim() !== '') return value.name.trim();
  return undefined;
}

/** 兼容性检查：只用 manifest 声明的 engines.dsh，缺省则省略该字段 */
function dshRange(manifest) {
  const range = manifest.engines && manifest.engines.dsh;
  if (typeof range !== 'string' || range.trim() === '' || range.startsWith('workspace:')) return undefined;
  return range.trim();
}

async function buildPlugin(name) {
  const doc = await getJson(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`);
  const latest = doc['dist-tags'] && doc['dist-tags'].latest;
  const versions = [];

  for (const [version, manifest] of Object.entries(doc.versions ?? {})) {
    // 只有声明了 dsh.bundle 的版本才可能被安装
    if (!manifest.dsh || !manifest.dsh.bundle) continue;
    const published = doc.time && doc.time[version];
    if (!published) continue;
    const timestamp = Math.floor(Date.parse(published) / 1000);
    if (!Number.isInteger(timestamp) || timestamp < 0) continue;
    const engines = dshRange(manifest);
    versions.push({
      version,
      publishTimestamp: timestamp,
      source: { type: 'npm' },
      ...(engines === undefined ? {} : { engines: { dsh: engines } }),
    });
  }

  if (versions.length === 0) return undefined;

  const shown = doc.versions[latest] ?? doc.versions[versions.at(-1).version];
  const listed = new Set(versions.map((v) => v.version));
  const distTags = Object.fromEntries(
    Object.entries(doc['dist-tags'] ?? {}).filter(([, target]) => listed.has(target)),
  );

  return {
    name: doc.name,
    ...(typeof shown.description === 'string' && shown.description.trim() !== ''
      ? { description: shown.description.trim() }
      : {}),
    ...(authorName(shown.author) === undefined ? {} : { author: authorName(shown.author) }),
    ...(repoUrl(shown.repository) === undefined
      ? {}
      : {
          repository: {
            ...(typeof shown.repository === 'object' && typeof shown.repository.directory === 'string'
              ? { directory: shown.repository.directory }
              : {}),
            url: repoUrl(shown.repository),
          },
        }),
    ...(typeof shown.homepage === 'string' && /^https?:\/\//.test(shown.homepage)
      ? { homepage: shown.homepage }
      : {}),
    metadata: {
      keywords: Array.isArray(shown.keywords) ? shown.keywords.filter((k) => typeof k === 'string') : [],
    },
    ...(Object.keys(distTags).length === 0 ? {} : { 'dist-tags': distTags }),
    versions,
  };
}

const args = process.argv.slice(2);
let config = { title: 'My DSH Market', plugins: [] };
if (args[0] === '--config') {
  config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
} else {
  config.plugins = args;
}
if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
  console.error('用法: node build-index.mjs <npm 包名...>  或  node build-index.mjs --config market.config.json');
  process.exit(1);
}

const index = {
  format: 1,
  title: config.title ?? 'My DSH Market',
  ...(config.description === undefined ? {} : { description: config.description }),
  ...(config.metadata === undefined ? {} : { metadata: config.metadata }),
  plugins: [],
};

for (const name of config.plugins) {
  try {
    const plugin = await buildPlugin(name);
    if (plugin === undefined) {
      console.warn(`跳过 ${name}: 没有任何版本声明 dsh.bundle（不可安装的组合包）`);
      continue;
    }
    index.plugins.push(plugin);
    console.log(`收录 ${name}: ${plugin.versions.length} 个版本`);
  } catch (error) {
    console.warn(`跳过 ${name}: ${error.message}`);
  }
}

const out = path.resolve(config.out ?? 'index.json');
fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n');
console.log(`\n已写出 ${out}（${index.plugins.length} 个插件）`);
