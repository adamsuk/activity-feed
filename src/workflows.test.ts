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

test("the deploy runs on push to main only", () => {
  const on = triggers(read("deploy.yml"));
  assert.equal(on.trim(), "push:\n    branches:\n      - main");
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
