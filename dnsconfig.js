var REG_NONE = NewRegistrar('none');
var DNS_PROVIDER = DnsProvider(NewDnsProvider('cloudflare'));

var PROXY = {
	on: { cloudflare_proxy: 'on' },
	off: { cloudflare_proxy: 'off' },
};

var GITHUB_PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
var GITHUB_PAGES_AAAA = ['2606:50c1:8000::153', '2606:50c1:8001::153', '2606:50c1:8002::153', '2606:50c1:8003::153'];

/**
 * The zone list comes from registry/zones.json, the same file the validator
 * reads. A zone cannot be declared here and refused there.
 */
function loadZones() {
	var list = require('./registry/zones.json');
	if (!list || !list.length) {
		throw new Error('dnsconfig: registry/zones.json lists no zones, refusing to push');
	}
	return list.map(function (zone) {
		return String(zone).toLowerCase();
	});
}

/**
 * Every JSON file in domains/ is a claim and its filename is the record name.
 * Renaming the file is the only way to move a claim.
 */
function readClaims(zones) {
	var claims = [];
	var files = glob.apply(null, ['./domains', false, '.json']);

	files.forEach(function (file) {
		var base = file.split('/').pop().split('\\').pop();

		for (var i = 0; i < zones.length; i += 1) {
			var suffix = '.' + zones[i] + '.json';
			if (base.slice(-suffix.length) !== suffix) continue;

			var subdomain = base.slice(0, -suffix.length);
			if (!subdomain) return;

			try {
				var normalized = file.indexOf('.') === 0 || file.indexOf('/') === 0 || file.indexOf('\\') === 0 || file.indexOf(':') === 1
					? file
					: './' + file;
				claims.push({ file: file, subdomain: subdomain, zone: zones[i], data: require(normalized) });
			} catch (error) {
				console.error('dnsconfig: error loading ' + file + ': ' + error);
			}
			return;
		}

		console.error('dnsconfig: skipping ' + file + ', its filename names no managed zone');
	});

	return claims;
}

var ZONES = loadZones();
var claims = readClaims(ZONES);

var recordsByZone = {};

function addRecord(zone, record) {
	if (!recordsByZone[zone]) {
		recordsByZone[zone] = [];
	}
	recordsByZone[zone].push(record);
}

function fqdn(target) {
	return target.slice(-1) === '.' ? target : target + '.';
}

/** The validator accepts one value where a list also works; read both. */
function list(value) {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

/** A bare MX hostname gets priority 10. */
function mxParts(value) {
	if (typeof value === 'string') {
		var parts = value.trim().split(/\s+/);
		if (parts.length === 2 && /^\d+$/.test(parts[0])) {
			return { priority: Number(parts[0]), target: parts[1] };
		}
		return { priority: 10, target: value.trim() };
	}
	return { priority: value.priority === undefined ? 10 : value.priority, target: value.target };
}

/** SRV fields default to 0, which keeps a bare target publishable. */
function srvParts(value) {
	if (typeof value === 'string') {
		var parts = value.trim().split(/\s+/);
		if (parts.length === 4) {
			return { priority: Number(parts[0]), weight: Number(parts[1]), port: Number(parts[2]), target: parts[3] };
		}
		return { priority: 0, weight: 0, port: 0, target: value.trim() };
	}
	return {
		priority: value.priority === undefined ? 0 : value.priority,
		weight: value.weight === undefined ? 0 : value.weight,
		port: value.port === undefined ? 0 : value.port,
		target: value.target,
	};
}

claims.forEach(function (claim) {
	var data = claim.data || {};
	var zone = claim.zone;
	var name = claim.subdomain;
	var proxy = data.proxied === true ? PROXY.on : PROXY.off;
	var records = data.records;

	if (!records || Object.keys(records).length === 0) {
		// No records key means GitHub Pages. The proxy stays off because proxying
		// breaks Pages certificate issuance.
		GITHUB_PAGES_A.forEach(function (ip) {
			addRecord(zone, A(name, ip, PROXY.off));
		});
		GITHUB_PAGES_AAAA.forEach(function (ip6) {
			addRecord(zone, AAAA(name, ip6, PROXY.off));
		});
		return;
	}

	list(records.A).forEach(function (ip) {
		addRecord(zone, A(name, ip, proxy));
	});

	list(records.AAAA).forEach(function (ip6) {
		addRecord(zone, AAAA(name, ip6, proxy));
	});

	list(records.CNAME).forEach(function (target) {
		addRecord(zone, CNAME(name, fqdn(target), proxy));
	});

	list(records.TXT).forEach(function (txt) {
		addRecord(zone, TXT(name, txt));
	});

	list(records.MX).forEach(function (mx) {
		var parts = mxParts(mx);
		addRecord(zone, MX(name, parts.priority, fqdn(parts.target)));
	});

	list(records.NS).forEach(function (ns) {
		addRecord(zone, NS(name, fqdn(ns)));
	});

	list(records.SRV).forEach(function (srv) {
		var parts = srvParts(srv);
		addRecord(zone, SRV(name, parts.priority, parts.weight, parts.port, fqdn(parts.target)));
	});

	list(records.CAA).forEach(function (caa) {
		addRecord(zone, CAA(name, caa.flag === undefined ? 0 : caa.flag, caa.tag, caa.value));
	});

	list(records.PTR).forEach(function (ptr) {
		addRecord(zone, PTR(name, fqdn(ptr)));
	});
});

/**
 * A reserved name is managed by hand in the Cloudflare dashboard and this script
 * must never touch it. Without the IGNORE, purge mode deletes it.
 */
function reservedGuard(zone, records) {
	var reserved = require('./registry/reserved.json');
	var claimed = {};

	claims.forEach(function (claim) {
		if (claim.zone === zone) claimed[claim.subdomain] = true;
	});

	reserved.forEach(function (label) {
		if (!claimed[label]) records.push(IGNORE(label));
	});

	return records;
}

Object.keys(recordsByZone).forEach(function (zone) {
	D(zone, REG_NONE, DNS_PROVIDER, reservedGuard(zone, recordsByZone[zone]));
});
