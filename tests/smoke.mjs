// Smoke test for mineru-parse-dsh-tool. Run with `node tests/smoke.mjs` from
// the package root. No MinerU required: ctx.shell / ctx.fs are stubbed and
// execute() is exercised against synthetic parse.ps1 stdout. The plugin is
// self-contained: parse.ps1 is resolved from the bundled asset, no skill
// package involved.
import { apply, inject, name, toolDefinition } from "../lib/index.js";

const registered = [];

function makeCtx(stdoutText, opts = {}) {
  let lastRequest = null;
  const shell = {
    resolve: (request) => {
      lastRequest = request;
      return request;
    },
    run: async (spec) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: stdoutText, truncated: false },
      stderr: { text: "" },
    }),
  };
  const fs = {
    resolve: async (p) => ({ key: p }),
    readText: async () => "fake markdown\nsecond line\n",
  };
  const services = { shell, fs };
  if (opts.sandbox !== false) {
    services.sandboxPolicy = { resolve: () => ({ mode: opts.policyMode ?? "workspace-write", workspaceRoot: "D:\\ws" }) };
  }
  if (opts.approvalOutcome !== undefined) {
    services.approval = { request: async () => opts.approvalOutcome };
  }
  return {
    tools: {
      register: (def) => {
        registered.push(def);
        return () => {};
      },
    },
    shell,
    fs,
    get: (k) => services[k],
    lastRequest: () => lastRequest,
  };
}

const exec = { signal: new AbortController().signal, callId: "call-1", agent: { session: { header: { cwd: "D:\\ws" } } } };

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`ok - ${label}`);
  else {
    failures++;
    console.error(`FAIL - ${label}`);
  }
}
async function throwsWith(promise, needle, label) {
  try {
    await promise;
    check(false, `${label} (did not throw)`);
  } catch (error) {
    check(String(error.message ?? error).includes(needle), `${label} (${error.message ?? error})`);
  }
}

delete process.env.DSH_MINERU_PARSE_SCRIPT;

// 1. plugin shape and registration
check(name === "mineru-parse-tool", "plugin name");
check(inject.join(",") === "tools,shell,fs", "inject list has no skill dependency");
apply(makeCtx("", { sandbox: false }));
check(registered.length === 1, "one tool registered");
const def = registered[0];
check(def.name === "parse_docs", "tool name parse_docs");
check(
  def.parameters?.type === "object" &&
    Array.isArray(def.parameters?.required) &&
    def.parameters.required.includes("paths"),
  "parameters require paths",
);
check(
  def.parameters?.properties?.sandbox_permissions?.enum?.includes("danger-full-access") &&
    def.parameters?.properties?.justification !== undefined,
  "escalation parameters declared",
);
check(def.output?.schema?.type === "object" && typeof def.output?.render === "function", "output schema + render present");
check(typeof def.execute === "function", "execute is a function");

// 2. happy path: RESULT marker (no sandboxing deployment)
const okCtx = makeCtx(
  "PAGES\t5\tBACKEND=pipeline\nRESULT\tD:\\a.pdf\tD:\\ws\\.mineru-output\\a\\auto\\a.md\t2048\t40\nDONE\tparsed=1\tcached=0",
  { sandbox: false },
);
const r1 = await toolDefinition(okCtx).execute({ paths: ["D:\\a.pdf"] }, exec);
check(r1.ok === true, "result ok");
check(r1.parsed === 1 && r1.cached === 0, "parsed/cached counts");
check(r1.files.length === 1, "one file entry");
check(r1.files[0].source === "D:\\a.pdf", "file source");
check(r1.files[0].markdownPath === "D:\\ws\\.mineru-output\\a\\auto\\a.md", "markdown path");
check(r1.files[0].content.includes("fake markdown"), "content read");
const rendered = def.output.render({}, r1);
check(Array.isArray(rendered) && rendered[0]?.type === "text" && rendered[0].text.includes("## D:\\a.pdf"), "render produces text blocks");

// 3. cached hit produces a file entry too
const cachedCtx = makeCtx("CACHED\tD:\\a.pdf\tD:\\ws\\.mineru-output\\a\\auto\\a.md\nDONE\tparsed=0\tcached=1", { sandbox: false });
const r2 = await toolDefinition(cachedCtx).execute({ paths: ["D:\\a.pdf"] }, exec);
check(r2.ok === true && r2.parsed === 0 && r2.cached === 1 && r2.files.length === 1, "cached hit produces file entry");

// 4. MINERU_UNAVAILABLE surfaces as an error
const badCtx = makeCtx("MINERU_UNAVAILABLE", { sandbox: false });
const r3 = await toolDefinition(badCtx).execute({ paths: ["D:\\a.pdf"] }, exec);
check(r3.ok === false && r3.errors.length > 0, "mineru unavailable reported");

