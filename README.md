# mineru-parse-dsh-tool

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that registers a global model tool `parse_docs`: parse local PDF / DOCX / PPTX / XLSX / TIFF and image batches into Markdown with local MinerU.

一个自包含的 DeepSeek Harness (DSH) 插件,注册全局模型工具 `parse_docs`:用本地 MinerU 将 PDF / DOCX / PPTX / XLSX / TIFF 及批量图片解析为 Markdown。

## Quick Install / 快速安装

```powershell
# from npm / 从 npm 安装(发布到 npm 后)
dsh plugin --profile web add mineru-parse-dsh-tool

# from GitHub / 从 GitHub 安装
dsh plugin --profile web add github:<user>/mineru-parse-dsh-tool
```

Then mount it in `~/.dsh/profiles/web/cordis.patch.yml` and restart dsh web — see [Installation](#installation--安装).
之后在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载并重启 dsh web,详见 [安装](#installation--安装)。

---

## Features / 特性

- **Self-contained** — bundles its own wrapper script `assets/scripts/parse.ps1`; no skill package dependency
- **Zero runtime dependencies** — Node builtins only
- **Global scope** — mounted at the profile/host layer, available to every session
- **Batched + cached** — multiple files in one MinerU call; fresh `<stem>.md` outputs are reused
- **Sandbox-aware (Windows)** — fail-fast with a one-shot escalation hint when MinerU cannot run

- **自包含** — 自带包装脚本 `assets/scripts/parse.ps1`,不依赖任何 skill 包
- **零运行时依赖** — 仅使用 Node 内置模块
- **全局生效** — 挂载在 profile/host 层,所有会话的模型均可调用
- **批量与缓存** — 多文件合并为一次 MinerU 调用;较新的 `<stem>.md` 产物直接复用
- **沙箱感知(Windows)** — MinerU 无法运行时快速失败并给出一次性升级提示

`parse_docs` handles: pdf / docx / pptx / xlsx / tif / tiff / jpg / jpeg / png / bmp.
纯文本(txt/md/json/csv/代码)请用内置 `read` 工具,单张图片请用 `read_image`——`parse_docs` 会返回相应提示。

---

## How It Works / 工作原理

1. **Locate the script** — `DSH_MINERU_PARSE_SCRIPT` env override, else the bundled `assets/scripts/parse.ps1` (resolved relative to this module)
2. **Invoke** — call `parse.ps1` through `ctx.shell` (PowerShell), passing all options through
3. **Parse markers** — interpret `RESULT` / `CACHED` / `MINERU_UNAVAILABLE` / `MINERU_ERROR` / `NO_SUPPORTED_FILES` / `NO_MD` / `WARNING_EMPTY`
4. **Read output** — load the Markdown via `ctx.fs` and return it (>2000 lines → head excerpt + `markdownPath`, use `read` for the rest)
5. **Output location** — default `<workspace>/.mineru-output` (sandbox-writable, cache-friendly); pass `out_dir` explicitly when the source directory is read-only

1. **定位脚本** — 优先 `DSH_MINERU_PARSE_SCRIPT` 环境变量,否则使用插件自带的 `assets/scripts/parse.ps1`(相对插件模块解析)
2. **调用** — 通过 `ctx.shell`(PowerShell 执行器)调用 `parse.ps1`,透传全部参数
3. **解析标记** — 识别 `RESULT` / `CACHED` / `MINERU_UNAVAILABLE` / `MINERU_ERROR` / `NO_SUPPORTED_FILES` / `NO_MD` / `WARNING_EMPTY`
4. **读取产物** — 用 `ctx.fs` 读取 Markdown 并返回(超过 2000 行只返回头部摘要 + `markdownPath`,其余用 `read` 分块读取)
5. **输出目录** — 默认 `<会话工作区>\.mineru-output`(沙箱可写、可命中缓存);源目录只读时显式传 `out_dir`

---

## Requirements / 环境要求

- DSH with a profile (tested on the `web` profile) / DSH 及一个 profile(在 `web` profile 上验证)
- Windows + PowerShell(脚本为 `.ps1`)
- Node.js >= 18
- **MinerU installed** — the parser engine is *not* bundled. `parse.ps1` finds it in this order:
  **MinerU 需自行安装**——解析引擎不随包分发。`parse.ps1` 按以下顺序定位:

  1. Env var `MINERU_BAT`(recommended / 推荐)
  2. `mineru.config.json` — `<plugin>\assets\scripts\` or `~\.config\mineru\`(fields `mineruBat` / `venvPython`)
  3. `D:\MinerU\mineru.bat`(if present / 若存在)
  4. `mineru` on `PATH`

  If none is found, `parse_docs` returns `MINERU_UNAVAILABLE`.
  全部找不到时,`parse_docs` 返回 `MINERU_UNAVAILABLE`。

---

## Installation / 安装

### For DSH users / 使用者

```powershell
# from npm / 从 npm 安装
dsh plugin --profile web add mineru-parse-dsh-tool

# or from GitHub / 或从 GitHub 安装
dsh plugin --profile web add github:<user>/mineru-parse-dsh-tool
```

Mount it in `~/.dsh/profiles/web/cordis.patch.yml`, then restart dsh web.
在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加挂载条目,然后重启 dsh web:

```yaml
# - insert:
#     - id: mineru-parse-tool
#       name: 'mineru-parse-dsh-tool'
```

### Local development / 本地开发

```powershell
# copy the package into the plugins dir, then add it as a file: dependency
Copy-Item -Recurse <repo> $HOME\.dsh\plugins\mineru-parse-tool
dsh plugin --profile web add file:$HOME/.dsh/plugins/mineru-parse-tool
```

---

## Usage / 使用

Model-invocable tool. Parameters / 模型可直接调用的工具,参数如下:

| Param 参数 | Type 类型 | Description 说明 |
|---|---|---|
| `paths` | `string[]` | **required / 必填** — absolute file paths 绝对路径(可多个,合并为一次调用) |
| `backend` | `auto` \| `hybrid-engine` \| `pipeline` \| `vlm-engine` | default `auto`: <10 pages → `pipeline`, else `hybrid-engine` |
| `force` | `boolean` | ignore cache and re-parse 忽略缓存强制重解析 |
| `method` | `auto` \| `txt` \| `ocr` | parsing method(pipeline / hybrid-engine only) |
| `lang` | `string` | OCR language, default `ch`(pipeline only) |
| `effort` | `medium` \| `high` | hybrid-engine effort; `high` enables chart analysis 更慢但带图表分析 |
| `keep_images` | `boolean` | keep the extracted `images/` directory 保留抽取的图片目录 |
| `no_formula` | `boolean` | disable formula recognition 关闭公式识别(默认开启) |
| `out_dir` | `string` | output root; default `<workspace>/.mineru-output` 输出根目录 |
| `timeout_ms` | `number` | default `600000` |
| `sandbox_permissions` | `workspace-write` \| `danger-full-access` | only with `justification`; widens this one call 仅本次调用升级沙箱权限 |
| `justification` | `string` | one-sentence reason, required with `sandbox_permissions` 一句话理由,与前者成对 |

Example / 示例:

```js
parse_docs({
  paths: ["C:\\docs\\report.pdf", "C:\\docs\\fig1.png"],
  backend: "auto",
});
```

---

## Sandbox & Escalation (Windows) / 沙箱与权限升级(Windows)

DSH's Windows sandbox blocks MinerU's PDF rendering in every confined mode (`read-only`, `workspace-write`): multiprocessing named pipes are denied (`WinError 5`), and MinerU's `mkdtemp` (mode `0o700`) temp dirs get unusable ACLs. **Parsing therefore requires an unconfined (`danger-full-access`) run.**

DSH 的 Windows 沙箱在受限模式(`read-only` / `workspace-write`)下都会阻断 MinerU 的 PDF 渲染:多进程命名管道被拒绝(`WinError 5`),`mkdtemp`(mode `0o700`)临时目录的 ACL 不可用。**因此解析只能在非受限(`danger-full-access`)模式下运行。**

`parse_docs` behavior / 行为:

- PDF-family inputs (pdf/docx/pptx/xlsx) under confinement **fail fast** with an escalation hint — no doomed parse attempt
  受限会话中 PDF 系列输入**立即失败**并附升级提示,不浪费一次注定失败的解析
- The model retries with `sandbox_permissions` + `justification` → the user approves → **only that call** runs unconfined (fail-closed; mirror of the `pwsh` tool)
  模型按提示重试:传 `sandbox_permissions` + `justification` → 用户审批 → **仅该次调用**以非受限模式运行(fail-closed,与 `pwsh` 工具机制一致)
- Image-only inputs are attempted even when confined (no PDF rendering involved)
  纯图片输入不受限制,受限会话会直接尝试
- A fresh cached `.md` next to the source or under `out_dir` can be read directly with `read` — no escalation needed
  已有较新缓存产物时,直接用 `read` 读取即可,无需升级

---

## Configuration / 配置

| Env var 环境变量 | Purpose 说明 |
|---|---|
| `DSH_MINERU_PARSE_SCRIPT` | absolute path to an alternative `parse.ps1`; overrides the bundled script 自定义解析脚本,覆盖自带脚本 |
| `MINERU_BAT` | consumed by `parse.ps1`; absolute path to the MinerU executable 供 `parse.ps1` 定位 MinerU |

---

## Development / 开发

```powershell
node tests/smoke.mjs   # unit smoke test, no MinerU required / 不依赖 MinerU
```

After restart, `parse_docs` should appear in the session's tool list; a real PDF/DOCX call returns Markdown, a `README.md` call returns the "use read" hint.
重启后会话工具清单中应出现 `parse_docs`;对真实 PDF/DOCX 调用返回 Markdown,对 `README.md` 调用返回「请用 read」提示。

---

## Uninstall / 卸载

```powershell
dsh plugin --profile web remove mineru-parse-dsh-tool
```

Remove the `mineru-parse-tool` insert entry from `cordis.patch.yml`, then restart dsh web.
删除 `cordis.patch.yml` 中的 `mineru-parse-tool` insert 条目,重启 web。

---

## License / 许可

[MIT](LICENSE) — free to use, modify, and redistribute.
MIT — 随附代码可自由使用、修改与再分发。
