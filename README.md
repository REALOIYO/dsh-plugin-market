# DSH 插件市场索引（format 1）

[![Refresh market index](https://github.com/REALOIYO/dsh-plugin-market/actions/workflows/refresh.yml/badge.svg)](https://github.com/REALOIYO/dsh-plugin-market/actions/workflows/refresh.yml)

一份自建的 DSH 插件市场索引，收录 npm 上可发现的 DSH 组合包（bundle）。

**规模**：7,123 个插件 / 58,629 个版本，索引文件 9.5 MB。
**来源**：npm registry 公开元数据（包名、版本、发布时间、`dsh.bundle` 声明、仓库地址）。
**热度**：6,349 / 7,123（89.1%）带星数或下载量指标——星数取自 GitHub API，下载量取自 npm API。
**更新**：GitHub Actions 每天自动重建一次，也可以手动触发。

## 插件是怎么被收录的

索引不是手工维护的列表，每次重建都会重新发现一遍：

1. **社区目录种子** —— `seeds/dsh-so.json` 里的已知包名，覆盖社区已有的插件；
2. **npm 关键词搜索** —— 用 `keywords:dsh-plugin` 在 npm 搜索接口翻页，抓取种子之外的新包。

两个来源合并后，逐个拉取 packument，**只保留 `package.json` 里声明了 `dsh.bundle` 的包**。
声明了才算可安装的 DSH 组合包，因此搜到的同名干扰包会被自动丢弃。
本次搜索补充 3,424 个候选，其中 985 个是新收录的 bundle。

> 关键词只保留 `keywords:dsh-plugin`。抽样 750 个包全部带该关键词（精确率 100%），
> 250 抽样里 239 个（95.6%）声明了 `dsh.bundle`。`keywords:dsh` 总量更大（11,003）
> 但 `dsh` 三字母在其它语境也常用，会混入大量非插件包并把索引撑大一倍，故未采用。

### 为什么要按切片搜索

npm 搜索接口有两个硬限制，导致**单靠翻页拿不全**：

- **翻页会绕回开头** —— `from` 超过约 5000 后，接口从头重复返回第 0 页
  （实测 `from=5250` 与 `from=0` 返回的 250 条完全重合）。`keywords:dsh-plugin`
  声明有 8,782 个结果，直接翻页最多只能拿到约 5,250 个。
- **连续请求会 429** —— 没有 `Retry-After` 也没有限流响应头，只能靠失败后退避。

`published:` 这类过滤器**不能**用来切片：它只改变排序起点、不做真正的结果过滤
（实测 12 个月切片并集仅 560 个）。但**把裸词叠加进 `text` 会真正参与匹配**，
因此改用「单字母 / 数字 / 常见词」做切片，每片独立翻页，最后取并集。

当前切片：基线 + `a`–`z` + `0`–`9` + `dsh- plugin bundle agent skill tool mcp ui web`。
基线切片保留是必须的 —— 否则会漏掉不与任何切片词匹配的包。

## 索引地址

```
https://realoiyo.github.io/dsh-plugin-market/index.json
```

## 填在哪里

DSH → 设置 → 插件 → **发现** → **添加索引源** → 粘贴上面的 URL。

> DSH **拒绝重定向**，所以不要用短链或会 301 的地址，必须是最终地址。

## 这个格式是什么

DSH 从 URL 拉一份 JSON，用 `@deepseek-ai/dsh-plugin-market-index` 按「插件市场索引格式 1」严格校验。
任何一条规则违规，**整份索引都会被拒绝**，错误会带 JSON 路径。

它不是 npm 的 `index.json`，也不是任何网站的首页 —— 是一份专门描述「有哪些可安装 bundle」的清单。

## 兼容性是怎么判的

索引里每个版本都带一个 `engines.dsh` SemVer 范围，DSH 用它决定是否允许安装。
判断规则**必须与 DSH 自身一致**（`dsh-app-boot` 的 `unmetRequirements`）：

1. 包里有 `engines.dsh` → **只认它**，`peerDependencies` 被忽略；
2. 没有 `engines.dsh` → 逐个检查 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的 `peerDependencies`，
   全部满足才算兼容。

比较时使用 `semver.satisfies(runtime, range, { includePrerelease: true })`——
**预发布版本参与范围比较**，这一点很容易踩错：不加 `includePrerelease` 时
`"*"` 对 `0.2.1-rc.2` 会返回 `false`，导致几乎所有插件都被误判为不兼容。

生成器把多个 peer 范围**取交集**合并成一个范围（索引格式只允许一个 `engines.dsh` 字段）。
实测同一版本的多个 dsh peer 范围几乎总是一致的，所以取交集在实践中等同取任意一个。

> 2026-10-18 修复：生成器此前**只读 `engines.dsh`、完全不读 `peerDependencies`**，
> 导致 3,603 个插件的兼容声明缺失，其中 **1,760 个被错误地显示为「兼容」而实际不支持
> 当时的运行时**。修复后 `engines.dsh` 覆盖从 10.1% 提升到 60.5%。
> 这就是「从索引点安装几乎没成功过」的主要原因之一。

## 为什么不能在线更新

这不是索引的问题，是 DSH 的限制。官方 `plugin-manager` 只暴露 `installBundle` 和 `removeBundle`，
**没有 `updateBundle`**；官方 README 也写明「不支持升级 —— 升级仍需先卸载再安装」。

`dshmarket` 这类第三方市场通过别的路子绕过了：它不用 `installBundle`，而是直接跑
`dsh plugin update <name>`（底层是 `pnpm update`），从而原地升级。本索引是纯静态 JSON，
不跑任何命令，因此无法提供更新按钮。

---

## 排序

索引声明了两个排序键，界面里「排序」菜单会出现：

| 排序键 | 含义 | 默认方向 |
|---|---|---|
| `stars` | GitHub 星数 | 降序 |
| `downloads` | npm 周下载量 | 降序 |

值来自两部分：星数取自 GitHub API（`stargazers_count`）并按仓库 URL 匹配到包，
下载量取自 npm 官方 downloads API。

## 热度指标是怎么来的

索引里只有 `stars` 和 `downloads` 两个数值，DSH 用它们排序，并折成卡片上的标签
（`★ 100+`、`↓ 1k/wk` 之类）。采集分两步：

1. **星数** —— `tools/fill-stars.mjs` 读每个包的 `repository.url`，取 `owner/repo`
   调 `GET /repos/{owner}/{repo}`，只取 `stargazers_count`。
   同一个仓库被多个包引用时只查一次；只处理尚无指标或尚无星数的包。
2. **下载量** —— `tools/fill-downloads.mjs` 调 npm 的
   `GET /downloads/point/last-week/{package}`。

### 为什么要认证

GitHub 未认证的 API 限额是 **60 次/小时**，补几千个仓库会立刻用尽并返回 403。
认证后提升到 **5,000 次/小时**，一次跑完 1,235 个唯一仓库只需约 90 秒。

脚本**只从环境变量 `GITHUB_TOKEN` 读取令牌**，不接受命令行参数，也不写入任何文件：

```bash
# 本地：从本机 git 凭证管理器取（Windows）
GITHUB_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' \
  | git-credential-manager get | grep '^password=' | cut -d= -f2-) \
node tools/fill-stars.mjs index.json metrics.json metrics-out.json
```

```yaml
# Actions：用内置令牌，无需创建任何 secret
- env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: node tools/fill-stars.mjs index.json metrics.json metrics-out.json
```

> Actions 的 `GITHUB_TOKEN` 限额是每仓库 **1,000 次/小时**，按当前规模够用。

### 隐私

- **不写入任何本机信息**：脚本只读到仓库 slug 和星数，输出里没有路径、用户名或令牌。
- **令牌不落盘**：只存在于进程环境变量中，不写日志、不写中间文件。
- **索引可公开**：`tools/audit.mjs` 会扫描结构字段，确认没有本机路径、内网地址或凭据。
  剩余 788 个插件没有指标，原因是作者没填 `repository.url`（623 个）或仓库已删除/私有（165 个），
  这些缺口无法通过 API 补上。

两者都是**生成时的快照**，随每天重建更新。

没有某个值的插件会排在所有有值的插件之后（这是 format 1 的规则，不是本仓库的选择）。

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

---

## 已知未解决 / Known limitations

以下问题在实测中确认存在，**目前没有修复**。列出来是为了让使用者知道边界在哪，而不是假装完整。

| 问题 | 现状 | 实际影响 |
|---|---|---|
| **定时任务会延迟** | cron 定 `0 19 * * *` UTC；2026-10-18 首次定时构建实际于 21:21 UTC 启动 | 延迟约 2h22m 属正常排队，但最坏情况可能被跳过；新插件实际延迟 1–26 小时 |
| **Actions 缓存键每次都变** | `key: packuments-${{ github.run_id }}` | 精确 key 永不命中，只能靠 `restore-keys` 前缀捡最新的；每次运行都写新缓存，会持续累积到 GitHub 的 10 GB 上限 |
| **热度标签覆盖偏低** | 435 / 7,123，阈值 `stars ≥ 100` 或 `downloads ≥ 1000` | 大多数插件卡片上不显示任何热度：DSH 的标签只有数值档位，没有「低于阈值」的表达方式 |
| **没有生成时间戳** | 索引内无 `generatedAt` 字段 | 无法判断这份数据是几点生成的，排查「插件为什么没出现」时很痛苦 |
| **构建失败无人知道** | Actions 失败只在网页和默认邮件里 | 索引可能静默停止更新，客户端只会看到越来越旧的数据 |
| **社区目录下载无重试** | `curl --max-time 120` + `continue-on-error: true` | 一旦失败就直接跳过 metrics，**当天所有星数归零**，且被 `continue-on-error` 掩盖 |
| **不能按更新时间排序** | `sortKeys` 只有 `stars` / `downloads` | 无法按「最近发布/最近更新」筛选新插件 |
| **兼容声明会滞后** | 索引只转述各包 `peerDependencies` 里的版本范围 | 插件作者未及时跟进 DSH 新版本时（例如 DSH 已发 `0.2.1-rc.2`，而插件仍声明只支持 `rc.1`），市场 UI 会误报「不兼容」，实际往往能跑 |
| **索引是静态快照** | 每天重建一次 | 新发布的插件最多延迟 24 小时才出现；已被删除的包也可能残留一个周期 |
| **搜索发现可能被限流** | npm 搜索连续请求会 429，且 `from>5000` 会绕回第 0 页 | 已用切片 + 指数退避缓解，但仍无法保证覆盖 8,782 个声明结果的全部；实际收录以命中 `dsh.bundle` 为准 |
| **指标覆盖 89%，仍有 774 个缺口** | 6,349 / 7,123 有指标 | 623 个插件作者没填 `repository.url`；另 151 个仓库已删除或转为私有（API 返回 404）。这两类都无法通过 API 补齐 |

### 为什么这些没修

- **缓存键**和**失败告警**属于流水线卫生，改动小但需要一次完整运行来验证；
- **标签阈值**是产品判断：放宽会让卡片变杂，收窄会让更多人没有标签，没有明显占优的答案；
- **兼容声明滞后**不是本索引能解决的 —— 它只是转述 npm 上的声明，真正的修复在插件作者侧；
- **静态快照**是 GitHub Pages 托管方式的固有限制，要做增量更新就得换一套服务端。
