/**
 * 用 DSH 自带的校验器检验一个索引文件是否合法。
 * 校验器从本机 DSH 安装的 app.asar 中直接解出，与原版行为完全一致。
 *
 * 用法：node tools/check.mjs <索引文件.json>
 */
import fs from 'node:fs';
import { loadValidator } from './dsh-validator.mjs';

const file = process.argv[2];
if (file === undefined) {
  console.error('用法: node tools/check.mjs <索引文件.json>');
  process.exit(1);
}

const { module, from } = await loadValidator();
console.log(`校验器: ${from}\n`);

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  const index = module.parseMarketIndex(raw, 'https://example.com/index.json');
  console.log('VALID');
  console.log('title:', JSON.stringify(index.title));
  for (const plugin of index.plugins) {
    const version = plugin.versions[0];
    console.log(
      ' -',
      plugin.name,
      '默认版本=',
      version.version,
      '安装参数=',
      JSON.stringify(module.marketInstallTarget(plugin.name, version)),
    );
  }
  console.log(`\n共 ${index.plugins.length} 个插件。`);
} catch (error) {
  console.log('INVALID:', error.name, error.message);
  console.log('path=', error.path, 'reason=', error.reason);
  process.exitCode = 2;
}
