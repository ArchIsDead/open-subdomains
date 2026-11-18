#!/usr/bin/env node

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const R = require("./registry.js");

const JSON_MODE = process.argv.includes("--json");

const CLAIM_WARN = 4;

const CODE_PATHS = ["scripts/", "test/", "dnsconfig.js", "package.json", "package-lock.json"];
const POLICY_PATHS = ["registry/"];
const CI_PATHS = [".github/"];
const DOCS = new Set(["README.md", "CONTRIBUTING.md", "AGENTS.md", "LICENSE", ".gitignore", ".gitattributes"]);

const BYPASS_SCOPE = "ci: bypass-scope";
const BYPASS_OWNER = "ci: bypass-owner-check";
const BYPASS_LABELS = new Set([BYPASS_SCOPE, BYPASS_OWNER]);

function labels() {
  const raw = process.env.PR_LABELS || "";
  if (!raw.trim()) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map((label) => String(label).trim()));
  } catch {
    // gh prints a plain list in some versions; fall through to that.
  }
  return new Set(
    raw
      .replace(/[[\]"']/g, "")
      .split(/[,\n]/)
      .map((label) => label.trim())
      .filter(Boolean),
  );
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: R.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function baseName() {
  return process.env.GITHUB_BASE_REF || "main";
}

function judgingPullRequest() {
  if (process.env.GITHUB_BASE_REF) return true;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return true;
  return branch.trim() !== baseName();
}

function changedFiles() {
  const deleted = deletedFiles();

  const fromEnv = process.env.CHANGED_FILES;
  if (fromEnv && fromEnv.trim()) {
    let list;
    try {
      const parsed = JSON.parse(fromEnv);
      list = Array.isArray(parsed) ? parsed : null;
    } catch {
      list = null;
    }
    if (!list) list = fromEnv.split("\n").map((line) => line.trim());
    const removed = new Set(deleted);
    const changed = list
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, "/"))
      .filter((file) => !removed.has(file))
      .map((path) => ({ status: "M", path }));
    return [...changed, ...[...removed].map((path) => ({ status: "D", path }))];
  }

  const flag = process.argv.indexOf("--files");
  if (flag !== -1) {
    return process.argv
      .slice(flag + 1)
      .filter((arg) => !arg.startsWith("--"))
      .map((file) => ({ status: "M", path: file.replace(/\\/g, "/") }));
  }

  if (!judgingPullRequest()) return null;

  for (const range of [`origin/${baseName()}...HEAD`, `${baseName()}...HEAD`]) {
    const out = git(["diff", "--no-renames", "--name-status", range]);
    if (out === null) continue;
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split(/\s+/);
        return { status: status[0], path: rest.join(" ").replace(/\\/g, "/") };
      });
  }
  return null;
}

function deletedFiles() {
  const raw = process.env.DELETED_FILES;
  if (!raw || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => (typeof item === "string" ? item : item && item.name))
    .filter((name) => typeof name === "string" && name.length > 0)
    .map((name) => name.replace(/\\/g, "/"));
}

function baseFile(file) {
  const ref = `origin/${baseName()}`;
  return git(["show", `${ref}:${file}`]) ?? git(["show", `${baseName()}:${file}`]);
}

