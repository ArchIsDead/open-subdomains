"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

const ZONES = ["is-a.ceo"];

const RESERVED = ["www", "docs", "_vercel", "_dmarc", "_domainkey", "_acme-challenge"];

const BLOCKED = ["paypal", "github", "gmail"];

const TRUSTED = [
  { username: "dikaardnt", id: 88322331, admin: true },
  { username: "hisokalabs", id: 103969998, admin: false },
];

const FULL = { username: "jisoa", email: "jisoa@example.net", id: 9001 };

function claimFile(label) {
  return `${label}.is-a.ceo.json`;
}

function entry(extra = {}) {
  return { owner: { ...FULL }, records: { CNAME: "target.example.com" }, ...extra };
}

function owner(username = FULL.username, extra = {}) {
  return { username, email: FULL.email, id: FULL.id, ...extra };
}

function makeRegistry(files, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const name of fs.readdirSync(SCRIPTS)) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  }
  const pkg = { name: "fixture", version: "1.0.0", private: true };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": pkg } }));
  fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ cloudflare: { TYPE: "CLOUDFLAREAPI" } }));

  const policy = path.join(dir, "registry");
  fs.mkdirSync(policy);

  const writePolicy = (spec) => {
    fs.writeFileSync(path.join(policy, "zones.json"), JSON.stringify(spec.zones || ZONES));
    fs.writeFileSync(path.join(policy, "reserved.json"), JSON.stringify(spec.reserved || RESERVED));
    fs.writeFileSync(path.join(policy, "blocked.json"), JSON.stringify(spec.blocked || BLOCKED));
    fs.writeFileSync(path.join(policy, "trusted.json"), JSON.stringify(spec.trusted || TRUSTED));
    fs.writeFileSync(path.join(policy, "schema.json"), "{}");
    fs.writeFileSync(path.join(policy, "example.json"), "{}");
  };

  writePolicy({});
  fs.mkdirSync(path.join(dir, "domains"));

  if (options.base) {
    writePolicy(options.base);
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    if (options.base.domains) {
      for (const [file, content] of Object.entries(options.base.domains)) {
        const target = path.join(dir, "domains", file);
        fs.writeFileSync(target, `${JSON.stringify(content, null, 2)}\n`);
      }
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base claims"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    }
  }

  writePolicy(options);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, "domains", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return dir;
}

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function run(dir, env = {}, script = "validate.js", args = []) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", script), ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function passes(files, env, options) {
  const dir = makeRegistry(files, options);
  const result = run(dir, env);
  cleanup(dir);
  assert.equal(result.code, 0, `expected a pass, got exit ${result.code}:\n${result.out}`);
  return result;
}

function fails(files, pattern, env, options) {
  const dir = makeRegistry(files, options);
  const result = run(dir, env);
  cleanup(dir);
  assert.equal(result.code, 1, `expected a rejection, got exit 0:\n${result.out}`);
  if (pattern) assert.match(result.out, pattern);
  return result;
}

const PR = { PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "9001", CHANGED_FILES: `domains/${claimFile("jane")}` };

const skipOnWindows = process.platform === "win32" ? "a filename cannot contain * on Windows" : false;

test("a plain CNAME claim passes", () => {
  passes({ [claimFile("jane")]: entry() });
});

test("an entry with no records gets the Pages default", () => {
  passes({ [claimFile("bare")]: { owner: owner() } });
});

test("an empty records object falls back to the Pages default with a note", () => {
  const result = passes({ [claimFile("bare")]: { owner: owner(), records: {} } });
  assert.match(result.out, /falls back to the GitHub Pages default/);
});

test("owner needs only a username", () => {
  passes({ [claimFile("jane")]: { owner: { username: "jisoa" }, records: { CNAME: "target.example.com" } } });
});

test("owner needs only an email", () => {
  passes({ [claimFile("jane")]: { owner: { email: "jisoa@example.net" }, records: { CNAME: "target.example.com" } } });
});

