#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const R = require("./registry.js");

const BODY_FILE = process.env.PR_BODY_FILE || "";
const BODY_ENV = process.env.PR_BODY;
const BODY_PATH = path.join(R.ROOT, ".github", "pull_request_template.md");
const BYPASS_LABELS = ["maintainer", "ci: bypass-template-check"];

const REQUIRED_CHECKBOXES = [
  ["TOS", "agree to the Terms of Service"],
  ["OWNER", "owner names me"],
  ["FINISHED", "the site is reachable and finished"],
  ["NON_COMMERCIAL", "personal or non-commercial use"],
  ["VERIFY", "npm run verify passes locally"],
];

function body() {
  if (BODY_FILE) {
    if (!fs.existsSync(BODY_FILE)) R.fail(`${BODY_FILE} does not exist`);
    return fs.readFileSync(BODY_FILE, "utf8");
  }
  if (BODY_ENV !== undefined) return BODY_ENV;
  return "";
}

function labels() {
  const raw = process.env.PR_LABELS || "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((label) => String(label).trim());
  } catch {
    // gh prints a plain list in some versions.
  }
  return raw
    .replace(/[[\]"']/g, "")
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

function isTrustedAuthor() {
  const id = Number(process.env.PR_AUTHOR_ID);
  const username = String(process.env.PR_AUTHOR || "").trim().toLowerCase();
  if (!Number.isInteger(id) && !username) return false;
  try {
    const policy = R.loadPolicy();
    return Boolean(
      R.trustedBy(policy, { id: Number.isInteger(id) ? id : null, username }),
    );
  } catch {
    return false;
  }
}

function checked(text, marker) {
  return new RegExp(`-\\s*\\[[xX]\\]\\s*<!--\\s*${marker}\\s*-->`, "i").test(text);
}

function section(text, start, end) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escape(start)}([\\s\\S]*?)${escape(end)}`, "i"));
  return match ? match[1].trim() : "";
}

function check(text) {
  const problems = [];

  for (const [marker, phrase] of REQUIRED_CHECKBOXES) {
    if (!checked(text, marker)) problems.push(`the \`${marker}\` checkbox is not ticked (${phrase})`);
  }

  if (!section(text, "<!-- WEBSITE_PREVIEW_START -->", "<!-- WEBSITE_PREVIEW_END -->")) {
    problems.push("the Website Preview section is empty; a link to where the site lives today is required");
  }

  if (!section(text, "<!-- WEBSITE_PURPOSE_START -->", "<!-- WEBSITE_PURPOSE_END -->")) {
    problems.push("the Purpose section is empty; one line about what the name is for is required");
  }

  return problems;
}

function main() {
  const labelSet = labels();

  if (isTrustedAuthor()) {
    console.log("template: this author is trusted, so the pull request body is not checked");
    return;
  }

  const bypass = BYPASS_LABELS.find((label) => labelSet.includes(label));
  if (bypass) {
    console.log(`template: "${bypass}" is set, so the pull request body is not checked`);
    return;
  }

  if (!fs.existsSync(BODY_PATH)) {
    R.fail(".github/pull_request_template.md is missing, so there is nothing to check against");
  }

  const problems = check(body());
  if (problems.length === 0) {
    console.log("template: the pull request body satisfies the template");
    return;
  }

  console.error("template: the pull request body is missing something");
  console.error("");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  console.error("Tick every box in the template and fill in both marked sections, then edit the description.");
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`template: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { check, checked, section, REQUIRED_CHECKBOXES, BYPASS_LABELS };
