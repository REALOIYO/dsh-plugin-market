/**
 * 发布前隐私自检：确认索引里没有本机路径、内网地址、凭据等不该公开的内容。
 * 用法：node tools/audit.mjs [索引文件.json]
 */
import fs from 'node:fs';

const file = process.argv[2] ?? 'index.json';
const text = fs.readFileSync(file, 'utf8');

/** 不该出现在公开索引里的模式。 */
const suspicious = [
  [/\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b/i, '本机地址'],
  [/\b(?:10|127)\.\d+\.\d+\.\d+\b/, '内网/回环 IP'],
  [/\b192\.168\.\d+\.\d+\b/, '内网 IP'],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b/, '内网 IP'],
  [/\b[A-Za-z]:\\(?:Users|Documents|Desktop)/i, 'Windows 用户目录'],
  [/(?:^|[\s"'(])\/(?:home|Users|root)\//, 'Unix 用户目录'],
  [/\bfile:\/\//i, '本地文件 URL'],
  [/\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|bearer)\b\s*[:=]/i, '疑似凭据字段'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/, 'npm token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
];

const findings = [];
for (const [pattern, label] of suspicious) {
  const match = pattern.exec(text);
  if (match !== null) findings.push({ label, sample: match[0].slice(0, 40) });
}

const document = JSON.parse(text);
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
  console.log('隐私自检: 通过（没有发现本机路径、内网地址或凭据）');
} else {
  console.log('隐私自检: 发现可疑内容');
  for (const { label, sample } of findings) console.log(`  - ${label}: ${sample}`);
  process.exitCode = 2;
}

console.log(`\n插件 ${document.plugins.length} 个，版本 ${document.plugins.reduce((n, p) => n + p.versions.length, 0)} 个。`);
console.log('引用的域名:');
for (const [host, count] of [...hosts].sort((a, b) => b[1] - a[1])) console.log(`  ${host}  ×${count}`);