test("an email-only entry is claimable, with a note instead of a refusal", () => {
  const result = passes(
    { [claimFile("jane")]: { owner: { email: "jisoa@example.net" }, records: { CNAME: "target.example.com" } } },
    PR,
  );
  assert.match(result.out, /cannot be tied to the account/);
});

test("id alone is not enough", () => {
  fails({ [claimFile("jane")]: { owner: { id: 9001 }, records: { CNAME: "target.example.com" } } }, /needs "username" or "email"/);
});

test("a username is accepted in any case", () => {
  passes({ [claimFile("jane")]: { owner: { username: "JiSoa" }, records: { CNAME: "target.example.com" } } });
});

test("a scalar address is read as a one-item list", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { A: "198.51.100.1" } } });
});

test("a private address is accepted with a note", () => {
  const result = passes({ [claimFile("jane")]: { owner: owner(), records: { A: "192.168.1.10" } } });
  assert.match(result.out, /is a private address/);
});

test("a documentation address is accepted with a note", () => {
  const result = passes({ [claimFile("jane")]: { owner: owner(), records: { A: "203.0.113.10" } } });
  assert.match(result.out, /is a documentation address/);
});

test("a loopback address is still refused", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { A: "127.0.0.1" } } }, /never reaches a host/);
});

test("an IPv6 loopback is still refused", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { AAAA: "::1" } } }, /never reaches a host/);
});

test("a malformed address is refused", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { A: "1.2.3" } } }, /is not an IPv4 address/);
});

test("MX takes a bare hostname and defaults the priority to 10", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { MX: ["mx.example.net"] } } });
});

test("MX takes a priority in one string", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { MX: ["20 mx.example.net"] } } });
});

test("MX takes the object shape too", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { MX: [{ target: "mx.example.net" }] } } });
});

test("SRV takes the four-field string", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { SRV: ["0 5 25565 mc.example.net"] } } });
});

test("CAA defaults its flag to 0", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { CAA: [{ tag: "issue", value: "letsencrypt.org" }] } } });
});

test("a TXT claim mirrors a scalar", () => {
  passes({ [claimFile("jane")]: { owner: owner(), records: { TXT: "hello world" } } });
});

test("a long TXT value is published, with a note", () => {
  const result = passes({ [claimFile("jane")]: { owner: owner(), records: { TXT: ["x".repeat(300)] } } });
  assert.match(result.out, /published as several strings/);
});

test("a repeated value is dropped with a note, not refused", () => {
  const result = passes({ [claimFile("jane")]: { owner: owner(), records: { A: ["198.51.100.1", "198.51.100.1"] } } });
  assert.match(result.out, /repeats/);
});

test("an uppercase filename is a note, not a refusal", () => {
  const result = passes({ ["Jane.is-a.ceo.json"]: entry() });
  assert.match(result.out, /is not lowercase/);
});

test("a description over 200 characters is a note", () => {
  const result = passes({ [claimFile("jane")]: entry({ description: "x".repeat(250) }) });
  assert.match(result.out, /shows the first 200/);
});

test("a near miss on a reserved word is a note", () => {
  const result = passes({ [claimFile("d0cs")]: entry() });
  assert.match(result.out, /reads as "docs"/);
});test("a top-level reserved word is still refused", () => {
  fails({ [claimFile("www")]: entry() }, /is reserved/);
});

test("a reserved word stays claimable by a trusted author", () => {
  passes({ [claimFile("www")]: { owner: owner("dikaardnt"), records: { CNAME: "target.example.com" } } });
});

test("a blocked label is refused whoever holds it", () => {
  fails({ [claimFile("paypal")]: { owner: owner("dikaardnt"), records: { CNAME: "target.example.com" } } }, /is blocked/);
});

test("a blocked word is only blocked where it stands alone", () => {
  passes({ [claimFile("shop")]: entry(), [claimFile("paypal.shop")]: entry() });
});

test("one owner may hold several names", () => {
  passes({ [claimFile("jane")]: entry(), [claimFile("jane2")]: entry() });
});

