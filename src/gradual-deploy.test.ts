import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs scripts/gradual-deploy.sh against a stub `npx` that records the wrangler command line,
// so the rollback path is exercised without Cloudflare. The script calls wrangler through
// `npx --yes wrangler@<version> ...`.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "gradual-deploy.sh");
const STABLE = "11111111-2222-3333-4444-555555555555";
const NEW = "66666666-7777-8888-9999-000000000000";

function run(command: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gradual-deploy-"));
  try {
    const bin = join(dir, "bin");
    const state = join(dir, "state", "gradual-deploy");
    mkdirSync(bin);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "stable"), STABLE);
    writeFileSync(join(state, "new"), NEW);
    const log = join(dir, "wrangler.log");
    writeFileSync(join(bin, "npx"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const result = spawnSync("bash", [SCRIPT, command], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: join(dir, "state"),
        WRANGLER_VERSION: "0.0.0",
        WORKER_NAME: "stub-worker",
        GITHUB_SHA: "abc123",
        ...extraEnv,
      },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      // wrangler was never called
    }
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rollback puts the stable version back at 100% and exits non-zero", () => {
  const { status, calls, stderr } = run("rollback");
  assert.notEqual(status, 0, "rollback must fail the run so the breach is visible");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`versions deploy ${STABLE}@100`), `unexpected wrangler call: ${calls[0]}`);
  assert.ok(calls[0].includes("--name stub-worker"));
  assert.ok(!calls[0].includes(NEW), "the new version must not be redeployed");
  assert.match(stderr, /Rolled back to /);
});

test("rollback refuses a stable id that is not a UUID and calls nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gradual-deploy-"));
  try {
    const state = join(dir, "gradual-deploy");
    mkdirSync(state);
    writeFileSync(join(state, "stable"), "$(touch pwned)");
    const result = spawnSync("bash", [SCRIPT, "rollback"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: dir, WRANGLER_VERSION: "0.0.0", WORKER_NAME: "w" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bad stable version id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forced guardrail failure exits non-zero before any probe", () => {
  const { status, stderr, calls } = run("guardrail", {
    GUARDRAIL_FORCE_FAIL: "true",
    GUARDRAIL_REQUESTS: "20",
    GUARDRAIL_INTERVAL_SECONDS: "3",
    GUARDRAIL_MAX_ERROR_PERCENT: "10",
    WORKER_URL: "http://127.0.0.1:9/",
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /forced to fail/);
  assert.deepEqual(calls, []);
});
