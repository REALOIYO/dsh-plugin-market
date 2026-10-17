# DSH 插件市场「索引源」怎么填

## 一句话

那个输入框要填的是**一份 JSON 文件的 URL**（比如 `https://你的域名/index.json`），不是市场网站首页，也不是 npm 地址。
DSH **不提供官方市场**，也不会有「官方索引源」等你填 —— 索引必须由你自己（或别人）生成并托管。

---

## 它到底在读什么

DSH 从你填的 URL 拉取一份 JSON，用内置校验器 `@deepseek-ai/dsh-plugin-market-index` 按**「插件市场索引格式 1」**严格校验。
任何一条规则违规，**整个索引直接拒绝**（不是跳过那一条），错误信息会给出 JSON 路径，例如：

```
$.plugins[0].versions[1].version must be an exact SemVer version
```

### 抓取行为（决定了你该怎么托管）

| 行为 | 值 | 对你的要求 |
|---|---|---|
| 协议 | 只接受 `http:` / `https:` | 本地测试可以用 `http://127.0.0.1:...` |
| 重定向 | **拒绝**（`redirect: "error"`） | 必须填**最终 URL**，不能是 301/302 中转 |
| 凭据 / `#片段` | 禁止 | 不能是 `https://user:pass@...` 或以 `#` 结尾 |
| 请求头 | `accept: application/json` | 静态文件服务器即可 |
| 超时 | 15 秒（`fetchTimeoutMs`） | 别放超大文件 |
| 体积上限 | 128 MiB，内存里全量解析 | 几千个插件没问题 |
| 缓存 | 10 分钟（`cacheTtlMs`） | 改了索引要等一会儿或点刷新 |

---

## 最小可用示例

这是**能通过校验的最小合法索引**（已实测）：

```json
{
  "format": 1,
  "title": "My Market",
  "plugins": [
    {
      "name": "dsh-better-sidebar",
      "versions": [
        {
          "version": "0.28.0",
          "publishTimestamp": 1767225600,
          "source": { "type": "npm" }
        }
      ]
    }
  ]
}
```

必填只有：`format`(=1)、`title`、`plugins[].name`、`plugins[].versions`、每个版本的 `version` / `publishTimestamp` / `source`。

> `title` 写成对象时必须**包含 `en`**：`{"en": "My Market", "zh": "我的市场"}`。
> 只写单个字符串（如 `"My Market"`）则没有语言限制。

---

## 完整字段表

### 根字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `format` | ✅ | 必须是整数 `1` |
| `title` | ✅ | 字符串，或含 `en` 的本地化对象 |
| `description` | | 同上 |
| `metadata.categories` | | `{ "分类id": { "title": ... } }` |
| `metadata.labels` | | `{ "标签id": { "title": ... } }` |
| `metadata.sortKeys` | | `{ "id": { "title": ..., "order": "asc"\|"desc" } }` |
| `plugins` | ✅ | 数组，可为空；顺序即默认排序 |

分类 / 标签 / 排序键的 id 必须**先在根 `metadata` 里声明**，插件里引用未声明的 id 会被拒绝。

### 插件字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | ✅ | 合法 npm 包名，如 `dsh-foo` 或 `@scope/dsh-foo`；索引内唯一 |
| `title` / `description` | | 字符串或含 `en` 的本地化对象；`title` 缺省时显示 `name` |
| `icon` | | 相对路径（相对索引 URL 解析，须为 `https:` 或与索引同源）、`https:` 绝对 URL，或 `data:image/{svg+xml,png,jpeg,webp};base64,...`（解码后 ≤ 32 KiB） |
| `author` | | 非空字符串 |
| `homepage` | | 绝对 `http(s):` URL |
| `repository` | | `{ "url": "https://github.com/a/b", "directory"?: "packages/foo" }`，仅用于展示 |
| `metadata.category` | | 单个已声明的分类 id |
| `metadata.labels` | | 已声明标签 id 数组，不可重复 |
| `metadata.keywords` | | 自由字符串数组，**无需**在根声明 |
| `metadata.sortKeys` | | 已声明排序键 → 有限数值 |
| `dist-tags` | | `{ "latest": "1.2.3" }`，目标必须是已列出的版本 |
| `versions` | ✅ | 非空数组 |

### 版本字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `version` | ✅ | 精确 SemVer（`1.2.3`、`1.2.3-rc.1`），不可重复 |
| `publishTimestamp` | ✅ | **整数 Unix 秒**，`[0, 10^11)`。写毫秒会被拒 |
| `source` | ✅ | `{ "type": "npm" }` 或 `{ "type": "git", ... }` |
| `engines.dsh` | | SemVer 范围；**禁止** `workspace:` 前缀 |

`source` 两种形式：

```json
{ "type": "npm", "registry": "https://registry.npmmirror.com" }
```
```json
{
  "type": "git",
  "url": "https://github.com/author/repo",
  "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
  "path": "packages/foo"
}
```

git 的 `commit` 必须是 **40 位小写十六进制** SHA（不能写分支名或短 SHA）。

---

## 安装时会怎么装

| 来源 | 生成给 pnpm 的 spec |
|---|---|
| npm | `<name>@<version>` |
| git | `git+<url>.git#<commit>`，有 `path` 时追加 `&path:/<path>` |