test("a nested name passes when the owner also holds the base", () => {
  passes({ [claimFile("jane")]: entry(), [claimFile("www.jane")]: entry() });
});

test("a nested name without its base is refused", () => {
  fails({ [claimFile("www.jane")]: entry() }, /needs "jane"/);
});

test("a nested name over another owner is refused", () => {
  fails(
    {
      [claimFile("jane")]: { owner: { username: "someone" }, records: { CNAME: "target.example.com" } },
      [claimFile("www.jane")]: entry(),
    },
    /needs "jane"/,
  );
});

test("a claim belongs to the account that opens the pull request", () => {
  fails({ [claimFile("jane")]: entry() }, /is not the account opening this pull request/, {
    ...PR,
    PR_AUTHOR: "someone-else",
    PR_AUTHOR_ID: "7331",
  });
});

test("a username that is not the author is refused without an id to clear it", () => {
  fails({ [claimFile("jane")]: { owner: { username: "jisoa" }, records: { CNAME: "target.example.com" } } }, /is not the account opening this pull request/, {
    ...PR,
    PR_AUTHOR: "someone-else",
  });
});
test("an id match beats a renamed username", () => {
  passes({ [claimFile("jane")]: entry() }, { ...PR, PR_AUTHOR: "renamed", PR_AUTHOR_ID: "9001" });
});

test("an entry that is an array is refused", () => {
  fails({ [claimFile("jane")]: "[1, 2]" }, /one JSON object/);
});

test("invalid JSON names the file", () => {
  fails({ [claimFile("jane")]: "{ owner: " }, /invalid JSON/);
});

test("unknown keys are refused", () => {
  fails({ [claimFile("jane")]: { owner: owner(), domain: "is-a.ceo" } }, /unknown key "domain"/);
});

test("an unknown owner key is refused", () => {
  fails({ [claimFile("jane")]: { owner: { username: "jisoa", mail: "x@example.net" } } }, /unknown owner key "mail"/);
});

test("a malformed email is refused", () => {
  fails({ [claimFile("jane")]: { owner: { email: "not-an-address" } } }, /valid address/);
});

test("a folder inside domains/ is refused", () => {
  fails({ "nested/jane.is-a.ceo.json": entry() }, /is a directory/);
});

test("the zone must be managed", () => {
  fails({ "jane.example.com.json": entry() }, /must be <subdomain>\.<zone>\.json/);
});

test("a duplicate name is refused", { skip: skipOnWindows }, () => {
  fails({ [claimFile("jane")]: entry(), ["Jane.is-a.ceo.json"]: entry() }, /already claimed/);
});

test("a wildcard needs its base claimed by the same owner first", { skip: skipOnWindows }, () => {
  fails({ [claimFile("*.shop")]: entry() }, /needs "shop"/);
});

test("a wildcard passes once the base belongs to the same owner", { skip: skipOnWindows }, () => {
  passes({ [claimFile("shop")]: entry(), [claimFile("*.shop")]: entry() });
});

test("a wildcard over someone else's name is refused", { skip: skipOnWindows }, () => {
  fails(
    {
      [claimFile("shop")]: { owner: owner("dikaardnt", { id: 4242 }), records: { CNAME: "target.example.com" } },
      [claimFile("*.shop")]: entry(),
    },
    /needs "shop"/,
  );
});

test("an underscore record needs its base claimed by the same owner", () => {
  fails({ [claimFile("_acme-challenge.shop")]: { owner: owner(), records: { TXT: ["proof"] } } }, /needs "shop"/);
});

test("a CNAME cannot share its name with an address record", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { CNAME: "target.example.com", A: "198.51.100.1" } } }, /cannot share/);
});

test("a self-referencing CNAME is refused", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { CNAME: "jane.is-a.ceo" } } }, /cannot point at the name it sits on/);
});

test("a local-only target is refused", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { CNAME: "nas.local" } } }, /not a valid public CNAME target/);
});

