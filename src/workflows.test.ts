import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The tests must run on pull requests without being able to deploy, and the deploy must
// stay on push to main with the only use of the Cloudflare credential. These read the
// workflow files as text: the repo has no YAML parser and should not gain one for this.

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const TEST_COMMAND = "node --experimental-strip-types --test src/*.test.ts";

function read(name: string): string {
  return readFileSync(join(WORKFLOWS, name), "utf8");
}

// The top-level `on:` block, up to the next top-level key.
function triggers(workflow: string): string {
  const match = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(workflow);
  assert.ok(match, "workflow has no top-level on: block");
  return match[1];
}

test("pull requests and pushes to main run the worker tests", () => {
  const workflow = read("test.yml");
  const on = triggers(workflow);
  assert.match(on, /^  pull_request:/m);
  assert.match(on, /^  push:\n    branches:\n      - main$/m);
  assert.ok(workflow.includes(`run: ${TEST_COMMAND}`));
});

test("the test workflow has a read-only token and cannot deploy", () => {
  const workflow = read("test.yml");
  assert.match(workflow, /^permissions:\n  contents: read\n\n/m);
  // One permissions block only: a job-level block could widen the token again.
  assert.equal(workflow.match(/^\s*permissions:/gm)?.length, 1, "test.yml must have only the top-level permissions block");
  assert.equal(workflow.match(/:\s*write\b|write-all/g), null, "no write permission anywhere in test.yml");
  // Both context forms: secrets.NAME and secrets['NAME'].
  assert.equal(workflow.match(/\bsecrets\s*[.[]/g), null, "test.yml must not read a secret");
  assert.ok(!workflow.includes("wrangler"), "test.yml must not deploy");
  assert.ok(!workflow.includes("environment:"), "test.yml must not use a deployment environment");
});

test("the deploy runs on push to main, plus a manual run whose only input is the default-off forced failure", () => {
  const on = triggers(read("deploy.yml"));
  assert.match(on, /^  push:\n    branches:\n      - main\n/);
  assert.match(on, /^  workflow_dispatch:\n    inputs:\n      force_guardrail_failure:\n(?:        .*\n)*$/m);
  // Exactly one input, and it defaults to false.
  assert.equal(on.match(/^      \S.*:$/gm)?.length, 1, "force_guardrail_failure must be the only input");
  assert.match(on, /^        type: boolean$/m);
  assert.match(on, /^        default: false$/m);
  assert.ok(!/pull_request|schedule/.test(on), "no other trigger");
});

test("deploy.yml is the only workflow that uses the Cloudflare credential", () => {
  const users = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => read(name).includes("CF_API_TOKEN"));
  assert.deepEqual(users, ["deploy.yml"]);
});

test("deploy.yml has a read-only token and nothing wider", () => {
  const workflow = read("deploy.yml");
  assert.match(workflow, /^permissions:\n  contents: read\n\n/m);
  assert.equal(workflow.match(/^\s*permissions:/gm)?.length, 1, "deploy.yml must have only the top-level permissions block");
  assert.equal(workflow.match(/:\s*write\b|write-all/g), null, "no write permission anywhere in deploy.yml");
});

