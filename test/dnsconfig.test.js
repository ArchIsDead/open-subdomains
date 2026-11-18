"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");

const { fold, parseClaimFile, isZoneWide, isAuxiliary, reservedWord } = require(path.join(REPO, "scripts", "registry.js"));

function registry(files, zones = ["is-a.ceo"], reserved = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnsconfig-"));
  fs.mkdirSync(path.join(dir, "registry"));
  fs.writeFileSync(path.join(dir, "registry", "zones.json"), JSON.stringify(zones));
  fs.writeFileSync(path.join(dir, "registry", "reserved.json"), JSON.stringify(reserved));
  fs.copyFileSync(path.join(REPO, "dnsconfig.js"), path.join(dir, "dnsconfig.js"));
  fs.mkdirSync(path.join(dir, "domains"));
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "domains", file), JSON.stringify(content));
  }
  return dir;
}

function load(dir) {
  const zones = {};
  const saved = {};
  const names = ["NewRegistrar", "DnsProvider", "NewDnsProvider", "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR", "D", "glob", "IGNORE"];

  for (const name of names) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);

  globalThis.NewRegistrar = () => ({});
  globalThis.DnsProvider = () => ({});
  globalThis.NewDnsProvider = () => ({});
  globalThis.A = (name, value, meta) => ["A", name, value, meta];
  globalThis.AAAA = (name, value, meta) => ["AAAA", name, value, meta];
  globalThis.CNAME = (name, value, meta) => ["CNAME", name, value, meta];
  globalThis.TXT = (name, value) => ["TXT", name, value];
  globalThis.MX = (name, priority, target) => ["MX", name, priority, target];
  globalThis.NS = (name, target) => ["NS", name, target];
  globalThis.SRV = (name, priority, weight, port, target) => ["SRV", name, priority, weight, port, target];
  globalThis.CAA = (name, flag, tag, value) => ["CAA", name, flag, tag, value];
  globalThis.PTR = (name, target) => ["PTR", name, target];
  globalThis.IGNORE = (name) => ["IGNORE", name];
  globalThis.D = (zone, registrar, provider, records) => {
    zones[String(zone).toLowerCase()] = records;
  };
  globalThis.glob = (startPath, recursive, extension) => {
    const root = path.resolve(dir, startPath);
    const out = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (extension && extension !== "*" && path.extname(entry.name) !== extension) continue;
      out.push(path.join("domains", entry.name));
    }
    return out.sort();
  };

  try {
    const file = path.join(dir, "dnsconfig.js");
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    for (const name of names) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }

  return zones;
}

function recordsOf(zones, zone = "is-a.ceo") {
  return zones[zone] || [];
}

function only(records, kind) {
  return records.filter((record) => record[0] === kind);
}

test("an entry without records gets the GitHub Pages addresses", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(only(records, "A").length, 4);
  assert.equal(only(records, "AAAA").length, 4);
});

test("an empty records object also gets the Pages addresses", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: {} } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(only(records, "A").length, 4);
});

test("a scalar A value is published as one record", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { A: "203.0.113.9" } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "A").map((r) => r[2]), ["203.0.113.9"]);
});

test("a scalar CNAME is published as one record with a trailing dot", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { CNAME: "jane.pages.dev" } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "CNAME").map((r) => r[2]), ["jane.pages.dev."]);
});

test("an MX hostname gets priority 10", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { MX: ["mx.example.net"] } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "MX").map((r) => [r[2], r[3]]), [[10, "mx.example.net."]]);
});

test("an MX string with a priority keeps it", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { MX: ["20 mx.example.net"] } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "MX").map((r) => [r[2], r[3]]), [[20, "mx.example.net."]]);
});

test("an MX object without a priority gets 10", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { MX: [{ target: "mx.example.net" }] } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "MX").map((r) => [r[2], r[3]]), [[10, "mx.example.net."]]);
});

test("an SRV string carries all four fields", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { SRV: ["0 5 25565 mc.example.net"] } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "SRV").map((r) => r.slice(2)), [[0, 5, 25565, "mc.example.net."]]);
});

