# mineru-parse-dsh-tool

**English** | [简体中文](README.zh-CN.md)

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that registers a global model tool `parse_docs`: parse local PDF / DOCX / PPTX / XLSX / TIFF and image batches into Markdown with local [MinerU](https://github.com/opendatalab/MinerU).

---

## Features

- **Self-contained** — bundles its own wrapper script `assets/scripts/parse.ps1`; no skill package dependency
- **Zero runtime dependencies** — Node builtins only
- **Global scope** — mounted at the profile/host layer, available to every session
- **Batched + cached** — multiple files in one MinerU call; fresh `<stem>.md` outputs are reused
- **Sandbox-aware (Windows)** — fail-fast with a one-shot escalation hint when MinerU cannot run

`parse_docs` handles: `pdf` / `docx` / `pptx` / `xlsx` / `tif` / `tiff` / `jpg` / `jpeg` / `png` / `bmp`.

> Plain text (`txt` / `md` / `json` / `csv` / code) should be read with the built-in `read` tool, and single images with `read_image` — `parse_docs` returns a hint pointing to the right tool.

---

## Requirements

- DSH with a profile (tested on the `web` profile)
- Windows + PowerShell (the wrapper script is `.ps1`)
- Node.js >= 18
- **MinerU installed** — the parser engine is *not* bundled. `parse.ps1` locates it in this order:

  1. Env var `MINERU_BAT` (recommended)
  2. `mineru.config.json` — in `<plugin>\assets\scripts\` or `~\.config\mineru\` (fields `mineruBat` / `venvPython`)
  3. `D:\MinerU\mineru.bat` (if present)
  4. `mineru` on `PATH`

  If none is found, `parse_docs` returns `MINERU_UNAVAILABLE`.

---

## Installation

### For DSH users

```powershell
# from npm (after publishing)
dsh plugin --profile web add mineru-parse-dsh-tool

# or from GitHub
dsh plugin --profile web add github:83079Vermont/mineru-parse-dsh-tool
```

Then mount it in `~/.dsh/profiles/web/cordis.patch.yml` and restart dsh web:

```yaml
# - insert:
#     - id: mineru-parse-tool
#       name: 'mineru-parse-dsh-tool'
```

### Local development

```powershell
# copy the package into the plugins dir, then add it as a file: dependency
Copy-Item -Recurse <repo> $HOME\.dsh\plugins\mineru-parse-tool
dsh plugin --profile web add file:$HOME/.dsh/plugins/mineru-parse-tool
```

---

## Usage

Model-invocable tool. Parameters:

| Param | Type | Description |
|---|---|---|
| `paths` | `string[]` | **required** — absolute file paths (multiple allowed, merged into one call) |
| `backend` | `auto` \| `hybrid-engine` \| `pipeline` \| `vlm-engine` | default `auto`: <10 pages → `pipeline`, else `hybrid-engine` |
| `force` | `boolean` | ignore cache and re-parse |
| `method` | `auto` \| `txt` \| `ocr` | parsing method (pipeline / hybrid-engine only) |
| `lang` | `string` | OCR language, default `ch` (pipeline only) |
| `effort` | `medium` \| `high` | hybrid-engine effort; `high` enables chart analysis (slower) |
| `keep_images` | `boolean` | keep the extracted `images/` directory |
| `no_formula` | `boolean` | disable formula recognition (enabled by default) |
| `out_dir` | `string` | output root; default `<workspace>/.mineru-output` |
| `timeout_ms` | `number` | default `600000` |
| `sandbox_permissions` | `workspace-write` \| `danger-full-access` | only with `justification`; widens this one call |
| `justification` | `string` | one-sentence reason, required with `sandbox_permissions` |

Example:

```js
parse_docs({
  paths: ["C:\\docs\\report.pdf", "C:\\docs\\fig1.png"],
  backend: "auto",
});
```

---

## How It Works

1. **Locate the script** — `DSH_MINERU_PARSE_SCRIPT` env override, else the bundled `assets/scripts/parse.ps1` (resolved relative to this module)
2. **Invoke** — call `parse.ps1` through `ctx.shell` (PowerShell), passing all options through
3. **Parse markers** — interpret `RESULT` / `CACHED` / `MINERU_UNAVAILABLE` / `MINERU_ERROR` / `NO_SUPPORTED_FILES` / `NO_MD` / `WARNING_EMPTY`
4. **Read output** — load the Markdown via `ctx.fs` and return it (>2000 lines → head excerpt + `markdownPath`, use `read` for the rest)
5. **Output location** — default `<workspace>/.mineru-output` (sandbox-writable, cache-friendly); pass `out_dir` explicitly when the source directory is read-only

---

## Sandbox & Escalation (Windows)

DSH's Windows sandbox blocks MinerU's PDF rendering in every confined mode (`read-only`, `workspace-write`): multiprocessing named pipes are denied (`WinError 5`), and MinerU's `mkdtemp` (mode `0o700`) temp dirs get unusable ACLs. **Parsing therefore requires an unconfined (`danger-full-access`) run.**

`parse_docs` behavior:

- PDF-family inputs (pdf/docx/pptx/xlsx) under confinement **fail fast** with an escalation hint — no doomed parse attempt
- The model retries with `sandbox_permissions` + `justification` → the user approves → **only that call** runs unconfined (fail-closed; mirror of the `pwsh` tool)
- Image-only inputs are attempted even when confined (no PDF rendering involved)
- A fresh cached `.md` next to the source or under `out_dir` can be read directly with `read` — no escalation needed

---

## Configuration

| Env var | Purpose |
|---|---|
| `DSH_MINERU_PARSE_SCRIPT` | absolute path to an alternative `parse.ps1`; overrides the bundled script |
| `MINERU_BAT` | consumed by `parse.ps1`; absolute path to the MinerU executable |

---

## Development

```powershell
node tests/smoke.mjs   # unit smoke test, no MinerU required
```

After restart, `parse_docs` should appear in the session's tool list; a real PDF/DOCX call returns Markdown, a `README.md` call returns the "use read" hint.

---

## Uninstall

```powershell
dsh plugin --profile web remove mineru-parse-dsh-tool
```

Remove the `mineru-parse-tool` insert entry from `cordis.patch.yml`, then restart dsh web.

---

## License

[MIT](LICENSE) — free to use, modify, and redistribute.
