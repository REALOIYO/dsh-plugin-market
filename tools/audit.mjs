/**
 * 发布前隐私自检：确认索引里没有本机路径、内网地址、凭据等不该公开的内容。
 * 用法：node tools/audit.mjs [索引文件.json]
 */
import fs from 'node:fs';

const file = process.argv[2] ?? 'index.json';
const text = fs.readFileSync(file, 'utf8');

/**
 * 不该出现在公开索引里的模式。
 *
 * 只扫「结构性字段」，不扫自由文本描述 —— 插件自己写的说明里出现 127.0.0.1、
 * secret: 之类字样是正常内容，不代表泄露；包名里含 localhost 也正常。
 */
const urlPatterns = [
  [/^(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0|localhost|\[::1\])$/i, 'URL 指向本机'],
  [/^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/, 'URL 指向内网 IP'],
];

const pathPatterns = [
  [/\b[A-Za-z]:\\(?:Users|Documents|Desktop)/i, 'Windows 用户目录'],
  [/(?:^|[\s"'(])\/(?:home|Users|root)\//, 'Unix 用户目录'],
];

/** 任何地方出现都算问题的凭据样式。 */
const credentialPatterns = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/, 'npm token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\b[Aa]uthorization:\s*[Bb]earer\s+[A-Za-z0-9._-]{20,}/, 'Bearer token'],
];

const document = JSON.parse(text);

/** 抽出具结构性的字符串：URL 只看 URL，包名不做地址匹配（包名里有 localhost 是正常的）。 */
function structuralValues(index) {
  const urls = [];
  const names = [];
  for (const plugin of index.plugins) {
    names.push(plugin.name);
    if (plugin.repository?.url !== undefined) urls.push(plugin.repository.url);
    if (plugin.repository?.directory !== undefined) names.push(plugin.repository.directory);
    if (plugin.homepage !== undefined) urls.push(plugin.homepage);
    if (plugin.icon !== undefined && !plugin.icon.startsWith('data:')) urls.push(plugin.icon);
  }
  return { urls, names };
}

const { urls, names: pathValues } = structuralValues(document);

const findings = [];
// 只有 URL 的 hostname 才说明数据实际指向哪里；路径/仓库名里出现 localhost 是正常的
for (const value of urls) {
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    continue;
  }
  for (const [pattern, label] of urlPatterns) {
    if (pattern.test(host) || pattern.test(value)) findings.push({ label, sample: host });
  }
}
// 目录/路径类字段只查本机文件系统路径
for (const value of pathValues) {
  for (const [pattern, label] of pathPatterns) {
    if (pattern.test(value)) findings.push({ label, sample: value.slice(0, 60) });
  }
}
for (const [pattern, label] of credentialPatterns) {
  const match = pattern.exec(text);
  if (match !== null) findings.push({ label, sample: match[0].slice(0, 40) });
}

const hosts = new Map();
for (const match of text.matchAll(/https?:\/\/[^"\s\\]+/g)) {
  try {
    const { hostname } = new URL(match[0]);
    hosts.set(hostname, (hosts.get(hostname) ?? 0) + 1);
  } catch {
    // 非法 URL 由校验器负责报告
  }
}

if (findings.length === 0) {
  console.log('隐私自检: 通过（结构字段里没有本机路径、内网地址或凭据）');
} else {
  console.log('隐私自检: 发现可疑内容');
  for (const { label, sample } of findings) console.log(`  - ${label}: ${sample}`);
  process.exitCode = 2;
}

const insecure = [...hosts].filter(([host]) => host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host));
if (insecure.length > 0) {
  console.log('\n注意：以下图标/主页主机是 IP 或 localhost:');
  for (const [host] of insecure) console.log(`  ${host}`);
}

console.log(`\n插件 ${document.plugins.length} 个，版本 ${document.plugins.reduce((n, p) => n + p.versions.length, 0)} 个。`);
console.log('引用的域名:');
for (const [host, count] of [...hosts].sort((a, b) => b[1] - a[1])) console.log(`  ${host}  ×${count}`);
