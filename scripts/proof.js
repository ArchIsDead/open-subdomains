#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const R = require("./registry.js");

function parseArgs(argv) {
  const out = { name: "", proof: "", label: "", remove: false, list: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--name") out.name = next();
    else if (arg === "--proof") out.proof = next();
    else if (arg === "--label") out.label = next();
    else if (arg === "--remove") out.remove = true;
    else if (arg === "--list") out.list = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/proof.js --list",
    '  node scripts/proof.js --name jane --label _acme-challenge --proof "vc-domain-verify=jane.is-a.ceo,abc123"',
    "  node scripts/proof.js --name jane --label _acme-challenge --remove",
    "",
    "Writes domains/<label>.<name>.<zone>.json, the file that carries a hosting",
    "proof line. It goes one label deeper because the name itself usually holds a",
    "CNAME, and DNS refuses a CNAME and a TXT on one name.",
    "",
    "The proof line has to name the host it was minted for. A line minted for a",
    "different name is refused, because it would prove ownership of that name.",
  ].join("\n");
}

function txtValues(body) {
  const raw = body && body.records && body.records.TXT;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function findClaim(label, zones) {
  const matches = R.loadClaims()
    .map(({ filename, full }) => ({ filename, full, name: R.parseClaimFile(filename, zones) }))
    .filter(({ name }) => name && name.subdomain === label);
  if (matches.length === 0) throw new Error(`no entry claims "${label}"`);
  if (matches.length > 1) {
    throw new Error(`"${label}" is claimed in ${matches.map((m) => m.name.zone).join(" and ")}; name the file you mean`);
  }
  return matches[0];
}

function sidecarFile(prefix, label, zone) {
  return path.join(R.DOMAINS_DIR, `${prefix}.${label}.${zone}.json`);
}

function listSidecars(policy) {
  const rows = R.loadClaims()
    .map(({ filename, full }) => ({ filename, full, name: R.parseClaimFile(filename, policy.zones) }))
    .filter(({ name }) => {
      if (!name) return false;
      const labels = name.subdomain.split(".");
      return labels.length > 1 && labels[0].startsWith("_");
    });

  if (rows.length === 0) {
    console.log("no proof files in domains/");
    return;
  }

  for (const { filename, full, name } of rows) {
    let body;
    try {
      body = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      console.log(`${filename}  (does not parse)`);
      continue;
    }
    console.log(filename);
    console.log(`  owner  ${R.ownerLabel(body)}`);
    for (const proof of txtValues(body)) console.log(`  proof  ${proof}`);
    console.log(`  for    ${name.subdomain.split(".").slice(1).join(".")}.${name.zone}`);
  }
  return rows.length;
}

function validate(file) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "validate.js")], {
    cwd: R.ROOT,
    encoding: "utf8",
    env: { ...process.env, CHANGED_FILES: JSON.stringify([path.relative(R.ROOT, file).replace(/\\/g, "/")]) },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length === 2) {
    console.log(usage());
    return;
  }

  const policy = R.loadPolicy();

  if (args.list) {
    listSidecars(policy);
    return;
  }

  if (!args.name) throw new Error("--name is required");
  if (!args.label) throw new Error("--label is required, for example --label _acme-challenge");
  if (!args.label.startsWith("_")) throw new Error(`--label "${args.label}" has to start with an underscore`);

  const claim = findClaim(args.name, policy.zones);
  const zone = claim.name.zone;
  const file = sidecarFile(args.label, args.name, zone);

  if (args.remove) {
    if (!fs.existsSync(file)) throw new Error(`no proof file at domains/${path.basename(file)}`);
    fs.unlinkSync(file);
    console.log(`removed domains/${path.basename(file)}`);
    return;
  }

  let proof = args.proof.trim();
  if (!proof) throw new Error("pass --proof with the whole line from the provider dashboard");
  if (!R.VERIFY_RE.test(proof)) throw new Error(`"${proof}" is not a proof line; it looks like vc-domain-verify=<name>,<token>`);

  const claimed = R.VERIFY_RE.exec(proof)[1].toLowerCase();
  const expected = R.fqdnOf(args.name, zone);
  if (claimed !== expected) {
    throw new Error(`this line was minted for "${claimed}", so it cannot be used for ${expected}`);
  }

  const body = {
    $schema: "../registry/schema.json",
    owner: JSON.parse(fs.readFileSync(claim.full, "utf8")).owner,
    description: `Hosting proof for ${expected}. Temporary: removed once the provider reads the name as verified.`,
    records: { TXT: [proof] },
  };

  const text = `${JSON.stringify(body, null, 2)}\n`;

  if (args.dryRun) {
    console.log(text);
    return;
  }

  fs.writeFileSync(file, text);
  console.log(`wrote domains/${path.basename(file)}`);

  const result = validate(file);
  if (!result.ok) {
    console.error(result.output.trim());
    console.error("\nthe file was written but the registry refuses it; fix the entry before committing");
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("Next:");
  console.log(`  1. Commit domains/${path.basename(file)} with the claim and open the pull request.`);
  console.log("  2. After the merge, press Verify in the provider dashboard and wait for it to pass.");
  console.log(`  3. Remove it again: node scripts/proof.js --name ${args.name} --label ${args.label} --remove`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`proof: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, sidecarFile };