// 5. NO_SUPPORTED_FILES surfaces with a hint
const nsCtx = makeCtx("NO_SUPPORTED_FILES", { sandbox: false });
const r4 = await toolDefinition(nsCtx).execute({ paths: ["D:\\a.txt"] }, exec);
check(r4.ok === false && r4.errors[0].includes("no supported files"), "no supported files reported");

// 6. invalid args throw
await throwsWith(toolDefinition(okCtx).execute({ paths: [] }, exec), "non-empty array", "empty paths throws");

// 7. bundled parse.ps1 is used with no skill package present (self-contained)
const noSkillsCtx = makeCtx("RESULT\tD:\\a.pdf\tD:\\ws\\.mineru-output\\a\\auto\\a.md\t2048\t40\nDONE\tparsed=1\tcached=0", {
  sandbox: false,
});
const r5 = await toolDefinition(noSkillsCtx).execute({ paths: ["D:\\a.pdf"] }, exec);
const cmd5 = noSkillsCtx.lastRequest()?.command ?? "";
check(r5.ok === true, "parse succeeds without any skill");
check(cmd5.includes("assets") && cmd5.includes("scripts") && cmd5.includes("parse.ps1"), "command uses the bundled assets/scripts/parse.ps1");

// 8. DSH_MINERU_PARSE_SCRIPT override wins over the bundled script
process.env.DSH_MINERU_PARSE_SCRIPT = "D:\\custom\\parse.ps1";
const envCtx = makeCtx("RESULT\tD:\\a.pdf\tD:\\out\\a.md\t1024\t20\nDONE\tparsed=1\tcached=0", { sandbox: false });
const r6 = await toolDefinition(envCtx).execute({ paths: ["D:\\a.pdf"] }, exec);
const cmd6 = envCtx.lastRequest()?.command ?? "";
check(
  r6.ok === true && r6.files[0].markdownPath === "D:\\out\\a.md" && cmd6.includes("D:\\custom\\parse.ps1"),
  "env script override used",
);
delete process.env.DSH_MINERU_PARSE_SCRIPT;

// 9. fail fast: PDF-family under a confined workspace-write session
const confinedCtx = makeCtx("", { policyMode: "workspace-write" });
const r7 = await toolDefinition(confinedCtx).execute({ paths: ["D:\\a.pdf"] }, exec);
check(
  r7.ok === false && r7.errors[0].includes("escalation available") && r7.errors[0].includes("sandbox_permissions"),
  "fail-fast under confined mode with escalation hint",
);

// 10. image-only input is attempted even when confined
const imgCtx = makeCtx("RESULT\tD:\\a.png\tD:\\ws\\.mineru-output\\a\\auto\\a.md\t1024\t20\nDONE\tparsed=1\tcached=0", {
  policyMode: "workspace-write",
});
const r8 = await toolDefinition(imgCtx).execute({ paths: ["D:\\a.png"] }, exec);
check(r8.ok === true && r8.files.length === 1, "image-only parse attempted under confinement");

// 11. escalation: allowed-once stamps the granted mode onto the shell request
const escCtx = makeCtx(
  "RESULT\tD:\\a.pdf\tD:\\ws\\.mineru-output\\a\\auto\\a.md\t2048\t40\nDONE\tparsed=1\tcached=0",
  { policyMode: "workspace-write", approvalOutcome: "allowed-once" },
);
const r9 = await toolDefinition(escCtx).execute(
  { paths: ["D:\\a.pdf"], sandbox_permissions: "danger-full-access", justification: "MinerU needs unconfined multiprocessing" },
  exec,
);
check(r9.ok === true, "escalated parse succeeds");
check(escCtx.lastRequest()?.sandboxPolicy?.mode === "danger-full-access", "granted mode stamped on shell request");

// 12. escalation rejected throws
const rejCtx = makeCtx("", { policyMode: "workspace-write", approvalOutcome: "rejected" });
await throwsWith(
  toolDefinition(rejCtx).execute(
    { paths: ["D:\\a.pdf"], sandbox_permissions: "danger-full-access", justification: "need it" },
    exec,
  ),
  "user rejected",
  "escalation rejection surfaces",
);

// 13. non-widening request throws without prompting
const nwCtx = makeCtx("", { policyMode: "workspace-write", approvalOutcome: "allowed-once" });
await throwsWith(
  toolDefinition(nwCtx).execute(
    { paths: ["D:\\a.pdf"], sandbox_permissions: "workspace-write", justification: "same mode" },
    exec,
  ),
  "not strictly wider",
  "non-widening escalation rejected",
);

// 14. escalation argument pairing validation
await throwsWith(
  toolDefinition(okCtx).execute({ paths: ["D:\\a.pdf"], sandbox_permissions: "danger-full-access" }, exec),
  "requires a justification",
  "sandbox_permissions without justification rejected",
);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("SMOKE OK");
