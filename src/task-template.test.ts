import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MARKER = "# factory-managed: maintained by https://github.com/adamsuk/gh-factory. Remove this line to take ownership.";

const PROBLEM = {
  type: "textarea",
  id: "problem",
  attributes: {
    label: "Problem",
    description: "What is wrong or missing, and who it affects.",
  },
  validations: { required: true },
};

const PROPOSAL = {
  type: "textarea",
  id: "proposal",
  attributes: {
    label: "Proposal",
    description: "What should change. Leave room for the implementer to choose how.",
  },
  validations: { required: false },
};

const CONTEXT = {
  type: "textarea",
  id: "context",
  attributes: {
    label: "Context",
    description: "Links, screenshots, logs.",
  },
  validations: { required: false },
};

test("live task form prefills one target repo above problem", () => {
  const taskPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "ISSUE_TEMPLATE", "task.yml");
  const text = readFileSync(taskPath, "utf8");
  assert.equal(text.split(/\r?\n/)[0], MARKER);

  const form = parseYaml(text);
  assert.ok(Array.isArray(form.body));
  const body = form.body;
  const problemAt = body.findIndex((item) => isRecord(item) && item.id === "problem");
  assert.ok(problemAt > 0, "a target textarea must sit directly above problem");

  const target = body[problemAt - 1];
  assert.ok(isRecord(target));
  assert.equal(target.type, "textarea");
  assert.equal(target.id, "target");
  assert.ok(isRecord(target.attributes));
  assert.equal(target.attributes.label, "Target repository");
  assert.equal(
    target.attributes.description,
    "The one repository this change lands in. Replace owner/repo and leave a single line.",
  );
  assert.ok(isRecord(target.validations));
  assert.equal(target.validations.required, true);
  assert.equal(typeof target.attributes.value, "string");
  // A trailing newline from a YAML block scalar is fine; a second line is not.
  assert.deepEqual(splitLines(target.attributes.value), ["Target repo: owner/repo"]);

  assert.deepEqual(body[problemAt], PROBLEM);
  const byId = new Map(body.filter(isRecord).map((item) => [item.id, item]));
  assert.deepEqual(byId.get("proposal"), PROPOSAL);
  assert.deepEqual(byId.get("context"), CONTEXT);
  const acceptance = byId.get("acceptance");
  assert.ok(isRecord(acceptance));
  assert.ok(isRecord(acceptance.validations));
  assert.equal(acceptance.validations.required, true);
});

type Yaml = string | boolean | null | Yaml[] | { [key: string]: Yaml };

function isRecord(value: unknown): value is { [key: string]: Yaml } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Line breaks only. A final break does not become an extra blank line.
function splitLines(value: string): string[] {
  const lines = value.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && /(?:\r\n|\n|\r)$/.test(value)) lines.pop();
  return lines;
}

function scalar(raw: string): Yaml {
  if (raw === "true" || raw === "True" || raw === "TRUE") return true;
  if (raw === "false" || raw === "False" || raw === "FALSE") return false;
  if (raw === "null" || raw === "Null" || raw === "NULL" || raw === "~") return null;
  if (
    (raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// Subset of YAML used by the GitHub task form: maps, lists, plain scalars, and block scalars.
class Parser {
  lines: string[];
  i = 0;

  constructor(text: string) {
    this.lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  }

  eof(): boolean {
    return this.i >= this.lines.length;
  }

  line(): string {
    return this.lines[this.i] ?? "";
  }

  skip(): void {
    while (!this.eof()) {
      const line = this.line();
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        this.i += 1;
        continue;
      }
      return;
    }
  }

  indentOf(line: string): number {
    let n = 0;
    while (line[n] === " ") n += 1;
    return n;
  }

  assign(map: { [key: string]: Yaml }, key: string, after: string, keyIndent: number): void {
    if (after === "|" || after === "|-" || after === "|+") {
      map[key] = this.block(keyIndent, after);
      return;
    }
    if (after !== "") {
      map[key] = scalar(after);
      return;
    }
    this.skip();
    if (this.eof() || this.indentOf(this.line()) <= keyIndent) {
      map[key] = null;
      return;
    }
    const ind = this.indentOf(this.line());
    map[key] = this.line().slice(ind).startsWith("- ") ? this.sequence(ind) : this.mapping(ind);
  }

  block(parentIndent: number, style: string): string {
    const content: string[] = [];
    let blockIndent: number | null = null;
    while (!this.eof()) {
      const line = this.line();
      if (line.trim() === "") {
        content.push("");
        this.i += 1;
        continue;
      }
      const ind = this.indentOf(line);
      if (blockIndent === null) {
        if (ind <= parentIndent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      content.push(line.slice(blockIndent));
      this.i += 1;
    }
    if (!style.endsWith("+")) {
      while (content.length > 0 && content[content.length - 1] === "") content.pop();
    }
    if (content.length === 0) return "";
    const body = content.join("\n");
    return style.endsWith("-") ? body : `${body}\n`;
  }

  sequence(indent: number): Yaml[] {
    const items: Yaml[] = [];
    while (!this.eof()) {
      this.skip();
      if (this.eof()) break;
      const line = this.line();
      const ind = this.indentOf(line);
      if (ind !== indent) break;
      const content = line.slice(ind);
      if (!content.startsWith("- ")) break;
      this.i += 1;
      const rest = content.slice(2);
      const colon = rest.indexOf(":");
      if (colon <= 0) {
        items.push(scalar(rest));
        continue;
      }
      const item: { [key: string]: Yaml } = {};
      this.assign(item, rest.slice(0, colon).trim(), rest.slice(colon + 1).trim(), ind + 2);
      Object.assign(item, this.mapping(ind + 2));
      items.push(item);
    }
    return items;
  }

  mapping(indent: number): { [key: string]: Yaml } {
    const map: { [key: string]: Yaml } = {};
    while (!this.eof()) {
      this.skip();
      if (this.eof()) break;
      const line = this.line();
      const ind = this.indentOf(line);
      if (ind !== indent || line.slice(ind).startsWith("- ")) break;
      const content = line.slice(ind);
      const colon = content.indexOf(":");
      if (colon <= 0) throw new Error(`expected a key on line ${this.i + 1}`);
      const key = content.slice(0, colon).trim();
      const after = content.slice(colon + 1).trim();
      this.i += 1;
      this.assign(map, key, after, ind);
    }
    return map;
  }
}

function parseYaml(text: string): { [key: string]: Yaml } {
  const parser = new Parser(text);
  parser.skip();
  if (parser.eof()) return {};
  return parser.mapping(parser.indentOf(parser.line()));
}
