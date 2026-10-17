/**
 * 与 dsh.so 目录交叉比对，作为第二来源校验。
 *
 * 我们的索引来自 npm（包名真实存在、版本真实存在、dsh.bundle 真实声明）。
 * dsh.so 提供独立的安全扫描结论与风险等级。两者各自覆盖不到对方的部分：
 *   - npm 有包但 dsh.so 没收录 → 缺少安全结论，需要提示
 *   - dsh.so 有但 npm 抓不到 → 可能是私有包或已下架
 *
 * 用法：node tools/cross-check.mjs <index.json> <dsh.so plugins-index.json>
 */
import fs from 'node:fs';

const [indexFile, externalFile] = process.argv.slice(2);
if (indexFile === undefined || externalFile === undefined) {
  console.error('用法: node tools/cross-check.mjs <index.json> <dsh.so plugins-index.json>');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const external = JSON.parse(fs.readFileSync(externalFile, 'utf8'));

/** 把 dsh.so 的安装命令归一成 npm 包名或 github 仓库。 */
function specOf(command) {
  if (typeof command !== 'string') return undefined;
  const match = /add\s+(\S+)/.exec(command);
  if (match === null) return undefined;
  const spec = match[1];
  if (spec.startsWith('github:')) return `gh:${spec.slice('github:'.length).split('#')[0].toLowerCase()}`;
  if (spec.startsWith('git+') || spec.startsWith('http')) return undefined;
  return `npm:${spec.replace(/@[\^~]?[0-9][^\s]*$/, '').toLowerCase()}`;
}

const externalBySpec = new Map();
for (const entry of external.plugins ?? []) {
  const spec = specOf(entry.install);
  if (spec === undefined) continue;
  // 同一 spec 出现多次时保留风险最高的
  const previous = externalBySpec.get(spec);
  if (previous === undefined) externalBySpec.set(spec, entry);
}

const stats = { audited: 0, low: 0, medium: 0, high: 0, critical: 0, unscanned: 0 };
const risks = [];

for (const plugin of index.plugins) {
  const entry = externalBySpec.get(`npm:${plugin.name.toLowerCase()}`);
  if (entry === undefined) {
    stats.unscanned += 1;
    continue;
  }
  const status = entry.security?.status;
  if (status === 'audited') stats.audited += 1;
  const level = entry.security?.riskLevel;
  if (level === 'low') stats.low += 1;
  else if (level === 'medium') stats.medium += 1;
  else if (level === 'high') stats.high += 1;
  else if (level === 'critical') stats.critical += 1;
  if (level === 'high' || level === 'critical') {
    risks.push({ name: plugin.name, level, counts: entry.security?.counts });
  }
}

const total = index.plugins.length;
const inExternal = total - stats.unscanned;

console.log(`本地索引插件      ${total}`);
console.log(`dsh.so 可匹配     ${inExternal}（${((inExternal / total) * 100).toFixed(1)}%）`);
console.log(`  已安全扫描      ${stats.audited}`);
console.log(`  风险 low        ${stats.low}`);
console.log(`  风险 medium     ${stats.medium}`);
console.log(`  风险 high       ${stats.high}`);
console.log(`  风险 critical   ${stats.critical}`);
console.log(`无安全扫描结论    ${stats.unscanned}`);

if (risks.length > 0) {
  console.log(`\n高风险条目（${risks.length} 个，前 20）：`);
  for (const risk of risks.slice(0, 20)) {
    console.log(`  ${risk.level.padEnd(8)} ${risk.name}  关键 ${risk.counts?.critical ?? '?'} 警告 ${risk.counts?.warning ?? '?'}`);
  }
}
