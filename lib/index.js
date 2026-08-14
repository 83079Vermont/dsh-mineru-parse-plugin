// mineru-parse-dsh-tool: global DSH plugin registering the `parse_docs` model
// tool.
//
// The tool parses local documents into Markdown with local MinerU: PDF /
// DOCX / PPTX / XLSX / TIFF / TIF and batches of images go through the
// bundled wrapper script (parse.ps1), and the markdown content is returned
// directly. Plain text (txt/md/json/csv/...) should be read with the built-in
// `read` tool and a single image with `read_image`; `parse_docs` reports a
// hint for those instead.
//
// Design constraints:
// - ZERO runtime dependencies (Node builtins only): the package installs into
//   a profile with no module-resolution surprises.
// - Self-contained: this package ships its own copy of the parse wrapper at
//   assets/scripts/parse.ps1 (resolved relative to this module), so it has NO
//   dependency on any skill package. The only external requirement is the
//   MinerU runtime installed on the machine (see parse.ps1's own lookup:
//   MINERU_BAT -> mineru.config.json -> D:\MinerU\mineru.bat -> PATH).
// - The tool is registered as a RAW ToolDefinition (JSON-Schema-form
//   `parameters`, enforced subset only) through `ctx.tools.register`, so it is
//   visible in the host/global layer for every session.
// - The parse.ps1 location is resolved at call time: env override
//   DSH_MINERU_PARSE_SCRIPT, else the bundled assets/scripts/parse.ps1.
//   Output goes to <workspace>/.mineru-output by default so writes stay inside
//   the sandbox and caching works.
//
// Sandbox behavior (Windows):
//   MinerU's PDF rendering uses multiprocessing, whose named pipes are blocked
//   by the DSH Windows sandbox in every confined mode (read-only and
//   workspace-write), and its api-client creates its temp dir with mkdtemp
//   mode 0o700 which the sandbox turns into an unusable ACL. Parsing therefore
//   needs an unconfined run. `parse_docs` mirrors the `pwsh` tool's escalation
//   contract: the model passes sandbox_permissions + justification, the user
//   approves, and only that call runs unconfined. The escalation choreography
//   below is a verbatim zero-dependency re-implementation of
//   `@deepseek-ai/dsh-sandbox`'s approveEscalation (MIT).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis plugin name. */
const name = "mineru-parse-tool";
/** Hard dependencies: the tool registry plus the services execute() consumes. */
const inject = ["tools", "shell", "fs"];

/** Bundled parse.ps1, resolved relative to this module (lib/../assets). */
const BUNDLED_SCRIPT = fileURLToPath(new URL("../assets/scripts/parse.ps1", import.meta.url));

/** Extensions parse.ps1 accepts (MinerU formats + images). */
const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".pptx", ".xlsx", ".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"];
/** Formats that go through MinerU's PDF rendering (blocked by the Windows sandbox). */
const PDF_FAMILY_EXTENSIONS = [".pdf", ".docx", ".pptx", ".xlsx"];
/** Markdown longer than this returns a head excerpt instead of the full body. */
const MAX_CONTENT_LINES = 2000;
/** Default command timeout (ms); equals the shell executor's maxTimeoutMs cap. */
const DEFAULT_TIMEOUT_MS = 600000;
/** Foreground stdout capture budget: large enough to keep the marker lines. */
const STDOUT_MAX_BYTES = 4 * 1024 * 1024;

// --- sandbox escalation (re-implementation of @deepseek-ai/dsh-sandbox) ---

/** The strictly-wider ladder: what a call whose effective mode is the key may escalate TO. */
const WIDER_MODES = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
};

/** Validate the sandbox_permissions/justification pairing. */
function validateEscalationArgs(sandboxPermissions, justification) {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error("invalid escalation: sandbox_permissions requires a justification");
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error("invalid justification: expected a non-empty sentence");
  }
}

/**
 * Resolve a sandbox-escalation request BEFORE anything executes: strict
 * widening check, approval channel, outcome mapping (fail closed). Returns the
 * granted mode to stamp onto exactly this call.
 */