function basePolicy() {
  const files = ["zones.json", "reserved.json", "blocked.json", "trusted.json"];
  const out = {};
  for (const file of files) {
    const raw = baseFile(`registry/${file}`);
    if (raw === null) return null;
    try {
      out[file] = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return {
    zones: out["zones.json"].map((z) => String(z).toLowerCase()),
    reserved: new Set(out["reserved.json"].map((w) => String(w).toLowerCase())),
    blocked: new Set(out["blocked.json"].map((w) => String(w).toLowerCase())),
    trusted: out["trusted.json"].map((p) => ({
      username: String(p.username || "").toLowerCase(),
      id: Number.isInteger(p.id) ? p.id : null,
      admin: p.admin === true,
    })),
  };
}

function checkLayout(problems, warnings) {
  for (const name of fs.readdirSync(R.ROOT)) {
    if (!name.endsWith(".json")) continue;
    if (["package.json", "package-lock.json", "creds.json", "tsconfig.json"].includes(name)) continue;
    if (name.split(".").length >= 3) {
      warnings.push({ file: name, message: `${name}: entries live in domains/, so this file is never read` });
    }
  }

  if (!fs.existsSync(R.DOMAINS_DIR)) {
    R.fail("domains/ not found");
  }

  for (const name of fs.readdirSync(R.DOMAINS_DIR)) {
    if (name.startsWith(".")) continue;
    const stat = fs.lstatSync(path.join(R.DOMAINS_DIR, name));
    if (stat.isDirectory()) {
      R.fail(`domains/${name}/ is a directory; dnsconfig reads domains/ without recursing, so nothing in it would ever be published`);
    }
    if (!name.endsWith(".json")) {
      warnings.push({ file: `domains/${name}`, message: `domains/${name}: only .json files are read, this one is ignored` });
    }
  }
}

function checkPolicyChange(problems, policy, base, actor, author) {
  if (!base || !author) return;
  const push = (message) => problems.push({ file: null, message });

  const wasTrusted = R.trustedBy(base, author);
  if (!wasTrusted) {
    const added = policy.trusted.filter(
      (person) => !base.trusted.some((old) => (person.id && old.id === person.id) || old.username === person.username),
    );
    if (added.length > 0) {
      push(`registry/trusted.json: this pull request adds ${added.map((p) => `"${p.username}"`).join(", ")}; only an admin can grant trust`);
    }
    for (const [key, file] of [["reserved", "reserved.json"], ["blocked", "blocked.json"]]) {
      const dropped = [...base[key]].filter((word) => !policy[key].has(word));
      if (dropped.length > 0) {
        push(`registry/${file}: this pull request drops ${dropped.slice(0, 5).map((w) => `"${w}"`).join(", ")}; only a trusted author can loosen the name policy`);
      }
    }
    if (policy.zones.join(",") !== base.zones.join(",")) {
      push("registry/zones.json: only a trusted author can change which zones are served");
    }
    return;
  }

  if (!wasTrusted.admin) {
    const changed =
      policy.trusted.length !== base.trusted.length ||
      policy.trusted.some((person) => !base.trusted.some((old) => old.username === person.username && old.id === person.id && old.admin === person.admin));
    if (changed) push("registry/trusted.json: only an admin can change the trusted list");
  }
}

function checkOwner(file, entry) {
  const owner = entry.owner;

  if (!R.isPlainObject(owner)) {
    R.fail(`${file}: "owner" must be an object, e.g. { "username": "jane", "email": "jane@example.net" }`);
  }
  for (const key of Object.keys(owner)) {
    if (!R.OWNER_KEYS.has(key)) R.fail(`${file}: unknown owner key "${key}" (allowed: ${[...R.OWNER_KEYS].join(", ")})`);
  }

  const username = typeof owner.username === "string" ? owner.username.trim() : "";
  const email = typeof owner.email === "string" ? owner.email.trim() : "";

  if (!username && !email) {
    R.fail(
      `${file}: "owner" needs "username" or "email". "username" is your GitHub handle, "email" is an address a maintainer can reach, ` +
        `and "id" (optional) is the number in https://api.github.com/users/<handle>`,
    );
  }

  if (owner.username !== undefined) {
    if (!username) R.fail(`${file}: owner.username is empty; remove the key or write your GitHub handle`);
    if (!R.validHandle(username)) {
      R.fail(`${file}: owner.username "${username}" is not a GitHub handle (letters, digits and single hyphens, up to 39 characters)`);
    }
  }

  if (owner.email !== undefined) {
    if (!email) R.fail(`${file}: owner.email is empty; remove the key or write the address`);
    if (!R.validEmail(email)) R.fail(`${file}: owner.email must be a valid address, e.g. "you@example.com"`);
  }

  if (owner.id !== undefined && (!Number.isInteger(owner.id) || owner.id <= 0)) {
    R.fail(`${file}: owner.id must be the numeric GitHub account id, e.g. 1234567, or left out`);
  }
}

function checkClaimant(file, entry, author, actor, warnings) {
  if (actor || !author) return;
  const owner = R.ownerOf(entry);
  if (!owner) return;

  if (labels().has(BYPASS_OWNER)) {
    if (!warnings.some((item) => item.message.includes(BYPASS_OWNER))) {
      warnings.push({ file, message: `${file}: ${BYPASS_OWNER} is set, so this entry was not matched against the pull request author` });
    }
    return;
  }

  const username = R.ownerUsername(entry);

  if (Number.isInteger(owner.id)) {
    if (!author.id) {
      warnings.push({ file, message: `${file}: owner.id ${owner.id} could not be checked, this run does not know the author id` });
      return;
    }
    if (owner.id !== author.id) {
      R.fail(
        `${file}: owner.id ${owner.id} is not the account opening this pull request (${author.id}); ` +
          `a name cannot be claimed for someone else`,
      );
    }
    return;
  }

  if (username) {
    if (!author.username) {
      warnings.push({ file, message: `${file}: owner.username "${username}" could not be checked, this run does not know the author` });
      return;
    }
    if (username !== author.username.toLowerCase()) {
      R.fail(
        `${file}: owner.username "${username}" is not the account opening this pull request ` +
          `("${author.username}"); add "id" to the owner object to match on the numeric account`,
      );
    }
    return;
  }

  warnings.push({
    file,
    message: `${file}: this entry has no "username", so it cannot be tied to the account opening this pull request. A maintainer will confirm "${R.ownerLabel(entry)}" by hand`,
  });
}

function checkName(file, name, policy, ownerIsTrusted, warnings) {
  const sub = name.subdomain;
  const zone = name.zone;

  if (!policy.zones.includes(zone)) {
    R.fail(`${file}: "${zone}" is not a managed zone (${policy.zones.join(", ")})`);
  }

  const lower = sub.toLowerCase();
  if (sub !== lower) {
    warnings.push({ file, message: `${file}: "${sub}" is not lowercase; rename the file to "${R.claimFile(lower, zone)}"` });
  }
  if (!R.validSubdomain(lower)) {
    R.fail(`${file}: "${sub}" is not a valid subdomain (use "@", "*", "*.<labels>", or dot-separated labels)`);
  }

  const single = !lower.includes(".") && lower !== "@" && lower !== "*";
  if (!single) return;

  if (policy.blocked.has(lower)) {
    R.fail(`${file}: "${sub}" is blocked by the registry and cannot be claimed under any zone`);
  }

  const word = R.reservedWord(lower, policy);
  if (word && !ownerIsTrusted) {
    R.fail(`${file}: "${sub}" is reserved, so the registry already answers for it. Pick a personal handle instead`);
  }

  const lookalike = R.reservedLookalike(lower, policy);
  if (lookalike && !word) {
    warnings.push({
      file,
      message: `${file}: "${sub}" reads as "${lookalike}", which is reserved. It is allowed, but a maintainer may ask for a clearer handle`,
    });
  }
}

const LOOPBACK_V4 = ["127.0.0.0/8", "0.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4"];
const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];
const DOCS_V4 = ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"];

function inRanges(value, ranges) {
  const ip = (address) => {
    const parts = String(address).split(".").map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };
  for (const range of ranges) {
    const [base, bits] = range.split("/");
    const mask = bits === undefined ? 0xffffffff : (0xffffffff << (32 - Number(bits))) >>> 0;
    if ((ip(value) & mask) === (ip(base) & mask)) return true;
  }
  return false;
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function normalizeRecords(file, body, sub, zone, warnings) {
  const raw = body.records === undefined ? {} : body.records;

  if (!R.isPlainObject(raw)) R.fail(`${file}: "records" must be an object keyed by record type`);

  for (const key of Object.keys(raw)) {
    if (!R.RECORD_TYPES.includes(key)) {
      R.fail(`${file}: records.${key} is not a supported type (${R.RECORD_TYPES.join(", ")})`);
    }
  }

  const out = {};
  const list = (kind) => asArray(raw[kind]);
  const dedupe = (kind, values) => {
    const seen = new Set();
    const kept = [];
    for (const value of values) {
      const key = typeof value === "string" ? value.trim().toLowerCase() : JSON.stringify(value);
      if (seen.has(key)) {
        warnings.push({ file, message: `${file}: records.${kind} repeats "${typeof value === "string" ? value : key}", so the copy is dropped` });
        continue;
      }
      seen.add(key);
      kept.push(value);
    }
    return kept;
  };

  if (raw.A !== undefined) {
    out.A = dedupe("A", list("A").map((value) => {
      const text = String(value).trim();
      if (!R.validIPv4(text)) R.fail(`${file}: "${text}" is not an IPv4 address`);
      if (inRanges(text, LOOPBACK_V4)) {
        R.fail(`${file}: "${text}" is a loopback, link-local or multicast address, so it never reaches a host`);
      }
      if (inRanges(text, PRIVATE_V4)) {
        warnings.push({ file, message: `${file}: "${text}" is a private address, so only a machine on that network can reach it` });
      } else if (inRanges(text, DOCS_V4)) {
        warnings.push({ file, message: `${file}: "${text}" is a documentation address, so nothing on the internet reaches it` });
      }
      return text;
    }));
  }

  if (raw.AAAA !== undefined) {
    out.AAAA = dedupe("AAAA", list("AAAA").map((value) => {
      const text = String(value).trim();
      if (!R.validIPv6(text)) R.fail(`${file}: "${text}" is not an IPv6 address`);
      const lower = text.toLowerCase();
      if (lower === "::1" || lower === "::" || lower.startsWith("fe80") || lower.startsWith("ff")) {
        R.fail(`${file}: "${text}" is a loopback, link-local or multicast address, so it never reaches a host`);
      }
      if (lower.startsWith("fc") || lower.startsWith("fd")) {
        warnings.push({ file, message: `${file}: "${text}" is a unique-local address, so only a machine on that network can reach it` });
      } else if (lower.startsWith("2001:db8")) {
        warnings.push({ file, message: `${file}: "${text}" is a documentation address, so nothing on the internet reaches it` });
      }
      return text;
    }));
  }

  if (raw.CNAME !== undefined) {
    const targets = list("CNAME");
    if (targets.length > 1) {
      R.fail(`${file}: records.CNAME takes one target, because DNS forbids two CNAMEs on one name`);
    }
    const target = String(targets[0]).trim();
    if (!R.validTarget(target)) {
      R.fail(`${file}: "${target}" is not a valid public CNAME target`);
    }
    const plain = target.toLowerCase().replace(/\.$/, "");
    if (plain === zone || plain === R.fqdnOf(sub, zone)) {
      R.fail(`${file}: CNAME target "${target}" cannot point at the name it sits on, or at the apex`);
    }
    out.CNAME = target;
  }

  if (raw.TXT !== undefined) {
    out.TXT = list("TXT").map((value) => {
      const text = String(value);
      if (text.length === 0) R.fail(`${file}: TXT values are non-empty strings`);
      if (/[\x00-\x1f\x7f]/.test(text)) R.fail(`${file}: TXT values cannot hold control characters`);
      if (text.length > 255) {
        warnings.push({ file, message: `${file}: this TXT value is ${text.length} characters, so it is published as several strings in one record` });
      }
      return text;
    });
  }

  if (raw.MX !== undefined) {
    out.MX = dedupe("MX", list("MX").map((value) => {
      if (typeof value === "string") {
        const parts = value.trim().split(/\s+/);
        const priority = parts.length === 2 && /^\d+$/.test(parts[0]) ? Number(parts[0]) : 10;
        const target = parts.length === 2 && /^\d+$/.test(parts[0]) ? parts[1] : value.trim();
        if (!R.validTarget(target)) R.fail(`${file}: MX target "${target}" is not a public hostname`);
        return { priority, target };
      }
      if (!R.isPlainObject(value)) {
        R.fail(`${file}: an MX entry is a hostname, "10 mx.example.com", or { "priority": 10, "target": "mx.example.com" }`);
      }
      const priority = value.priority === undefined ? 10 : value.priority;
      if (!Number.isInteger(priority) || priority < 0 || priority > 65535) {
        R.fail(`${file}: MX priority must be a whole number from 0 to 65535`);
      }
      if (!R.validTarget(value.target)) R.fail(`${file}: MX target "${value.target}" is not a public hostname`);
      return { priority, target: value.target };
    }));
  }

  if (raw.NS !== undefined) {
    out.NS = list("NS").map((value) => {
      const text = String(value).trim();
      if (!R.validTarget(text)) R.fail(`${file}: "${text}" is not a public nameserver name`);
      return text;
    });
  }

  if (raw.SRV !== undefined) {
    out.SRV = dedupe("SRV", list("SRV").map((value) => {
      const range = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;
      if (typeof value === "string") {
        const parts = value.trim().split(/\s+/);
        if (parts.length !== 4 || !parts.slice(0, 3).every((p) => /^\d+$/.test(p)) || !R.validTarget(parts[3])) {
          R.fail(`${file}: an SRV entry is "priority weight port target", or an object with those keys`);
        }
        return { priority: Number(parts[0]), weight: Number(parts[1]), port: Number(parts[2]), target: parts[3] };
      }
      if (!R.isPlainObject(value)) {
        R.fail(`${file}: an SRV entry is "0 5 25565 mc.example.com" or { "priority": 0, "weight": 5, "port": 25565, "target": "mc.example.com" }`);
      }
      const srv = { priority: value.priority ?? 0, weight: value.weight ?? 0, port: value.port ?? 0, target: value.target };
      if (!range(srv.priority) || !range(srv.weight) || !range(srv.port) || !R.validTarget(srv.target)) {
        R.fail(`${file}: SRV entries need priority, weight and port as numbers 0-65535, and a public target`);
      }
      return srv;
    }));
  }

  if (raw.CAA !== undefined) {
    out.CAA = dedupe("CAA", list("CAA").map((value) => {
      if (!R.isPlainObject(value)) {
        R.fail(`${file}: a CAA entry looks like { "flag": 0, "tag": "issue", "value": "letsencrypt.org" }`);
      }
      const caa = { flag: value.flag ?? 0, tag: value.tag, value: value.value };
      if (![0, 128].includes(caa.flag) || !["issue", "issuewild", "iodef"].includes(caa.tag)) {
        R.fail(`${file}: CAA entries take flag 0 or 128, and tag issue, issuewild or iodef`);
      }
      if (typeof caa.value !== "string" || caa.value.length === 0 || caa.value.length > 255) {
        R.fail(`${file}: a CAA value is a non-empty string of up to 255 characters`);
      }
      if (/[\x00-\x1f\x7f]/.test(caa.value)) R.fail(`${file}: CAA values cannot hold control characters`);
      if (caa.tag !== "iodef" && /[/\s]/.test(caa.value)) {
        R.fail(`${file}: a CAA "${caa.tag}" value is a bare domain like "letsencrypt.org", not a URL`);
      }
      return caa;
    }));
  }

  if (raw.PTR !== undefined) {
    out.PTR = list("PTR").map((value) => {
      const text = String(value).trim();
      if (!R.validTarget(text)) R.fail(`${file}: "${text}" is not a public hostname`);
      return text;
    });
  }

  if (R.isApex(sub) && out.CNAME !== undefined) R.fail(`${file}: the apex cannot carry a CNAME; use A and AAAA`);
  if (R.isApex(sub) && out.NS !== undefined) R.fail(`${file}: the apex cannot delegate with NS; that delegation belongs to Cloudflare`);

  const exclusive = ["A", "AAAA", "MX", "NS", "SRV", "PTR"].filter((kind) => out[kind]);
  if (out.CNAME !== undefined && exclusive.length > 0) {
    R.fail(`${file}: a CNAME cannot share its name with ${exclusive.join(", ")}`);
  }

  const kept = Object.keys(out);
  if (kept.length === 0) {
    // No key at all is the documented way to ask for the Pages default, so it
    // is not worth a note. An empty block is, because it looks like an edit.
    if (body.records !== undefined) {
      warnings.push({ file, message: `${file}: "records" publishes nothing, so the name falls back to the GitHub Pages default. Remove the key to say that on purpose` });
    }
    return null;
  }

  // Every list emptied by deduplication means the block published nothing.
  const published = kept.filter((kind) => (Array.isArray(out[kind]) ? out[kind].length > 0 : true));
  if (published.length === 0) {
    warnings.push({ file, message: `${file}: "records" holds only repeated values, so it falls back to the GitHub Pages default` });
    return null;
  }

  return out;
}

function validateEntry(filename, name, body, policy, author, actor, touched, warnings) {
  const file = `domains/${filename}`;

  for (const key of Object.keys(body)) {
    if (!R.ENTRY_KEYS.has(key)) {
      R.fail(`${file}: unknown key "${key}" (allowed: ${[...R.ENTRY_KEYS].join(", ")})`);
    }
  }

  checkOwner(file, body);
  if (touched) checkClaimant(file, body, author, actor, warnings);
  const ownerEntry = R.trustedBy(policy, { id: R.ownerOf(body)?.id, username: R.ownerUsername(body) });
  checkName(file, name, policy, Boolean(ownerEntry), warnings);

  if (body.repo !== undefined && !R.validRepo(body.repo)) {
    R.fail(`${file}: "repo" must look like github.com/you/project or a full https URL`);
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") R.fail(`${file}: "description" must be a string`);
    if (body.description.length > 200) {
      warnings.push({ file, message: `${file}: "description" is ${body.description.length} characters, the site shows the first 200` });
    }
  }
  if (body.proxied !== undefined && typeof body.proxied !== "boolean") {
    R.fail(`${file}: "proxied" must be true or false`);
  }

  const sub = name.subdomain;
  if (R.isZoneWide(sub) && !ownerEntry) {
    R.fail(
      `${file}: "${sub}" answers for every name in the zone, so a trusted author holds it. Put your record one label deeper`,
    );
  }

  return {
    file,
    sub,
    zone: name.zone,
    body,
    records: normalizeRecords(file, body, sub, name.zone, warnings),
  };
}

function checkBaseClaims(entries) {
  const problems = [];
  const owners = new Map();
  for (const entry of entries) {
    if (R.isZoneWide(entry.sub) || entry.sub.startsWith("*.") || R.isAuxiliary(entry.sub)) continue;
    owners.set(`${entry.zone}/${entry.sub.toLowerCase()}`, R.ownerKey(entry.body));
  }

  for (const entry of entries) {
    if (!entry.sub.includes(".")) continue;
    const labels = entry.sub.split(".");
    const serviceOnly = entry.records && entry.records.SRV && !["A", "AAAA", "CNAME", "TXT", "MX", "NS", "PTR"].some((k) => entry.records[k]);
    if (labels[0] !== "*" && serviceOnly) continue;

    // The leftmost label is the record being made, so the base starts one label
    // in: www.jane sits on jane. An underscore label is a service prefix, not
    // part of the base: s1._domainkey.jane sits on jane too.
    let index = 1;
    for (let i = index; i < labels.length - 1; i += 1) {
      if (labels[i].startsWith("_")) index = i + 1;
    }

    const base = labels.slice(index).join(".");
    if (!base || base === entry.sub) continue;
    if (owners.get(`${entry.zone}/${base.toLowerCase()}`) !== R.ownerKey(entry.body)) {
      problems.push({ file: entry.file, message: `${entry.file}: "${entry.sub}" needs "${base}" in ${entry.zone} claimed by the same owner first` });
    }
  }
  return problems;
}

function checkSharedTargets(entries, zones, warnings) {
  const seen = new Map();
  const inZone = (target) => zones.some((zone) => target === zone || target.endsWith(`.${zone}`));

  for (const entry of entries) {
    if (!entry.records) continue;
    const targets = [];
    if (entry.records.CNAME) targets.push(["CNAME", entry.records.CNAME]);
    for (const ip of entry.records.A || []) targets.push(["A", ip]);
    for (const ip of entry.records.AAAA || []) targets.push(["AAAA", ip]);

    for (const [kind, value] of targets) {
      const plain = String(value).toLowerCase().replace(/\.$/, "");
      const key = `${entry.zone}/${kind}/${plain}`;
      const held = seen.get(key);
      if (!held) {
        seen.set(key, entry);
        continue;
      }
      if (R.ownerKey(held.body) === R.ownerKey(entry.body)) continue;
      if (!inZone(plain)) continue;
      warnings.push({
        file: entry.file,
        message: `${entry.file}: records.${kind} "${value}" is also used by ${held.sub}.${held.zone}. Pointing at another claimant's name in the zone makes the alias theirs to break`,
      });
    }
  }
}

function checkScope(problems, warnings, files, actor, author) {
  if (!files) return;
  const push = (message, file = null) => problems.push({ file, message });
  const warn = (message, file = null) => warnings.push({ file, message });
  const touches = (file, prefixes) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix));
  const claims = files.filter((f) => f.path.startsWith("domains/"));

  if (claims.length > CLAIM_WARN) {
    warn(`this pull request changes ${claims.length} files under domains/; splitting them makes the review shorter, but it is allowed`);
  }

  const bypassScope = labels().has(BYPASS_SCOPE);
  if (bypassScope) {
    warn(`${BYPASS_SCOPE} is set, so the file-scope rules in this run are skipped. A maintainer took that decision`);
  }

  if (!actor && !bypassScope) {
    for (const { path: file } of files) {
      if (file.startsWith("domains/")) continue;
      if (DOCS.has(file) || file.endsWith(".md")) continue;
      if (touches(file, POLICY_PATHS) || touches(file, CODE_PATHS) || touches(file, CI_PATHS) || file === "CODEOWNERS") {
        push(`${file}: only a trusted author can change this. A claim pull request touches its own domains/<name>.<zone>.json and nothing else`);
      }
    }
  } else if (actor && !actor.admin) {
    for (const { path: file } of files) {
      if (file === "registry/trusted.json") push("registry/trusted.json: only an admin can change the trusted list");
    }
  }

  if (actor) return;

  const holds = (entryBody) => {
    const owner = R.ownerOf(entryBody);
    if (!owner) return null;
    if (Number.isInteger(owner.id) && author.id) return owner.id === author.id;
    const username = R.ownerUsername(entryBody);
    if (username && author.username) return username === author.username.toLowerCase();
    // Nothing comparable, which leaves this rule unable to clear the author.
    return null;
  };

  if (labels().has(BYPASS_OWNER)) {
    warn(`${BYPASS_OWNER} is set, so a maintainer has taken over the ownership check for this run`);
    return;
  }

  for (const { status, path: file } of claims) {
    if (!file.endsWith(".json")) continue;
    const previous = baseFile(file);
    if (status === "D") {
      if (previous === null) continue;
      let before;
      try {
        before = JSON.parse(previous);
      } catch {
        continue;
      }
      if (holds(before) === false) {
        push(`${file}: this name belongs to "${R.ownerLabel(before)}"; releasing it is their call or a trusted author's`);
      }
      continue;
    }
    if (previous === null) continue;

    let before;
    try {
      before = JSON.parse(previous);
    } catch {
      continue;
    }
    if (holds(before) === false) {
      push(`${file}: this entry belongs to "${R.ownerLabel(before)}", so only they or a trusted author can change it`);
      continue;
    }
    if (!fs.existsSync(path.join(R.ROOT, file))) continue;

    let after;
    try {
      after = JSON.parse(fs.readFileSync(path.join(R.ROOT, file), "utf8"));
    } catch {
      continue;
    }
    const wasKey = R.ownerKey(before);
    const nowKey = R.ownerKey(after);
    if (wasKey && nowKey && wasKey !== nowKey) {
      push(`${file}: owner moves from "${R.ownerLabel(before)}" to "${R.ownerLabel(after)}"; a claim does not change hands through a pull request`);
    }
  }
}

