# mineru-parse-dsh-tool

[English](README.md) | **简体中文**

一个自包含的 [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) 插件,注册全局模型工具 `parse_docs`:用本地 [MinerU](https://github.com/opendatalab/MinerU) 将 PDF / DOCX / PPTX / XLSX / TIFF 及批量图片解析为 Markdown。

---

## 特性

- **自包含** — 自带包装脚本 `assets/scripts/parse.ps1`,不依赖任何 skill 包
- **零运行时依赖** — 仅使用 Node 内置模块
- **全局生效** — 挂载在 profile/host 层,所有会话的模型均可调用
- **批量与缓存** — 多文件合并为一次 MinerU 调用;较新的 `<stem>.md` 产物直接复用
- **沙箱感知(Windows)** — MinerU 无法运行时快速失败并给出一次性升级提示

`parse_docs` 支持:`pdf` / `docx` / `pptx` / `xlsx` / `tif` / `tiff` / `jpg` / `jpeg` / `png` / `bmp`。

> 纯文本(`txt` / `md` / `json` / `csv` / 代码)请用内置 `read` 工具,单张图片请用 `read_image`——`parse_docs` 会返回相应提示。

---

## 环境要求

- DSH 及一个 profile(在 `web` profile 上验证)
- Windows + PowerShell(包装脚本为 `.ps1`)
- Node.js >= 18
- **MinerU 需自行安装**——解析引擎不随包分发。`parse.ps1` 按以下顺序定位:

  1. 环境变量 `MINERU_BAT`(推荐)
  2. `mineru.config.json` — 位于 `<plugin>\assets\scripts\` 或 `~\.config\mineru\`(字段 `mineruBat` / `venvPython`)
  3. `D:\MinerU\mineru.bat`(若存在)
  4. `PATH` 中的 `mineru`

  全部找不到时,`parse_docs` 返回 `MINERU_UNAVAILABLE`。

---

## 安装

### 使用者

```powershell
# 从 npm 安装
dsh plugin --profile web add mineru-parse-dsh-tool

# 或从 GitHub 安装
dsh plugin --profile web add github:83079Vermont/dsh-mineru-parse-plugin
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加挂载条目,重启 dsh web:

```yaml
# - insert:
#     - id: mineru-parse-tool
#       name: 'mineru-parse-dsh-tool'
```

### 本地开发

```powershell
# 把包复制到 plugins 目录,再以 file: 依赖添加
Copy-Item -Recurse <repo> $HOME\.dsh\plugins\mineru-parse-tool
dsh plugin --profile web add file:$HOME/.dsh/plugins/mineru-parse-tool
```

---

## 使用

模型可直接调用的工具,参数如下:

| 参数                    | 类型                                                            | 说明                                                          |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| `paths`               | `string[]`                                                    | **必填** — 绝对路径(可多个,合并为一次调用)             |
| `backend`             | `auto` \| `hybrid-engine` \| `pipeline` \| `vlm-engine` | 默认`auto`:少于 10 页用 `pipeline`,否则 `hybrid-engine` |
| `force`               | `boolean`                                                     | 忽略缓存强制重解析                                            |
| `method`              | `auto` \| `txt` \| `ocr`                                  | 解析方式(仅 pipeline / hybrid-engine)                         |
| `lang`                | `string`                                                      | OCR 语言,默认`ch`(仅 pipeline)                              |
| `effort`              | `medium` \| `high`                                          | hybrid-engine 力度;`high` 带图表分析(更慢)                  |
| `keep_images`         | `boolean`                                                     | 保留抽取的`images/` 目录                                    |
| `no_formula`          | `boolean`                                                     | 关闭公式识别(默认开启)                                        |
| `out_dir`             | `string`                                                      | 输出根目录;默认`<workspace>/.mineru-output`                 |
| `timeout_ms`          | `number`                                                      | 默认`600000`                                                |
| `sandbox_permissions` | `workspace-write` \| `danger-full-access`                   | 需与`justification` 成对;仅本次调用升级沙箱权限             |
| `justification`       | `string`                                                      | 一句话理由,与`sandbox_permissions` 成对                     |

示例:

```js
parse_docs({
  paths: ["C:\\docs\\report.pdf", "C:\\docs\\fig1.png"],
  backend: "auto",
});
```

---

## 工作原理

1. **定位脚本** — 优先 `DSH_MINERU_PARSE_SCRIPT` 环境变量,否则使用插件自带的 `assets/scripts/parse.ps1`(相对插件模块解析)
2. **调用** — 通过 `ctx.shell`(PowerShell 执行器)调用 `parse.ps1`,透传全部参数
3. **解析标记** — 识别 `RESULT` / `CACHED` / `MINERU_UNAVAILABLE` / `MINERU_ERROR` / `NO_SUPPORTED_FILES` / `NO_MD` / `WARNING_EMPTY`
4. **读取产物** — 用 `ctx.fs` 读取 Markdown 并返回(超过 2000 行只返回头部摘要 + `markdownPath`,其余用 `read` 分块读取)
5. **输出目录** — 默认 `<会话工作区>\.mineru-output`(沙箱可写、可命中缓存);源目录只读时显式传 `out_dir`

---

## 沙箱与权限升级(Windows)

DSH 的 Windows 沙箱在受限模式(`read-only` / `workspace-write`)下都会阻断 MinerU 的 PDF 渲染:多进程命名管道被拒绝(`WinError 5`),`mkdtemp`(mode `0o700`)临时目录的 ACL 不可用。**因此解析只能在非受限(`danger-full-access`)模式下运行。**

`parse_docs` 行为:

- 受限会话中 PDF 系列输入(pdf/docx/pptx/xlsx)**立即失败**并附升级提示,不浪费一次注定失败的解析
- 模型按提示重试:传 `sandbox_permissions` + `justification` → 用户审批 → **仅该次调用**以非受限模式运行(fail-closed,与 `pwsh` 工具机制一致)
- 纯图片输入不受限制,受限会话会直接尝试
- 已有较新缓存产物时,直接用 `read` 读取即可,无需升级

---

## 配置

| 环境变量                    | 说明                                             |
| --------------------------- | ------------------------------------------------ |
| `DSH_MINERU_PARSE_SCRIPT` | 自定义解析脚本的绝对路径,覆盖自带脚本            |
| `MINERU_BAT`              | 供`parse.ps1` 定位 MinerU 可执行文件的绝对路径 |

---

## 开发

```powershell
node tests/smoke.mjs   # 单元冒烟测试,不依赖 MinerU
```

重启后会话工具清单中应出现 `parse_docs`;对真实 PDF/DOCX 调用返回 Markdown,对 `README.md` 调用返回「请用 read」提示。

---

## 卸载

```powershell
dsh plugin --profile web remove mineru-parse-dsh-tool
```

删除 `cordis.patch.yml` 中的 `mineru-parse-tool` insert 条目,重启 dsh web。

---

## 许可

[MIT](LICENSE) — 随附代码可自由使用、修改与再分发。