test("the apex cannot use CNAME or NS", () => {
  fails({ [claimFile("@")]: { owner: owner("dikaardnt"), records: { CNAME: "target.example.com" } } }, /apex cannot carry a CNAME/);
});

test("the apex _vercel name is an ordinary reserved label", () => {
  // Same rule as www and docs: refused to a plain author, open to a trusted one.
  fails({ [claimFile("_vercel")]: { owner: owner(), records: { TXT: ["x"] } } }, /is reserved/);
  passes({ [claimFile("_vercel")]: { owner: owner("dikaardnt"), records: { TXT: ["x"] } } });
});

test("_vercel is a plain zone-wide name when the policy does not reserve it", () => {
  fails({ [claimFile("_vercel")]: { owner: owner(), records: { TXT: ["x"] } } }, /trusted author holds it/, undefined, {
    reserved: ["www", "docs"],
  });
});

test("a zone-wide name is trusted-only", () => {
  fails({ [claimFile("_abuse")]: { owner: owner(), records: { TXT: ["report to contact@example.net"] } } }, /trusted author holds it/);
});

test("a zone-wide name passes for a trusted author", () => {
  passes({ [claimFile("_abuse")]: { owner: owner("dikaardnt"), records: { TXT: ["report to contact@example.net"] } } });
});

test("a target another claimant uses inside the zone is a note", () => {
  const result = passes({
    [claimFile("jane")]: { owner: owner(), records: { CNAME: "bob.is-a.ceo" } },
    [claimFile("bob")]: { owner: { username: "bob", email: "bob@example.net" }, records: { CNAME: "target.example.com" } },
    [claimFile("alex")]: { owner: { username: "alex", email: "alex@example.net" }, records: { CNAME: "bob.is-a.ceo" } },
  });
  assert.match(result.out, /records\.CNAME "bob\.is-a\.ceo" is also used by/);
});

test("a shared platform address passes without a note", () => {
  const platform = { CNAME: "same-project.pages.dev" };
  const result = passes({
    [claimFile("jane")]: { owner: owner(), records: platform },
    [claimFile("bob")]: { owner: { username: "bob", email: "bob@example.net" }, records: platform },
  });
  assert.doesNotMatch(result.out, /also used by/);
});

test("a shared address is accepted, since hosting platforms do exactly that", () => {
  const result = passes({
    [claimFile("jane")]: { owner: owner(), records: { A: "198.51.100.7" } },
    [claimFile("bob")]: { owner: { username: "bob", email: "bob@example.net" }, records: { A: "198.51.100.7" } },
  });
  assert.doesNotMatch(result.out, /also used by/);
});

test("a Vercel proof sidecar is an ordinary entry", () => {
  passes({
    [claimFile("jane")]: entry(),
    [claimFile("_vercel.jane")]: { owner: owner(), records: { TXT: ["vc-domain-verify=jane.is-a.ceo,abc123"] } },
  });
});

test("--json reports ok, verified, problems and warnings", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  const result = run(dir, {}, "validate.js", ["--json"]);
  cleanup(dir);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ["ok", "problems", "verified", "warnings"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verified, 1);
});

// What CI adds on top: a claim pull request touches its own entry and nothing
// else, and policy changes stay with the trusted authors.

test("a claim pull request that touches scripts is refused", () => {
  fails({ [claimFile("jane")]: entry() }, /only a trusted author can change this/, {
    ...PR,
    CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "scripts/validate.js"]),
  });
});

test("a contributor may fix a typo in the documentation", () => {
  passes({ [claimFile("jane")]: entry() }, {
    ...PR,
    CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "README.md"]),
  });
});

test("a crowd of entries in one pull request is a note", () => {
  const files = { a: entry(), b: entry(), c: entry(), d: entry(), e: entry() };
  const entries = Object.fromEntries(Object.entries(files).map(([label, body]) => [claimFile(label), body]));
  const result = passes(entries, { ...PR, CHANGED_FILES: JSON.stringify(Object.keys(entries).map((f) => `domains/${f}`)) });
  assert.match(result.out, /splitting them makes the review shorter/);
});