async function approveEscalation(request, approval) {
  const { requestedMode: mode, effectiveMode, justification, subject } = request;
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`);
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`);
  }
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...(approval.signal ? { signal: approval.signal } : {}),
  });
  switch (outcome) {
    case "allowed-once":
      return mode;
    case "rejected":
      throw new Error(`the user rejected escalating this ${subject} to "${mode}"`);
    case "cancelled":
      throw new Error(`approval for escalating to "${mode}" was cancelled`);
    case "unavailable":
      throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
    default:
      throw new Error(`unexpected approval outcome: ${String(outcome)}`);
  }
}

// --- helpers ---

/** Quote a value as a PowerShell single-quoted literal ('' escapes a quote). */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Build the PowerShell invocation of parse.ps1. */
function buildCommand(script, args, outDir) {
  const parts = ["&", psQuote(script), "-Paths"];
  for (const p of args.paths) parts.push(psQuote(p));
  if (outDir) parts.push("-OutDir", psQuote(outDir));
  if (args.backend !== undefined) parts.push("-Backend", args.backend);
  if (args.force === true) parts.push("-Force");
  if (args.method !== undefined) parts.push("-Method", args.method);
  if (args.lang !== undefined) parts.push("-Lang", psQuote(args.lang));
  if (args.effort !== undefined) parts.push("-Effort", args.effort);
  if (args.keep_images === true) parts.push("-KeepImages");
  if (args.no_formula === true) parts.push("-NoFormula");
  return parts.join(" ");
}

/** Manual argument validation (raw tools own their input validation). */
function validateArgs(args) {
  if (
    typeof args !== "object" ||
    args === null ||
    !Array.isArray(args.paths) ||
    args.paths.length === 0 ||
    !args.paths.every((p) => typeof p === "string" && p.length > 0)
  ) {
    throw new Error("invalid arguments: paths must be a non-empty array of absolute file paths");
  }
  if (args.backend !== undefined && !["auto", "hybrid-engine", "pipeline", "vlm-engine"].includes(args.backend)) {
    throw new Error(`invalid arguments: backend must be one of auto/hybrid-engine/pipeline/vlm-engine, got ${JSON.stringify(args.backend)}`);
  }
  if (args.method !== undefined && !["auto", "txt", "ocr"].includes(args.method)) {
    throw new Error(`invalid arguments: method must be one of auto/txt/ocr, got ${JSON.stringify(args.method)}`);
  }
  if (args.effort !== undefined && !["medium", "high"].includes(args.effort)) {
    throw new Error(`invalid arguments: effort must be one of medium/high, got ${JSON.stringify(args.effort)}`);
  }
  if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) {
    throw new Error(`invalid arguments: timeout_ms must be a positive number, got ${JSON.stringify(args.timeout_ms)}`);
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification);
}

/** Lowercased extension of a path ("" when none). */
function extOf(p) {
  const s = String(p);
  const i = s.lastIndexOf(".");
  return i < 0 ? "" : s.slice(i).toLowerCase();
}

/** Resolve the parse.ps1 path: env override first, then the bundled asset. */
function locateScript() {
  const fromEnv = process.env.DSH_MINERU_PARSE_SCRIPT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return existsSync(BUNDLED_SCRIPT) ? BUNDLED_SCRIPT : undefined;
}

/**
 * Parse the marker lines parse.ps1 writes to stdout. Recognised markers:
 * CACHED, MINERU_UNAVAILABLE, MINERU_ERROR, NO_SUPPORTED_FILES, NO_MD,
 * WARNING_EMPTY, RESULT, DONE.
 */
function parseMarkers(stdout) {
  const markers = {
    unavailable: false,
    mineruError: null,
    noSupported: false,
    results: [],
    cached: [],
    noMd: [],
    emptySources: [],
  };
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("MINERU_UNAVAILABLE")) markers.unavailable = true;
    else if (line.startsWith("MINERU_ERROR\t")) markers.mineruError = line.slice("MINERU_ERROR\t".length) || "?";
    else if (line.startsWith("NO_SUPPORTED_FILES")) markers.noSupported = true;
    else if (line.startsWith("NO_MD\t")) markers.noMd.push(line.slice("NO_MD\t".length));
    else if (line.startsWith("WARNING_EMPTY\t")) markers.emptySources.push(line.slice("WARNING_EMPTY\t".length));
    else if (line.startsWith("CACHED\t")) {
      const parts = line.split("\t");
      if (parts.length >= 3) markers.cached.push({ source: parts[1], md: parts[2] });
    } else if (line.startsWith("RESULT\t")) {
      const parts = line.split("\t");
      if (parts.length >= 5) {
        markers.results.push({ source: parts[1], md: parts[2], bytes: Number(parts[3]), lines: Number(parts[4]) });
      }
    }
  }
  return markers;
}