默认版本 = 最高兼容版本（优先非预发布）；`dist-tags.latest` 只影响渠道显示，**绝不会装 `name@latest`**。

---

## 手把手：三步做出自己的索引

### 1. 用脚本生成（别手写，字段太多容易错）

`build-index.mjs` 已经从 npm 拉真实元数据、生成合法索引：

```bash
node build-index.mjs dshmarket dsh-better-sidebar @michengai/dsh-skills-manager
```
输出 `index.json`，只收录**真正声明了 `dsh.bundle`** 的版本（否则装了也用不了）。
也可以用配置文件：

```json
{
  "title": { "en": "Our Team Bundles", "zh": "团队组合包" },
  "out": "index.json",
  "metadata": {
    "categories": { "ui": { "title": { "en": "UI", "zh": "界面" } } }
  },
  "plugins": ["dsh-better-sidebar", "@michengai/dsh-skills-manager"]
}
```

```bash
node build-index.mjs --config market.config.json
```

### 2. 托管成可访问的 URL

任选其一：

- **GitHub Pages**：仓库放 `index.json`，启用 Pages → `https://<user>.github.io/<repo>/index.json`
- **Gitee Pages / 对象存储 / 自己的服务器**：保证返回 `Content-Type: application/json`，且**直接 200，不要重定向**
- **本机临时测试**：`npx serve .` 或 `python -m http.server`，填 `http://127.0.0.1:8080/index.json`

> ⚠️ 别用 `raw.githubusercontent.com` 的短链接 —— DSH 拒绝重定向。要用它的**最终** URL。

### 3. 填进去

设置 → 插件 → **发现** → **添加索引源** → 粘贴 URL → 添加 → 点**刷新**。

成功后：出现卡片列表、可搜索/筛选/排序，点卡片看详情，点**安装**走正常的安装确认流程。

---

## 常见报错对照

| 报错 | 原因 |
|---|---|
| `$.format must be 1` | 漏写 `format: 1`，或写成了 `"1"` |
| `$.title must contain en` | 用了对象但没写 `en`，改成 `{"en": "..."}` |
| `must be an integer number of Unix seconds` | `publishTimestamp` 写成了毫秒或 ISO 字符串 |
| `must not be a workspace: range` | `engines.dsh` 里写了 `workspace:*` |
| `references undeclared id "x"` | 用了没在根 `metadata` 声明的分类/标签/排序键 |
| `must be a valid npm package name` | `name` 有大写字母、空格或下划线开头 |
| `Could not fetch ...` / `HTTP 4xx` | URL 错、需要登录、或被重定向 |
| `读取失败` + 空白 | 响应不是 UTF-8 JSON，或站点返回了 HTML 404 页 |

---

## 真实的第三方索引存在吗

**目前没有公开的 format-1 索引服务。** 实测：

| 站点 | 情况 |
|---|---|
| 官方 | **无官方市场**，随包配置默认不启用任何索引源 |
| `dshmarket.com` | 是**插件**（npm 包 `dshmarket`），不是索引源；`/index.json` 返回 404 |
| `www.dsh.so/plugins-index.json` | 有 JSON，但**不是** format 1（无 `format` 字段，是它自己的 registry 摘要）→ 会被拒绝 |
| `awesome-dsh-plugin.com` | 精选列表页面，无 `index.json` |

所以想让「发现」页有内容，**只能自己造一个**——上面的脚本就是干这个的。

---

## 安全提醒（来自官方文档的明确声明）

- 索引**没有签名**。`title`、`author`、标签、评分全是**市场的声明**，`official` 标签不代表 DSH 验证过。
- 索引内容**未经 DSH 审核**就会显示给你，并通过 `plugin_market` 工具传给模型。
- 插件安装后**以你的权限运行**，含构建脚本。只添加你信任的来源。
- 每次安装都会**重新检查源 manifest**，安装的还是包自己声明的内容 —— 索引只是「目录」，不是「担保」。

---

## 附：校验用的实测记录

本目录下的格式结论全部用 DSH 自带的 `parseMarketIndex` 实跑验证过（`tools/` 内的校验器从本机 DSH 安装包原样提取）：

```bash
# 有效索引
$ node tools/check.mjs tools/fixtures/sample-index.json
VALID
title: {"en":"My Team Market","zh":"我的团队市场"}
 - @acme/dsh-plugin-hello 默认版本= 1.2.0 安装参数= {"spec":"@acme/dsh-plugin-hello@1.2.0"}

# 错误示例会被精确拒绝
$ node tools/check.mjs tools/fixtures/bad1.json
INVALID: MarketIndexError $.format must be 1
path= $.format reason= must be 1

# 生成后的索引 + 本地 HTTP 服务，走 Host 同款抓取路径
$ node tools/e2e.mjs index.json
服务器: http://127.0.0.1:57223/index.json
HTTP 200 ok= true
解析成功 format= 1 title= "My DSH Market"
  - dshmarket 1.66.35 install= {"spec":"dshmarket@1.66.35"}
```

改完索引后，用 `node tools/check.mjs index.json` 自测一遍再发布，能省掉在界面里反复试错。

官方格式说明（`master` 分支）：
`https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md`