function report(problems, verified, warnings) {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, verified, problems, warnings }, null, 2)}\n`);
  } else {
    for (const warning of warnings) console.error(`validate: warning: ${warning.message}`);
    for (const problem of problems) console.error(`validate: ${problem.message}`);
    if (problems.length === 0) console.log(`validate: ${verified} entr${verified === 1 ? "y" : "ies"} verified`);
  }
  if (problems.length > 0) process.exit(1);
}

function main() {
  const problems = [];
  const warnings = [];
  let policy;

  try {
    policy = R.loadPolicy();
  } catch (err) {
    if (!(err instanceof R.RegistryError)) throw err;
    policy = null;
    problems.push({ file: null, message: err.message });
  }

  try {
    checkLayout(problems, warnings);
  } catch (err) {
    if (!(err instanceof R.RegistryError)) throw err;
    problems.push({ file: null, message: err.message });
  }

  const author = R.currentAuthor();
  const actor = policy ? R.trustedBy(policy, author) : null;
  const changed = changedFiles();
  const touched = changed === null ? null : new Set(changed.map((entry) => entry.path));

  if (policy) {
    try {
      checkPolicyChange(problems, policy, basePolicy(), actor, author);
    } catch (err) {
      if (!(err instanceof R.RegistryError)) throw err;
      problems.push({ file: null, message: err.message });
    }
  }

  const entries = [];
  if (policy && fs.existsSync(R.DOMAINS_DIR)) {
    for (const { filename, full } of R.loadClaims(R.DOMAINS_DIR, { all: true })) {
      const name = R.parseClaimFile(filename, policy.zones);
      if (!name) {
        problems.push({
          file: `domains/${filename}`,
          message: `domains/${filename}: the name must be <subdomain>.<zone>.json, for example jane.${policy.zones[0]}.json or @.${policy.zones[0]}.json`,
        });
        continue;
      }

      const stat = fs.lstatSync(full);
      if (!stat.isFile()) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: entries are regular files, never a symlink` });
        continue;
      }
      if (stat.size > R.MAX_FILE_BYTES) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: file is larger than ${R.MAX_FILE_BYTES} bytes` });
        continue;
      }
      if (filename !== R.claimFile(name.subdomain, name.zone)) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: the filename does not round-trip to the same name` });
        continue;
      }

      let body;
      try {
        body = R.readJson(full);
      } catch (err) {
        if (!(err instanceof R.RegistryError)) throw err;
        problems.push({ file: `domains/${filename}`, message: err.message });
        continue;
      }
      if (!R.isPlainObject(body)) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: an entry is one JSON object, not an array or a bare value` });
        continue;
      }

      try {
        // With no readable change set the claimant check steps aside rather than
        // guessing.
        const isTouched = touched !== null && touched.has(`domains/${filename}`);
        entries.push(validateEntry(filename, name, body, policy, author, actor, isTouched, warnings));
      } catch (err) {
        if (!(err instanceof R.RegistryError)) throw err;
        problems.push({ file: `domains/${filename}`, message: err.message });
      }
    }
  }

  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.zone}/${entry.sub.toLowerCase()}`;
    if (seen.has(key)) {
      problems.push({ file: entry.file, message: `${entry.file}: "${entry.sub}" is already claimed in ${entry.zone}` });
    }
    seen.set(key, entry);
  }

  problems.push(...checkBaseClaims(entries));
  checkSharedTargets(entries, policy ? policy.zones : [], warnings);

  try {
    checkScope(problems, warnings, changedFiles(), actor, author);
  } catch (err) {
    if (!(err instanceof R.RegistryError)) throw err;
    problems.push({ file: null, message: err.message });
  }

  report(problems, entries.length, warnings);
}

if (require.main === module) main();

module.exports = { validateEntry, checkScope, checkBaseClaims, normalizeRecords };
