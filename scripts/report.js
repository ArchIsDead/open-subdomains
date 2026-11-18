#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const R = require("./registry.js");

const MARKER = "<!-- registry-validator -->";
const MAX_PER_FILE = 12;

const HINTS = [
  { test: /is blocked by the registry/, hint: "This label is on registry/blocked.json. It is refused under every zone, so pick another one." },
  { test: /is reserved, so the registry already answers/, hint: "The registry serves this name itself. Pick a personal handle instead." },
  { test: /"owner" needs "username" or "email"/, hint: 'Add "username" (your GitHub handle) or "email" (an address a maintainer can reach). "id" is optional.' },
  { test: /owner\.username is empty|owner\.email is empty/, hint: "The key is there but blank. Fill it in or remove the key." },
  { test: /owner\.username .* is not a GitHub handle/, hint: "A handle is letters, digits and single hyphens, up to 39 characters." },
  { test: /owner\.email must be a valid address/, hint: "Write a full address, for example you@example.com." },
  { test: /owner\.id must be/, hint: "The id is the number from https://api.github.com/users/<you>. Leave it out if you are not sure." },
  { test: /is not the account opening this pull request/, hint: "A claim belongs to the account that opens it. Check that the username and id in your entry are yours." },
  { test: /needs .* claimed by the same owner first/, hint: "A wildcard or an underscore name has to sit on top of a name you already hold in the same zone." },
  { test: /looback|loopback, link-local or multicast/, hint: "That address type never reaches a host. Use the address your host publishes." },
  { test: /is not an IPv4 address|is not an IPv6 address/, hint: "Write a bare address, for example 203.0.113.10 or 2606:4700::1." },
  { test: /CNAME cannot share/, hint: "A CNAME owns its name. Move the other record one label deeper, for example _proof.<name>." },
  { test: /is not a valid public CNAME target|is not a public hostname|is not a public nameserver/, hint: "Targets have to be public hostnames, not IP literals and not names that only resolve inside a LAN." },
  { test: /apex cannot carry a CNAME|apex cannot delegate/, hint: "The apex cannot hold a CNAME or an NS delegation. Use A and AAAA there." },
  { test: /the name must be <subdomain>\.<zone>\.json/, hint: "Name the file after the claim: domains/jane.is-a.ceo.json for jane.is-a.ceo." },
  { test: /unknown key/, hint: "The key list is closed. Check the spelling against registry/schema.json." },
  { test: /unknown owner key/, hint: "owner takes username, email and id. Nothing else." },
  { test: /only a trusted author can change/, hint: "A claim pull request touches its own domains/<name>.<zone>.json and nothing else." },
  { test: /only an admin can change the trusted list/, hint: "registry/trusted.json is admin-only." },
  { test: /only a trusted author can loosen/, hint: "Removing a word from the policy lists is a trusted author's decision." },
  { test: /releasing it is their call/, hint: "Ask the owner or a trusted author to remove the entry." },
  { test: /belongs to .* so only they/, hint: "Editing someone else's entry needs them or a trusted author." },
  { test: /does not change hands/, hint: "Ownership transfer is a trusted author's action, not a pull request edit." },
  { test: /is a directory/, hint: "Entries stay flat in domains/ because dnsconfig only reads that one level." },
  { test: /answers for every name in the zone/, hint: "A zone-wide name such as @ or _dmarc is held by the registry. Put your record one label deeper." },
  { test: /repeats a value|is empty|is larger than|must be a string|must be true or false/, hint: "Fix the value the message names." },
  { test: /invalid JSON/, hint: "A missing comma, a trailing comma, or a smart quote pasted from a document." },
];

function hintFor(message) {
  for (const { test, hint } of HINTS) if (test.test(message)) return hint;
  return null;
}

function run(args, env) {
  const result = spawnSync(process.execPath, [path.join(R.ROOT, "scripts", "validate.js"), ...args], {
    cwd: R.ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return result.stdout || "";
}

function collect() {
  const out = run(["--json"]);
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, problems: [{ file: null, message: "the validator produced no JSON, so it failed before it could report" }], warnings: [] };
  }
}

function groupByFile(problems) {
  const groups = new Map();
  for (const problem of problems) {
    const key = problem.file || "repository";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(problem.message);
  }
  return groups;
}

function render() {
  const result = collect();
  const lines = [MARKER, ""];

  if (result.ok && result.warnings.length === 0) {
    lines.push("## Registry check passed", "");
    lines.push(`${result.verified} entr${result.verified === 1 ? "y" : "ies"} verified. A trusted author still reviews before merge.`);
    return lines.join("\n");
  }

  lines.push(result.ok ? "## Registry check passed, with notes" : "## Registry check needs a change", "");

  const groups = groupByFile(result.problems);
  for (const [file, messages] of groups) {
    lines.push(`### ${file}`, "");
    for (const message of messages.slice(0, MAX_PER_FILE)) {
      const body = message.includes(file) ? message.slice(message.indexOf(file) + file.length).replace(/^:\s*/, "") : message;
      const hint = hintFor(message);
      lines.push(`- ${body}`);
      if (hint) lines.push(`  ${hint}`);
    }
    if (messages.length > MAX_PER_FILE) {
      lines.push(`- and ${messages.length - MAX_PER_FILE} more in this file`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("### Notes", "");
    lines.push("These do not block the merge.");
    lines.push("");
    for (const warning of result.warnings) lines.push(`- ${warning.message}`);
    lines.push("");
  }

  lines.push("---", "");
  lines.push("A claim is one file: `domains/<subdomain>.<zone>.json`, written from `registry/example.json`.");
  lines.push("Run `npm run verify` before pushing and you will see this same verdict.");
  return lines.join("\n");
}

if (require.main === module) {
  try {
    R.loadPolicy();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  const body = render();
  process.stdout.write(`${body}\n`);
  if (body.includes("## Registry check needs a change")) process.exit(1);
}

module.exports = { render, hintFor, groupByFile };