test("every action in every workflow is pinned to a 40-character commit SHA", () => {
  const unpinned: string[] = [];
  for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
    read(name).split("\n").forEach((line, index) => {
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
      if (!match) return;
      const ref = match[1].replace(/^["']|["']$/g, "");
      // Local actions (./path) have no ref to pin.
      if (ref.startsWith("./")) return;
      if (!/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${name}:${index + 1} ${ref}`);
    });
  }
  assert.deepEqual(unpinned, []);
});

// Build once, deploy that bundle. Job bodies are cut out of the file as text.
function job(workflow: string, name: string): string {
  const match = new RegExp(`^  ${name}:\\n((?:(?: {4}.*)?\\n)*)`, "m").exec(workflow);
  assert.ok(match, `deploy.yml has no ${name} job`);
  return match[1];
}

test("the build job exists, runs the tests and references no secret or environment", () => {
  const build = job(read("deploy.yml"), "build");
  assert.ok(build.includes(`run: ${TEST_COMMAND}`));
  assert.ok(build.includes("--dry-run --outdir dist"));
  assert.equal(build.match(/\bsecrets\s*[.[]/g), null, "build must not read a secret");
  assert.ok(!build.includes("CF_API_TOKEN"));
  assert.ok(!/^\s*environment:/m.test(build), "build must not use a deployment environment");
  assert.match(build, /sha256sum/);
  assert.match(build, /^\s*digest: \$\{\{ steps\.\w+\.outputs\.sha256 \}\}$/m);
  assert.match(build, /uses: actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(build, /name: worker-bundle-\$\{\{ github\.sha \}\}/);
});

test("the deploy job needs build, runs in production and publishes the verified artifact", () => {
  const deploy = job(read("deploy.yml"), "deploy");
  assert.match(deploy, /^    needs: build$/m);
  assert.match(deploy, /^    environment: production$/m);
  assert.match(deploy, /^      group: production$/m);
  assert.match(deploy, /uses: actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(deploy, /name: worker-bundle-\$\{\{ github\.sha \}\}/);
  assert.match(deploy, /\$\{\{ needs\.build\.outputs\.digest \}\}/);
  assert.match(deploy, /sha256sum --check/);
  assert.match(deploy, /wrangler@\$\{WRANGLER_VERSION\}" deploy --no-bundle bundle\/index\.js/);
});

test("the deploy job installs, tests and builds nothing from the project", () => {
  const deploy = job(read("deploy.yml"), "deploy");
  assert.equal(deploy.match(/\bnpm (ci|install|i|run|test)\b/g), null, "no project install, run or test");
  assert.ok(!deploy.includes("--test"), "no test step");
  assert.ok(!deploy.includes("--dry-run"), "no build step");
  assert.ok(!deploy.includes("--outdir"), "no build step");
  assert.ok(!deploy.includes("cloudflare/wrangler-action"), "deploys the prebuilt bundle with a pinned wrangler");
  // Every deploy must be of the downloaded bundle, never of the source tree.
  for (const line of deploy.split("\n").filter((l) => /wrangler@/.test(l))) {
    assert.ok(line.includes("--no-bundle bundle/index.js"), `unexpected wrangler call: ${line.trim()}`);
  }
});

test("only the deploy job references the Cloudflare credential", () => {
  const workflow = read("deploy.yml");
  assert.equal(job(workflow, "build").match(/CF_API_TOKEN/g), null);
  assert.equal(job(workflow, "deploy").match(/secrets\.CF_API_TOKEN/g)?.length, 1);
  // Nothing outside the two jobs (workflow-level env, for one) may name it.
  const outside = workflow.replace(job(workflow, "deploy"), "");
  assert.ok(!outside.includes("CF_API_TOKEN"), "CF_API_TOKEN outside the deploy job");
});

test("wrangler is pinned to an exact release and re-runs may replace the artifact", () => {
  const workflow = read("deploy.yml");
  assert.match(workflow, /^  WRANGLER_VERSION: "4\.\d+\.\d+"$/m);
  assert.match(job(workflow, "build"), /^\s*overwrite: true$/m);
});

// Gradual deploy: canary, guardrail, rollback, promote.
function stepIndex(deploy: string, name: string): number {
  const index = deploy.indexOf(`- name: ${name}`);
  assert.ok(index >= 0, `deploy job has no step named ${name}`);
  return index;
}

test("the canary percentage is set to a partial rollout", () => {
  const match = /^  CANARY_PERCENT: "(\d+)"$/m.exec(read("deploy.yml"));
  assert.ok(match, "CANARY_PERCENT is not set in the workflow env");
  const percent = Number(match[1]);
  assert.ok(percent >= 1 && percent <= 99, `canary percent ${percent} is not in 1..99`);
});

test("the guardrail, rollback and promote steps run in that order", () => {
  const deploy = job(read("deploy.yml"), "deploy");
  const canary = stepIndex(deploy, "Canary, shift CANARY_PERCENT of traffic to the new version");
  const guardrail = stepIndex(deploy, '"Guardrail: canary health"');
  const rollback = stepIndex(deploy, "Rollback to the stable version");
  const promote = stepIndex(deploy, "Promote the prebuilt bundle to 100 percent");
  assert.ok(canary < guardrail && guardrail < rollback && rollback < promote);
  assert.match(deploy, /id: guardrail/);
  assert.match(deploy.slice(rollback, promote), /if: .*steps\.guardrail\.outcome != 'success'/);
  assert.match(deploy.slice(rollback, promote), /always\(\)/);
  assert.match(deploy.slice(rollback, promote), /gradual-deploy\.sh rollback/);
  assert.match(deploy.slice(promote), /deploy --no-bundle bundle\/index\.js/);
});

test("the Cloudflare credential reaches only the steps that call Cloudflare", () => {
  const deploy = job(read("deploy.yml"), "deploy");
  const steps = deploy.split(/^      - /m).slice(1);
  const withToken = steps.filter((step) => /CLOUDFLARE_API_TOKEN|\*cloudflare/.test(step)).map((step) => /name: (.*)/.exec(step)?.[1] ?? "");
  assert.equal(withToken.length, 4);
  assert.ok(!withToken.some((name) => name.includes("Guardrail")), "the guardrail must not get the credential");
  for (const step of steps.filter((s) => /uses:/.test(s))) assert.ok(!/CLOUDFLARE_API_TOKEN|\*cloudflare/.test(step));
});

test("the rollback script restores the stable version at 100 and validates ids", () => {
  const script = readFileSync(join(WORKFLOWS, "..", "..", "scripts", "gradual-deploy.sh"), "utf8");
  assert.match(script, /versions deploy "\$\{stable\}@100"/);
  assert.match(script, /Cloudflare-Workers-Version-Overrides/);
  assert.match(script, /\[0-9a-f\]\{8\}-/);
  assert.ok(!/\beval\b/.test(script));
});

test("the worker name in the workflow matches wrangler.toml", () => {
  const toml = readFileSync(join(WORKFLOWS, "..", "..", "wrangler.toml"), "utf8");
  const name = /^name = "([^"]+)"/m.exec(toml)?.[1];
  assert.match(read("deploy.yml"), new RegExp(`^  WORKER_NAME: ${name}$`, "m"));
});

test("progressive-release.md names the Cloudflare settings and the line Pages statement", () => {
  const root = join(WORKFLOWS, "..", "..");
  const doc = readFileSync(join(root, "docs", "progressive-release.md"), "utf8");
  assert.match(doc, /Workers Scripts: Edit/);
  assert.match(doc, /CANARY_PERCENT/);
  assert.match(doc, /line repo's Cloudflare Pages deploy stays `deploy=release` under the human gate/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /\(docs\/progressive-release\.md\)/);
});

test("the rollback also covers a canary step that failed after splitting traffic", () => {
  const deploy = job(read("deploy.yml"), "deploy");
  const rollback = stepIndex(deploy, "Rollback to the stable version");
  const promote = stepIndex(deploy, "Promote the prebuilt bundle to 100 percent");
  const step = deploy.slice(rollback, promote);
  assert.match(step, /steps\.canary\.outcome != 'skipped'/);
  assert.doesNotMatch(step, /steps\.canary\.outcome == 'success'/);
});

test("the deploy job blocks egress to the allowlisted hosts", () => {
  const workflow = read("deploy.yml");
  const deploy = job(workflow, "deploy");
  assert.match(deploy, /^\s+egress-policy: block$/m);
  assert.ok(!/egress-policy: audit/.test(deploy), "deploy must not audit only");
  assert.match(deploy, /allowed-endpoints:/);
});

test("the forced guardrail failure is wired from the dispatch input to the guardrail step only", () => {
  const deploy = job(read("deploy.yml"), "deploy");
  const guardrail = deploy.indexOf('"Guardrail: canary health"');
  const rollback = deploy.indexOf("Rollback to the stable version");
  assert.ok(guardrail >= 0 && guardrail < rollback);
  assert.match(
    deploy.slice(guardrail, rollback),
    /GUARDRAIL_FORCE_FAIL: \$\{\{ inputs\.force_guardrail_failure && 'true' \|\| 'false' \}\}/,
  );
  assert.equal(deploy.match(/GUARDRAIL_FORCE_FAIL/g)?.length, 1, "wired on the guardrail step only");
  // Off by default: nothing else reads the input, so a push cannot turn it on.
  assert.equal(read("deploy.yml").match(/inputs\.force_guardrail_failure/g)?.length, 1);
});

test("no Harden-Runner step is left in audit and every block names its allowed endpoints", () => {
  for (const file of ["codeql.yml", "deploy.yml", "test.yml"]) {
    const workflow = read(file);
    assert.ok(!/egress-policy: audit/.test(workflow), `${file} must not audit`);
    const steps = workflow.match(/step-security\/harden-runner@[\s\S]*?(?=\n      - uses:|\n      - name:|$)/g) ?? [];
    assert.ok(steps.length > 0, `${file} has a Harden-Runner step`);
    for (const step of steps) {
      assert.match(step, /egress-policy: block/, file);
      assert.match(step, /allowed-endpoints:/, file);
      assert.ok(!/\*/.test(step.replace(/^\s*#.*$/gm, "")), `${file} allowlist has no wildcard`);
    }
  }
});