function truncate(text, max) {
  const s = String(text);
  return s.length <= max ? s : s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

/** An all-errors result (schema-shaped). */
function errorResult(errors) {
  return { ok: false, parsed: 0, cached: 0, files: [], warnings: [], errors };
}

/** Render the structured result as the text the model sees. */
function formatResult(value) {
  const parts = [];
  for (const f of value.files) {
    const notes = [];
    if (f.empty) notes.push(`small output (${f.bytes} bytes); may be blank or a failed scan — consider read/read_image on the original`);
    if (f.truncated) notes.push(`content truncated; full markdown at ${f.markdownPath} (read with offset/limit for more)`);
    parts.push(`## ${f.source}${notes.length > 0 ? `\n[note: ${notes.join("; ")}]` : ""}\n${f.content || "(empty)"}`);
  }
  if (value.files.length === 0) parts.push("(no markdown produced)");
  if (value.warnings.length > 0) parts.push(`## Warnings\n${value.warnings.map((w) => `- ${w}`).join("\n")}`);
  if (value.errors.length > 0) parts.push(`## Errors\n${value.errors.map((e) => `- ${e}`).join("\n")}`);
  return parts.join("\n\n");
}

/** The core of execute(): run parse.ps1 and assemble the structured result. */
async function runParse(ctx, args, exec) {
  validateArgs(args);
  const errors = [];
  const warnings = [];

  const cwd = exec?.agent?.session?.header?.cwd;
  const outDir =
    typeof args.out_dir === "string" && args.out_dir.length > 0
      ? args.out_dir
      : cwd !== undefined
        ? join(cwd, ".mineru-output")
        : undefined;

  const script = locateScript();
  if (script === undefined) {
    return errorResult([
      "parse.ps1 could not be located: the bundled assets/scripts/parse.ps1 is missing from the installed package. Reinstall mineru-parse-dsh-tool, or set DSH_MINERU_PARSE_SCRIPT to the absolute path of parse.ps1, then retry",
    ]);
  }

  // Resolve the standing sandbox policy, then apply an approval-gated
  // escalation when the model requested one (mirrors the pwsh tool).
  const sandboxPolicy = ctx.get("sandboxPolicy");
  let policy =
    sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(exec?.agent ? { session: exec.agent.session } : {});
  if (args.sandbox_permissions !== undefined) {
    const granted = await approveEscalation(
      {
        requestedMode: args.sandbox_permissions,
        justification: args.justification,
        effectiveMode: policy?.mode ?? "read-only",
        subject: "command",
      },
      {
        approver: ctx.get("approval"),
        agent: exec?.agent,
        callId: exec?.callId,
        toolName: "parse_docs",
        signal: exec?.signal,
      },
    );
    policy = policy === undefined ? undefined : { ...policy, mode: granted };
  }

  // Fail fast under the Windows sandbox: MinerU's multiprocessing named pipes
  // are blocked in every confined mode, so a confined, non-escalated run of a
  // PDF-family document is doomed. Image-only inputs may still work and are
  // attempted.
  if (
    args.sandbox_permissions === undefined &&
    policy !== undefined &&
    policy.mode !== "danger-full-access" &&
    process.platform === "win32" &&
    args.paths.some((p) => PDF_FAMILY_EXTENSIONS.includes(extOf(p)))
  ) {
    return errorResult([
      `MinerU cannot run under sandbox mode "${policy.mode}": the Windows sandbox blocks the multiprocessing named pipes MinerU's PDF rendering requires, and its temp-dir handling is sandbox-incompatible. ` +
        `[sandbox: escalation available — retry this exact parse once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user] ` +
        `If a fresh .md already exists next to the source file or under the out_dir, read that file directly with the read tool instead (no escalation needed).`,
    ]);
  }

  const request = {
    command: buildCommand(script, args, outDir),
    timeoutMs: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    stdoutMaxBytes: STDOUT_MAX_BYTES,
    ...(cwd !== undefined ? { workdir: cwd } : {}),
    ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
  };

  let result;
  try {
    result = await ctx.shell.run(ctx.shell.resolve(request));
  } catch (error) {
    return errorResult([`failed to run parse.ps1: ${error instanceof Error ? error.message : String(error)}`]);
  }

  if (result.sandbox !== undefined && result.sandbox.denied) {
    return errorResult([
      `sandbox denied the parse command under ${result.sandbox.mode} mode. ` +
        `[sandbox: escalation available — retry this exact parse once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user] ` +
        `stderr: ${truncate(result.stderr?.text ?? "", 2000)}`,
    ]);
  }
  if (result.timedOut) {
    return errorResult([`parse.ps1 timed out after ${result.timeoutMs}ms. Increase timeout_ms or use a lighter backend (pipeline)`]);
  }
  if (result.aborted) {
    return errorResult(["parse.ps1 was aborted (the tool call was cancelled)"]);
  }

  let stdout = result.stdout?.text ?? "";
  if (result.stdout?.truncated === true && result.stdout.spillPath !== undefined) {
    try {
      const target = await ctx.fs.resolve(result.stdout.spillPath);
      stdout = await ctx.fs.readText(target);
    } catch {
      // keep the truncated text
    }
  }

  const markers = parseMarkers(stdout);
  if (markers.unavailable) {
    return errorResult([
      "MinerU is unavailable on this machine. Install MinerU (magic-pdf) so the `mineru` command is on PATH, or point parse.ps1 at it via the MINERU_BAT environment variable (or a mineru.config.json with mineruBat), then retry",
    ]);
  }
  if (markers.mineruError !== null) {
    return errorResult([`MinerU exited with error code ${markers.mineruError}. Output tail: ${truncate(stdout, 2000)}`]);
  }
  if (markers.noSupported) {
    return errorResult([
      `no supported files among the given paths. parse_docs handles ${SUPPORTED_EXTENSIONS.join(", ")}. Plain text (txt/md/json/csv/code) → use the read tool; a single image → use read_image`,
    ]);
  }

  const files = [];
  const hits = [
    ...markers.results.map((r) => ({ ...r, cached: false })),
    ...markers.cached.map((c) => ({ ...c, bytes: 0, lines: 0, cached: true })),
  ];
  for (const hit of hits) {
    const entry = {
      source: hit.source,
      markdownPath: hit.md,
      bytes: hit.bytes,
      lines: hit.lines,
      empty: markers.emptySources.includes(hit.source),
      truncated: false,
      content: "",
    };
    try {
      const target = await ctx.fs.resolve(hit.md);
      const content = await ctx.fs.readText(target);
      const lineArr = content.split("\n");
      if (!hit.cached) entry.lines = lineArr.length > 0 ? lineArr.length : entry.lines;
      if (lineArr.length > MAX_CONTENT_LINES) {
        entry.truncated = true;
        entry.content =
          lineArr.slice(0, MAX_CONTENT_LINES).join("\n") +
          `\n\n...[truncated: ${lineArr.length} lines total; read the full markdown at ${hit.md} with the read tool (offset/limit) for the rest]`;
      } else {
        entry.content = content;
      }
      if (entry.empty) {
        warnings.push(`${hit.source}: parsed markdown is small (${hit.bytes} bytes) — may be blank or a failed scan; consider reading the original with read/read_image`);
      }
    } catch (error) {
      warnings.push(
        `${hit.source}: parsed markdown at ${hit.md} could not be read (${error instanceof Error ? error.message : String(error)}); use the read tool on the original file`,
      );
    }
    files.push(entry);
  }

  for (const src of markers.noMd) {
    warnings.push(`${src}: MinerU produced no markdown (NO_MD); fall back to reading the original with read/read_image`);
  }

  if (files.length === 0 && errors.length === 0) {
    errors.push(
      "no markdown was produced (no RESULT/CACHED lines). Fall back to reading the original file with read/read_image, or retry with force: true. If this ran under a sandbox, retry with sandbox_permissions + justification",
    );
  }

  return {
    ok: errors.length === 0 && files.length > 0,
    parsed: markers.results.length,
    cached: markers.cached.length,
    files,
    warnings,
    errors,
  };
}

/** Build the raw ToolDefinition for the current context. */
function toolDefinition(ctx) {
  return {
    name: "parse_docs",
    description:
      "Parse local documents into Markdown with local MinerU and return the content so you can read them. Handles pdf/docx/pptx/xlsx/tif/tiff and batches of images (jpg/jpeg/png/bmp); multiple files are batched into one MinerU call. 使用本地 MinerU 将文档解析为 Markdown 后读取。单张图片直接用 read_image 查看，纯文本（txt/md/json/csv）直接用 read。触发词：mineru、pdf、docx、pptx、xlsx、tiff、解析、parse、parse_docs。Windows 沙箱会阻断 MinerU 的多进程渲染：受限会话首次调用会失败并提示，请按提示用 sandbox_permissions + justification 重试以请求一次性升级。",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Absolute file paths to parse (multiple allowed; batched into one MinerU call). Supported: pdf/docx/pptx/xlsx/tif/tiff and images jpg/jpeg/png/bmp. 支持 pdf/docx/pptx/xlsx/tif/tiff 与图片。",
        },
        backend: {
          type: "string",
          enum: ["auto", "hybrid-engine", "pipeline", "vlm-engine"],
          description: "MinerU backend. auto (default): <10 total pages → pipeline, otherwise hybrid-engine.",
        },
        force: {
          type: "boolean",
          description: "Ignore the cache and re-parse even when a fresh .md already exists.",
        },
        method: {
          type: "string",
          enum: ["auto", "txt", "ocr"],
          description: "Parsing method (pipeline / hybrid-engine only).",
        },
        lang: {
          type: "string",
          description: "OCR language, default ch (pipeline only).",
        },
        effort: {
          type: "string",
          enum: ["medium", "high"],
          description: "hybrid-engine effort; high enables chart analysis and is slower.",
        },
        keep_images: {
          type: "boolean",
          description: "Keep the images/ directory of extracted figures.",
        },
        no_formula: {
          type: "boolean",
          description: "Disable formula recognition (enabled by default).",
        },
        out_dir: {
          type: "string",
          description:
            "Output root directory. Default: <session workspace>/.mineru-output. Use a writable directory when the source files' directory is read-only or outside the sandbox.",
        },
        timeout_ms: {
          type: "number",
          description: "Command timeout in milliseconds (default 600000; the parse wrapper prints RECOMMENDED_TIMEOUT_SECONDS for long docs).",
        },
        sandbox_permissions: {
          type: "string",
          enum: ["workspace-write", "danger-full-access"],
          description:
            "Only valid with justification. Widens this one parse call beyond the session's sandbox mode. MinerU needs danger-full-access on Windows (the sandbox blocks its multiprocessing named pipes). The user approves before anything runs.",
        },
        justification: {
          type: "string",
          description: "Required with sandbox_permissions: one sentence explaining why this parse needs the wider sandbox access.",
        },
      },
      required: ["paths"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          parsed: { type: "integer" },
          cached: { type: "integer" },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                markdownPath: { type: "string" },
                bytes: { type: "integer" },
                lines: { type: "integer" },
                empty: { type: "boolean" },
                truncated: { type: "boolean" },
                content: { type: "string" },
              },
              required: ["source", "markdownPath", "bytes", "lines", "empty", "truncated", "content"],
            },
          },
          warnings: { type: "array", items: { type: "string" } },
          errors: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "parsed", "cached", "files", "warnings", "errors"],
      },
      render: (_args, value) => [{ type: "text", text: formatResult(value) }],
    },
    async execute(args, exec) {
      return runParse(ctx, args, exec);
    },
  };
}

/** Register the parse_docs tool in the calling (global/host) layer. */
function apply(ctx) {
  ctx.tools.register(toolDefinition(ctx));
}

export { apply, inject, name, toolDefinition };
