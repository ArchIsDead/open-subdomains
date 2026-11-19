"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

const { checked, section, REQUIRED_CHECKBOXES } = require(path.join(SCRIPTS, "template.js"));

function body(overrides = {}) {
  const boxes = REQUIRED_CHECKBOXES.map(([marker]) => (overrides.skip || []).includes(marker) ? `- [ ] <!-- ${marker} --> not done` : `- [x] <!-- ${marker} --> done`);
  const preview = "preview" in overrides ? overrides.preview : "https://jane.github.io";
  const purpose = "purpose" in overrides ? overrides.purpose : "Portfolio";
  return [
    "# Requirements",
    ...boxes,
    "",
    "# Website Preview",
    "<!-- WEBSITE_PREVIEW_START -->",
    preview,
    "<!-- WEBSITE_PREVIEW_END -->",
    "",
    "# Purpose",
    "<!-- WEBSITE_PURPOSE_START -->",
    purpose,
    "<!-- WEBSITE_PURPOSE_END -->",
  ].join("\n");
}

function makeRepo(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const name of fs.readdirSync(SCRIPTS)) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  }
  fs.mkdirSync(path.join(dir, "registry"));
  fs.writeFileSync(path.join(dir, "registry", "zones.json"), JSON.stringify(["is-a.ceo"]));
  fs.writeFileSync(path.join(dir, "registry", "reserved.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, "registry", "blocked.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, "registry", "trusted.json"), JSON.stringify(options.trusted || [{ username: "maintainer", id: 555 }]));
  fs.mkdirSync(path.join(dir, ".github"));
  fs.copyFileSync(path.join(REPO, ".github", "pull_request_template.md"), path.join(dir, ".github", "pull_request_template.md"));
  return dir;
}

function run(dir, env) {
  // CI exports PR_* and friends for the validator; the suite must not inherit
  // them or the bypass labels leak into every spawned template check.
  const cleanEnv = { ...process.env };
  for (const key of ["PR_BODY", "PR_LABELS", "PR_AUTHOR", "PR_AUTHOR_ID", "CHANGED_FILES", "DELETED_FILES", "GITHUB_BASE_REF"]) {
    delete cleanEnv[key];
  }
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "template.js")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...cleanEnv, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function passes(prBody, env = {}) {
  const dir = makeRepo();
  const result = run(dir, { PR_BODY: prBody, ...env });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 0, `expected a pass, got exit ${result.code}:\n${result.out}`);
  return result;
}

function fails(prBody, pattern, env = {}) {
  const dir = makeRepo();
  const result = run(dir, { PR_BODY: prBody, ...env });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 1, `expected a rejection, got exit 0:\n${result.out}`);
  if (pattern) assert.match(result.out, pattern);
  return result;
}

test("a fully filled template passes", () => {
  passes(body());
});

test("an unticked checkbox is named", () => {
  fails(body({ skip: ["FINISHED"] }), /FINISHED/);
});

test("an empty website preview is refused", () => {
  fails(body({ preview: "" }), /Website Preview section is empty/);
});

test("an empty purpose is refused", () => {
  fails(body({ purpose: "" }), /Purpose section is empty/);
});

test("an empty body is refused", () => {
  fails("", /TOS/);
});

test("a trusted author skips the body check", () => {
  const result = passes("", { PR_AUTHOR: "maintainer", PR_AUTHOR_ID: "555" });
  assert.match(result.out, /trusted/);
});

test("the maintainer label skips the body check", () => {
  const result = passes("", { PR_LABELS: '["maintainer"]' });
  assert.match(result.out, /not checked/);
});

test("the template-check bypass label skips the body check", () => {
  const result = passes("", { PR_LABELS: '["ci: bypass-template-check"]' });
  assert.match(result.out, /not checked/);
});

test("an unrelated label does not skip the body check", () => {
  fails("", /TOS/, { PR_LABELS: '["subdomain"]' });
});

test("a plain newline-separated label list is understood", () => {
  const result = passes("", { PR_LABELS: "subdomain\nmaintainer" });
  assert.match(result.out, /not checked/);
});

test("the checkbox marker is read from the comment, not the label text", () => {
  assert.equal(checked("- [x] <!-- TOS --> I agree", "TOS"), true);
  assert.equal(checked("- [ ] <!-- TOS --> I agree", "TOS"), false);
  assert.equal(checked("- [X] <!-- TOS --> I agree", "TOS"), true);
  assert.equal(checked("- [x] I agree to the terms", "TOS"), false);
});

test("a section is read between its markers", () => {
  const text = "<!-- A_START -->\nhello\n<!-- A_END -->";
  assert.equal(section(text, "<!-- A_START -->", "<!-- A_END -->"), "hello");
  assert.equal(section(text, "<!-- B_START -->", "<!-- B_END -->"), "");
});

test("the shipped template carries every marker the checker wants", () => {
  const template = fs.readFileSync(path.join(REPO, ".github", "pull_request_template.md"), "utf8");
  for (const [marker] of REQUIRED_CHECKBOXES) {
    assert.ok(template.includes(`<!-- ${marker} -->`), `the template is missing the ${marker} marker`);
  }
  assert.ok(template.includes("<!-- WEBSITE_PREVIEW_START -->"));
  assert.ok(template.includes("<!-- WEBSITE_PURPOSE_END -->"));
});
