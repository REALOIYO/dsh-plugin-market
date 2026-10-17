/**
 * 从本机 DSH 安装直接加载官方索引校验器。
 *
 * DSH 把 `@deepseek-ai/dsh-plugin-market-index` 打包在 app.asar 归档里，磁盘上没有
 * 可 import 的文件。本模块按 ASAR 格式读出需要的几个文件，解压到系统临时目录后
 * 再加载，因此行为与原版完全一致，又不必把第三方代码提交进仓库。
 *
 * 可用 DSH_INSTALL_DIR 指定 resources 目录（含 app.asar 的那一层）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const WANTED = [
  '/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/',
  '/dsh/node_modules/semver/',
];

/** 从 PATH 上的 `dsh` 命令反推安装目录，避免把本机路径写进仓库。 */
function findFromPath() {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (!fs.existsSync(candidate)) continue;
      // 典型布局：<安装目录>/resources/runtime/cli/bin/dsh.cmd
      let current = path.dirname(candidate);
      for (let depth = 0; depth < 6; depth += 1) {
        const asar = path.join(current, 'resources', 'app.asar');
        if (fs.existsSync(asar)) return asar;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  return undefined;
}

/** 常见的 DSH 安装位置（resources 目录，其中含 app.asar）。 */
function resourcesCandidates() {
  return [
    process.env.DSH_INSTALL_DIR,
    `${process.env.LOCALAPPDATA ?? ''}/Programs/DeepSeek Harness/resources`,
    'C:/Program Files/DeepSeek Harness/resources',
    '/Applications/DeepSeek Harness.app/Contents/Resources',
    '/opt/DeepSeek Harness/resources',
    '/usr/lib/deepseek-harness/resources',
    '/usr/share/deepseek-harness/resources',
  ].filter((value) => typeof value === 'string' && value !== '');
}

function findAsar() {
  const fromPath = findFromPath();
  if (fromPath !== undefined) return fromPath;

  for (const resources of resourcesCandidates()) {
    const asar = path.join(resources, 'app.asar');
    if (fs.existsSync(asar)) return asar;
  }
  throw new Error(
    '找不到 DSH 的 app.asar。请用 DSH_INSTALL_DIR 环境变量指向 DSH 的 resources 目录。',
  );
}

/** 读取 ASAR 归档的头部索引。 */
function readAsarIndex(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const preamble = Buffer.alloc(16);
    fs.readSync(handle, preamble, 0, 16, 0);
    const jsonLength = preamble.readUInt32LE(12);
    const headerBuffer = Buffer.alloc(jsonLength);
    fs.readSync(handle, headerBuffer, 0, jsonLength, 16);
    return { header: JSON.parse(headerBuffer.toString('utf8')), base: 16 + jsonLength };
  } finally {
    fs.closeSync(handle);
  }
}

function collect(node, prefix, out) {
  for (const [name, entry] of Object.entries(node)) {
    const full = `${prefix}/${name}`;
    if (entry.files !== undefined) collect(entry.files, full, out);
    else out.set(full, entry);
  }
}

/**
 * 加载校验器：优先用本仓库 node_modules 里从 npm 装的正版包（CI 走这条路），
 * 退回到从本机 DSH 的 app.asar 现场解出（本地开发走这条路）。
 * 两条路径加载的是同一份代码，判定结果一致。
 * @returns 校验器模块。
 */
export async function loadValidator() {
  const local = path.join('node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js');
  if (fs.existsSync(local)) {
    const module = await import(pathToFileURL(path.resolve(local)).href);
    return { module, from: `npm: ${path.resolve(local)}` };
  }

  const asar = findAsar();
  const stamp = crypto.createHash('sha1').update(`${asar}:${fs.statSync(asar).mtimeMs}`).digest('hex').slice(0, 12);
  const target = path.join(os.tmpdir(), `dsh-market-validator-${stamp}`);
  const entry = path.join(
    target,
    'node_modules',
    '@deepseek-ai',
    'dsh-plugin-market-index',
    'lib',
    'index.js',
  );

  if (!fs.existsSync(entry)) {
    const { header, base } = readAsarIndex(asar);
    const index = new Map();
    collect(header.files, '', index);

    const handle = fs.openSync(asar, 'r');
    try {
      for (const [full, meta] of index) {
        const prefix = WANTED.find((wanted) => full.startsWith(wanted));
        if (prefix === undefined) continue;
        const relative = full.slice('/dsh/node_modules/'.length);
        // 还原成 node_modules 布局，让包内的裸导入（semver）能被正常解析
        const destination = path.join(target, 'node_modules', ...relative.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const size = Number(meta.size ?? 0);
        const buffer = Buffer.alloc(size);
        if (size > 0) fs.readSync(handle, buffer, 0, size, base + Number(meta.offset ?? 0));
        fs.writeFileSync(destination, buffer);
      }
    } finally {
      fs.closeSync(handle);
    }
  }

  const module = await import(pathToFileURL(entry).href);
  return { module, from: `${asar} (已解压到 ${target})` };
}
