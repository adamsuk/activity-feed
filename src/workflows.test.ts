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