test("a stranger cannot grant themselves trust", () => {
  fails(
    { [claimFile("jane")]: entry() },
    /only an admin can grant trust/,
    { ...PR, CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "registry/trusted.json"]) },
    { base: { trusted: TRUSTED }, trusted: [...TRUSTED, { username: "jisoa", id: 9001 }] },
  );
});

test("a stranger cannot drop a blocked word", () => {
  fails(
    { [claimFile("jane")]: entry() },
    /only a trusted author can loosen/,
    { ...PR, CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "registry/blocked.json"]) },
    { base: { blocked: [...BLOCKED, "outlook"] }, blocked: BLOCKED },
  );
});

test("a trusted author may change the policy lists", () => {
  passes(
    { [claimFile("jane")]: entry() },
    {
      PR_AUTHOR: "hisokalabs",
      PR_AUTHOR_ID: "103969998",
      CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "registry/reserved.json"]),
    },
    { base: { reserved: [...RESERVED, "blog"] }, reserved: RESERVED },
  );
});

test("the report carries its marker and explains a failure", () => {
  const dir = makeRegistry({ [claimFile("www")]: entry() });
  const result = run(dir, {}, "report.js");
  cleanup(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /<!-- registry-validator -->/);
  assert.match(result.stdout, /Registry check needs a change/);
  assert.match(result.stdout, /Pick a personal handle/);
});

test("the report stays quiet about a clean registry", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  const result = run(dir, {}, "report.js");
  cleanup(dir);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Registry check passed/);
});

test("the real registry in this repository passes", () => {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "validate.js")], { cwd: REPO, encoding: "utf8" });
  assert.equal(result.status, 0, `the shipped registry must pass:\n${result.stdout}${result.stderr}`);
});

// The bypass labels are how a maintainer loosens one pull request without
// editing the rules, which is the part of the is-a-dev pattern worth copying.

test("a maintainer label lets a claim touch scripts, and says so", () => {
  const result = passes(
    { [claimFile("jane")]: entry() },
    { ...PR, PR_LABELS: '["ci: bypass-scope"]', CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "scripts/validate.js"]) },
  );
  assert.match(result.out, /bypass-scope is set/);
});

test("without the label the same pull request is refused", () => {
  fails({ [claimFile("jane")]: entry() }, /only a trusted author can change this/, {
    ...PR,
    PR_LABELS: "[]",
    CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "scripts/validate.js"]),
  });
});

test("an owner-check bypass lets one account file for another, with a note", () => {
  const result = passes(
    { [claimFile("jane")]: entry() },
    { ...PR, PR_AUTHOR: "someone-else", PR_AUTHOR_ID: "7331", PR_LABELS: '["ci: bypass-owner-check"]' },
  );
  assert.match(result.out, /bypass-owner-check/);
});

test("an unrelated label changes nothing", () => {
  fails({ [claimFile("jane")]: entry() }, /is not the account opening this pull request/, {
    ...PR,
    PR_AUTHOR: "someone-else",
    PR_AUTHOR_ID: "7331",
    PR_LABELS: '["subdomain","docs"]',
  });
});

test("a deleted file is recognised from DELETED_FILES, not the diff", () => {
  fails(
    { [claimFile("jane")]: entry() },
    /releasing it is their call/,
    {
      ...PR,
      PR_AUTHOR: "someone-else",
      PR_AUTHOR_ID: "7331",
      CHANGED_FILES: "[]",
      DELETED_FILES: JSON.stringify([`domains/${claimFile("jane")}`]),
    },
    { base: { domains: { [claimFile("jane")]: entry() } } },
  );
});

test("an author may delete their own entry", () => {
  passes(
    {},
    { ...PR, CHANGED_FILES: "[]", DELETED_FILES: JSON.stringify([`domains/${claimFile("jane")}`]) },
    { base: { domains: { [claimFile("jane")]: entry() } } },
  );
});
