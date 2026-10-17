# DSH 插件市场索引（format 1）

一份自建的 DSH 插件市场索引，收录 npm 上全部可安装的 DSH 组合包（bundle）。

**规模**：4,838 个插件 / 44,563 个版本，索引文件 5.8 MB。
**来源**：npm registry 公开元数据（包名、版本、发布时间、`dsh.bundle` 声明、仓库地址）。

## 填在哪里

DSH → 设置 → 插件 → **发现** → **添加索引源** → 粘贴本仓库 `index.json` 的**最终** HTTP URL。

> DSH **拒绝重定向**，所以不要用短链或会 301 的地址，必须是最终地址。

## 这个格式是什么

DSH 从 URL 拉一份 JSON，用 `@deepseek-ai/dsh-plugin-market-index` 按「插件市场索引格式 1」严格校验。
任何一条规则违规，**整份索引都会被拒绝**，错误会带 JSON 路径。

它不是 npm 的 `index.json`，也不是任何网站的首页 —— 是一份专门描述「有哪些可安装 bundle」的清单。

---

## 三条命令的工作流

```bash
node build-index.mjs                # 从 npm 生成（首次约 10 分钟）
node tools/check.mjs  index.json    # 用 DSH 原版校验器验
node tools/audit.mjs  index.json    # 查本机路径/内网地址/凭据
```

`tools/check.mjs` 里的校验器是**从你本机 DSH 的 `app.asar` 现场解出来**的，
判定结果与 DSH 完全一致，又不必把第三方代码提交进仓库。

`node build-index.mjs --from-cache` 可复用 `.cache/digest.json` 秒出结果。

## 数据是怎么来的

1. **候选包名**：读 `seeds/*.json`。当前种子由社区目录 dsh.so 的 21,539 条记录中抽出
   （4,867 个 npm 包名 + 11,232 个 GitHub 仓库）。
   不走 npm 搜索接口，因为该接口在部分网络环境会被中间设备拦截。
2. **逐个抓 packument**：拿完整版本历史、发布时间、`dsh` 字段。
3. **立刻压缩**：抓到一个就抽成索引条目（几百字节），原文立即丢弃。
   因此内存占用与插件数量无关 —— 早期版本把 1.8 万个 packument 全攒在内存里会 OOM。
4. **只保留真能装的**：必须有至少一个版本声明了 `dsh.bundle`，否则装了也不生效。

## 覆盖与可信度

与 [dsh.so](https://www.dsh.so) 的独立安全扫描交叉比对（`tools/cross-check.mjs`）：

| 指标 | 数值 |
|---|---|
| 本地索引插件 | 4,838 |
| dsh.so 可匹配 | 4,838（100%） |
| 已安全扫描 | 4,821 |
| 风险 low | 4,768 |
| 风险 medium | 53 |
| 风险 high / critical | **0** |

也就是说：**每个收录的包在 npm 上都真实存在**，且几乎全部有第三方安全扫描结论。

## 字段说明

### 根字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `format` | ✅ | 必须是整数 `1` |
| `title` | ✅ | 字符串，或含 `en` 的本地化对象 |
| `description` | | 同上 |
| `metadata.categories` / `labels` / `sortKeys` | | 声明后插件才能引用 |
| `plugins` | ✅ | 数组，顺序即默认排序 |

### 插件字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | ✅ | 合法 npm 包名，索引内唯一 |
| `title` / `description` | | 字符串或含 `en` 的对象 |
| `icon` | | 相对路径、`https:` URL，或 `data:` (≤32 KiB) |
| `author` / `homepage` | | 非空字符串 / 绝对 http(s) URL |
| `repository` | | `{ url, directory? }`，仅展示用；`directory` 只能是 `[A-Za-z0-9._@+-]` 段，不能是 `.` 或 `..` |
| `metadata.keywords` | | 自由字符串数组，无需根声明 |
| `dist-tags` | | 目标必须是已列出的版本 |
| `versions` | ✅ | 非空数组 |

### 版本字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `version` | ✅ | 精确 SemVer，不可重复 |
| `publishTimestamp` | ✅ | **整数 Unix 秒**（写毫秒会被拒） |
| `source` | ✅ | `{ "type": "npm" }` 或 `{ "type": "git", url, commit, path? }` |
| `engines.dsh` | | SemVer 范围，**禁止** `workspace:` 前缀 |

git 来源的 `commit` 必须是 40 位小写十六进制 SHA。

## 安装行为

| 来源 | 给 pnpm 的 spec |
|---|---|
| npm | `<name>@<version>` |
| git | `git+<url>.git#<commit>`，有 `path` 时加 `&path:/<path>` |

默认版本 = 最高兼容版本（优先非预发布）。`dist-tags.latest` 只影响渠道显示，
**绝不会装 `name@latest`**，每次安装都是固定到具体版本。

## 常见报错

| 报错 | 原因 |
|---|---|
| `$.format must be 1` | 漏写 `format: 1` 或写成了 `"1"` |
| `$.title must contain en` | 用了对象但没写 `en` |
| `must be an integer number of Unix seconds` | `publishTimestamp` 单位错了 |
| `must not be a workspace: range` | `engines.dsh` 写了 `workspace:*` |
| `references undeclared id` | 用了没在根 `metadata` 声明的分类/标签/排序键 |
| `must be a valid npm package name` | 包名有大写/空格 |
| `directory must be a relative directory` | `repository.directory` 是 `.` 或含非法字符 |
| `Could not fetch` / `HTTP 4xx` | URL 错、需登录、或被重定向 |

## 安全说明（重要）

- 索引**没有签名**。`title`、`author`、标签全是「声明」，不等于 DSH 验证过。
- 索引内容未经审核就会显示给你，并通过 `plugin_market` 工具传给模型。
- 插件安装后**以你的权限运行**，可能含构建脚本。
- 每次安装都会**重新检查源 manifest**，装的是包自己声明的东西 —— 索引只是目录，不是担保。
- 本索引只固定「包名 + 版本」，不镜像任何插件代码。

## 目录结构

```
index.json              生成的索引（提交进仓库）
build-index.mjs         生成器
market.config.json      标题/分类等配置
seeds/                  候选包名来源
tools/check.mjs         用 DSH 原版校验器验证
tools/audit.mjs         发布前隐私自检
tools/cross-check.mjs   与 dsh.so 安全扫描交叉比对
tools/e2e.mjs           本地起 HTTP，走 Host 同款抓取路径
tools/dsh-validator.mjs 从 app.asar 解出校验器
.cache/                 抓取结果缓存（不提交）
```

官方格式说明：
`https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md`