test("an SRV object defaults the numbers to 0", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { SRV: [{ target: "mc.example.net" }] } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "SRV").map((r) => r.slice(2)), [[0, 0, 0, "mc.example.net."]]);
});

test("CAA defaults its flag to 0", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { CAA: [{ tag: "issue", value: "letsencrypt.org" }] } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "CAA").map((r) => r.slice(2)), [[0, "issue", "letsencrypt.org"]]);
});

test("a scalar TXT is published", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { TXT: "v=spf1 -all" } } });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "TXT").map((r) => r[2]), ["v=spf1 -all"]);
});

test("a reserved name with no entry is left alone", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" } } }, ["is-a.ceo"], ["www", "docs"]);
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "IGNORE").map((r) => r[1]).sort(), ["docs", "www"]);
});

test("a reserved label with no claim is ignored", () => {
  const dir = registry({ "jane.is-a.ceo.json": { owner: { username: "jane" } } }, ["is-a.ceo"], ["_vercel"]);
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(only(records, "IGNORE").map((r) => r[1]), ["_vercel"]);
});

test("a sidecar publishes only on its own name", () => {
  const dir = registry({
    "jane.is-a.ceo.json": { owner: { username: "jane" }, records: { CNAME: "jane.pages.dev" } },
    "_vercel.jane.is-a.ceo.json": { owner: { username: "jane" }, records: { TXT: "vc-domain-verify=jane.is-a.ceo,abc" } },
  });
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  const txt = only(records, "TXT");
  assert.equal(txt.length, 1);
  assert.equal(txt[0][1], "_vercel.jane");
  assert.equal(txt[0][2], "vc-domain-verify=jane.is-a.ceo,abc");
  assert.equal(txt.filter((r) => r[1] === "_vercel").length, 0);
});

test("a reserved label that is also claimed is published, not ignored", () => {
  const dir = registry({
    "_dmarc.is-a.ceo.json": { owner: { username: "jane" }, records: { TXT: "v=DMARC1; p=none" } },
  }, ["is-a.ceo"], ["_dmarc"]);
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(only(records, "IGNORE").length, 0);
  assert.deepEqual(only(records, "TXT").map((r) => r[2]), ["v=DMARC1; p=none"]);
});

test("a sidecar does not overwrite a reserved service label", () => {
  const dir = registry({
    "jane.is-a.ceo.json": { owner: { username: "jane" } },
    "_dmarc.jane.is-a.ceo.json": { owner: { username: "jane" }, records: { TXT: "v=DMARC1; p=none" } },
  }, ["is-a.ceo"], ["_dmarc"]);
  const records = recordsOf(load(dir));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(only(records, "TXT").filter((r) => r[1] === "_dmarc").length, 0);
});

test("the fold maps leetspeak onto the plain word", () => {
  assert.equal(fold("m3"), "me");
  assert.equal(fold("d0cs"), "docs");
  assert.equal(fold("m_e"), "me");
  assert.equal(fold("meee"), "me");
});

test("the fold leaves ordinary names alone", () => {
  assert.equal(fold("jane"), "jane");
  assert.equal(fold("dikaardnt"), "dikaardnt");
});

test("a filename is read as a name and a zone", () => {
  assert.deepEqual(parseClaimFile("jane.is-a.ceo.json", ["is-a.ceo"]), { subdomain: "jane", zone: "is-a.ceo" });
  assert.deepEqual(parseClaimFile("_vercel.jane.is-a.ceo.json", ["is-a.ceo"]), { subdomain: "_vercel.jane", zone: "is-a.ceo" });
  assert.equal(parseClaimFile("jane.example.com.json", ["is-a.ceo"]), null);
});

test("zone-wide and auxiliary names are told apart", () => {
  assert.equal(isZoneWide("@"), true);
  assert.equal(isZoneWide("_dmarc"), true);
  assert.equal(isZoneWide("_vercel.jane"), false);
  assert.equal(isAuxiliary("_vercel.jane"), true);
  assert.equal(isAuxiliary("jane"), false);
});

test("only the exact reserved spelling matches", () => {
  const policy = { reserved: new Set(["www"]) };
  assert.equal(reservedWord("www", policy), "www");
  assert.equal(reservedWord("wwww", policy), null);
});
