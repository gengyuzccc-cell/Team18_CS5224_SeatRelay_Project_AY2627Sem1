// Shared by cross-workshop.js and hotspot.js. This file runs inside k6 (ES modules, no Node
// APIs): configuration from __ENV, the token cache and the scenario file via open(), the VU
// flow (read → REGISTER → poll → CANCEL_REGISTRATION → poll), custom metrics and the summary.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

/** Fixed client polling interval (plan §1.3: k6 polls every 200 ms to detect completion). */
export const POLL_INTERVAL_S = 0.2;

const target = __ENV.TARGET || 'local';

export const CONFIG = {
  target,
  api: (__ENV.TARGET_API || 'http://localhost:3000').replace(/\/+$/, ''),
  vus: Number(__ENV.VUS || 10),
  round: __ENV.ROUND || '1',
  warmup: __ENV.WARMUP || '30s',
  duration: __ENV.DURATION || '60s',
  /** Give up polling one command after this long (counted as settle_timeouts). */
  pollTimeoutMs: Number(__ENV.POLL_TIMEOUT_MS || 30000),
  /** Where handleSummary writes <scenario>-<vus>-<round>.json (must exist; k6 cannot mkdir). */
  outDir: (__ENV.OUT_DIR || 'results/loadtest').replace(/\/+$/, ''),
  tokenCache: __ENV.TOKEN_CACHE || `../.token-cache.${target}.json`,
  scenarioFile: __ENV.SCENARIO_FILE || `../.scenario.${target}.json`,
  /** Optional pause between iterations (seconds). */
  thinkTimeS: Number(__ENV.THINK_TIME_S || 0),
};

function readJson(path) {
  // open() is only allowed in the init context; a missing file is reported by setup() so
  // that `k6 inspect` works without any cache or scenario file.
  try {
    return JSON.parse(open(path));
  } catch (error) {
    return null;
  }
}

const tokenCache = readJson(CONFIG.tokenCache);
const scenarioFile = readJson(CONFIG.scenarioFile);

/** '30s' | '2m' | '1h30m' | '500ms' | '45' (seconds) → milliseconds. */
export function durationToMs(text) {
  const value = String(text).trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value) * 1000;
  }
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let match;
  let matched = false;
  while ((match = re.exec(value)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    total +=
      match[2] === 'ms'
        ? amount
        : match[2] === 's'
          ? amount * 1000
          : match[2] === 'm'
            ? amount * 60000
            : amount * 3600000;
  }
  if (!matched) {
    throw new Error(`cannot parse duration "${text}"`);
  }
  return total;
}

// Custom metrics are recorded for the measured phase only (warm-up samples are skipped), so
// the thresholds and the summary describe steady state. http_req_* metrics are tagged with
// kind (read | command | poll) and phase (warmup | measured) for the tagged thresholds.
export const metrics = {
  readMs: new Trend('read_ms', true),
  commandMs: new Trend('command_ms', true),
  pollMs: new Trend('poll_ms', true),
  settleMs: new Trend('settle_ms', true),
  serverSettleMs: new Trend('server_settle_ms', true),
  pollsPerCommand: new Trend('polls_per_command'),
  iterationsMeasured: new Counter('iterations_measured'),
  readsFailed: new Counter('reads_failed'),
  commandsFailed: new Counter('commands_failed'),
  commandsRejected: new Counter('commands_rejected'),
  settleTimeouts: new Counter('settle_timeouts'),
};

/**
 * Workshop ids of a scenario: WORKSHOP_IDS (JSON array or comma-separated list) when set,
 * otherwise the scenario file written by prepare.ts. WORKSHOP_COUNT keeps only the first N
 * (e.g. WORKSHOP_COUNT=5 runs cross-workshop over 5 of the 10 prepared workshops).
 */
export function workshopIdsFor(scenarioName) {
  let ids = [];
  const raw = (__ENV.WORKSHOP_IDS || '').trim();
  if (raw.length > 0) {
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      ids = Array.isArray(parsed) ? parsed.map(String) : [];
    } else {
      ids = raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }
  } else {
    const entry = scenarioFile && scenarioFile.scenarios && scenarioFile.scenarios[scenarioName];
    ids = entry && Array.isArray(entry.workshopIds) ? entry.workshopIds : [];
  }
  const count = Number(__ENV.WORKSHOP_COUNT || 0);
  return count > 0 ? ids.slice(0, count) : ids;
}

/** k6 options: one ramping scenario (warm-up ramp, then the measured plateau) + thresholds. */
export function buildOptions(scenarioName) {
  const scenarios = {};
  scenarios[scenarioName] = {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: CONFIG.warmup, target: CONFIG.vus },
      { duration: CONFIG.duration, target: CONFIG.vus },
    ],
    gracefulRampDown: '10s',
    gracefulStop: '30s',
  };
  return {
    scenarios,
    thresholds: {
      // plan §4 Performance: reads and 202s p95 < 1 s, client-observed settle p95 < 5 s, errors < 1 %
      'http_req_duration{kind:read,phase:measured}': ['p(95)<1000'],
      'http_req_duration{kind:command,phase:measured}': ['p(95)<1000'],
      read_ms: ['p(95)<1000'],
      command_ms: ['p(95)<1000'],
      settle_ms: ['p(95)<5000'],
      http_req_failed: ['rate<0.01'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    tags: {
      scenario_name: scenarioName,
      vus: String(CONFIG.vus),
      round: String(CONFIG.round),
      target,
    },
  };
}

function authHeaders(user) {
  return {
    authorization: `Bearer ${user.idToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

/** setup(): validates tokens, workshops and the API, returns the data every VU uses. */
export function setupScenario(scenarioName) {
  const users = tokenCache && Array.isArray(tokenCache.users) ? tokenCache.users : [];
  if (users.length === 0) {
    exec.test.abort(
      `token cache ${CONFIG.tokenCache} is missing or empty: run get-tokens-keycloak (local) or create-test-users (dev)`,
    );
  }
  if (users.length < CONFIG.vus) {
    exec.test.abort(
      `VUS=${CONFIG.vus} needs one account per VU but ${CONFIG.tokenCache} has ${users.length}`,
    );
  }
  // Only the accounts this run uses: VU n signs in as users[n − 1] and setup() as users[0]. The
  // cache is shared with tools/experiments, which appends its own accounts after these; their
  // expiry is irrelevant here (run-matrix pre-checks the same slice).
  const used = users.slice(0, Math.max(CONFIG.vus, 1));
  const now = Date.now();
  const stale = used.filter((user) => Date.parse(user.expiresAt) - 60000 < now);
  if (stale.length > 0) {
    exec.test.abort(
      `${stale.length} of the ${used.length} tokens VUS=${CONFIG.vus} uses in ${CONFIG.tokenCache} expire within a minute: mint them again`,
    );
  }
  const workshopIds = workshopIdsFor(scenarioName);
  if (workshopIds.length === 0) {
    exec.test.abort(
      `no workshop ids for ${scenarioName}: run prepare (writes ${CONFIG.scenarioFile}) or set WORKSHOP_IDS`,
    );
  }
  const health = http.get(`${CONFIG.api}/health`, { tags: { kind: 'setup' } });
  if (health.status !== 200) {
    exec.test.abort(`${CONFIG.api}/health → ${health.status}`);
  }
  for (const id of workshopIds) {
    const res = http.get(`${CONFIG.api}/workshops/${id}`, {
      headers: authHeaders(users[0]),
      tags: { kind: 'setup' },
    });
    if (res.status !== 200) {
      exec.test.abort(`workshop ${id} → ${res.status} (prepare again?)`);
    }
    const workshop = res.json('workshop');
    if (!workshop || workshop.status !== 'OPEN') {
      exec.test.abort(`workshop ${id} is ${workshop ? workshop.status : 'unknown'}, expected OPEN`);
    }
  }
  return { users, workshopIds, warmupMs: durationToMs(CONFIG.warmup), startedAt: Date.now() };
}

export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}

/** 'warmup' during the first WARMUP of the scenario, 'measured' afterwards. */
export function currentPhase(data) {
  const start = exec.scenario.startTime || data.startedAt;
  return Date.now() - start < data.warmupMs ? 'warmup' : 'measured';
}

/**
 * POST one command (202) and poll GET /commands/{id} every 200 ms until APPLIED / REJECTED.
 * Returns the terminal record, or null when the POST failed or the poll timed out.
 */
export function settleCommand(user, wsId, body, phase, type) {
  const measured = phase === 'measured';
  const headers = authHeaders(user);
  const commandId = uuid();
  const payload = Object.assign({ commandId }, body);
  const t0 = Date.now();
  const res = http.post(`${CONFIG.api}/workshops/${wsId}/commands`, JSON.stringify(payload), {
    headers,
    tags: { kind: 'command', phase, type },
  });
  const accepted = check(res, { 'command 202': (r) => r.status === 202 });
  if (measured) {
    metrics.commandMs.add(res.timings.duration, { type });
  }
  if (!accepted) {
    if (measured) {
      metrics.commandsFailed.add(1, { type, status: String(res.status) });
    }
    return null;
  }
  let record = null;
  let polls = 0;
  while (Date.now() - t0 < CONFIG.pollTimeoutMs) {
    sleep(POLL_INTERVAL_S);
    polls += 1;
    const poll = http.get(`${CONFIG.api}/commands/${commandId}`, {
      headers,
      tags: { kind: 'poll', phase },
    });
    if (measured) {
      metrics.pollMs.add(poll.timings.duration);
    }
    if (poll.status !== 200) {
      continue;
    }
    const status = poll.json('status');
    if (status === 'APPLIED' || status === 'REJECTED') {
      record = poll.json();
      break;
    }
  }
  if (record === null) {
    if (measured) {
      metrics.settleTimeouts.add(1, { type });
    }
    return null;
  }
  if (measured) {
    metrics.settleMs.add(Date.now() - t0, { type });
    metrics.pollsPerCommand.add(polls, { type });
    if (record.settledAt && record.acceptedAt) {
      metrics.serverSettleMs.add(
        Math.max(0, Date.parse(record.settledAt) - Date.parse(record.acceptedAt)),
        { type },
      );
    }
    if (record.status === 'REJECTED') {
      metrics.commandsRejected.add(1, { type, reason: String(record.reason || 'unknown') });
    }
  }
  return record;
}

/** One VU iteration against one workshop: read → REGISTER → CANCEL_REGISTRATION. */
export function runIteration(data, wsId) {
  const user = data.users[(exec.vu.idInTest - 1) % data.users.length];
  const phase = currentPhase(data);
  const measured = phase === 'measured';

  const read = http.get(`${CONFIG.api}/workshops/${wsId}`, {
    headers: authHeaders(user),
    tags: { kind: 'read', phase },
  });
  const readOk = check(read, { 'read 200': (r) => r.status === 200 });
  if (measured) {
    metrics.readMs.add(read.timings.duration);
    if (!readOk) {
      metrics.readsFailed.add(1, { status: String(read.status) });
    }
  }
  let sessionIds = [];
  if (readOk) {
    const sessions = read.json('sessions');
    if (Array.isArray(sessions)) {
      sessionIds = sessions.map((session) => session.id);
    }
  }
  if (sessionIds.length === 0) {
    sleep(1);
    return;
  }
  // Varied preferences: each VU starts its list at a different session.
  const offset = (exec.vu.idInTest - 1) % sessionIds.length;
  const acceptable = sessionIds.slice(offset).concat(sessionIds.slice(0, offset));

  settleCommand(user, wsId, { type: 'REGISTER', acceptable }, phase, 'REGISTER');
  settleCommand(user, wsId, { type: 'CANCEL_REGISTRATION' }, phase, 'CANCEL_REGISTRATION');

  if (measured) {
    metrics.iterationsMeasured.add(1);
  }
  if (CONFIG.thinkTimeS > 0) {
    sleep(CONFIG.thinkTimeS);
  }
}

function value(data, metric, key) {
  const entry = data.metrics[metric];
  if (!entry || !entry.values || entry.values[key] === undefined) {
    return undefined;
  }
  return entry.values[key];
}

function fmtMs(v) {
  return v === undefined ? '   -   ' : `${v.toFixed(1)} ms`;
}

function fmtCount(v) {
  return v === undefined ? '0' : String(v);
}

function thresholdLines(data) {
  const failed = [];
  for (const name of Object.keys(data.metrics)) {
    const thresholds = data.metrics[name].thresholds;
    if (!thresholds) {
      continue;
    }
    for (const expr of Object.keys(thresholds)) {
      if (!thresholds[expr].ok) {
        failed.push(`${name} ${expr}`);
      }
    }
  }
  return failed;
}

/** Compact text summary on stdout (the default k6 summary is replaced by handleSummary). */
export function textSummary(data) {
  const meta = data.seatrelay || {};
  const failed = thresholdLines(data);
  const lines = [
    '',
    `seatrelay ${meta.scenario}  target=${meta.target} vus=${meta.vus} round=${meta.round}  warmup=${meta.warmup} measured=${meta.duration}  api=${meta.api}`,
    `  iterations ............ ${fmtCount(value(data, 'iterations', 'count'))} (measured ${fmtCount(value(data, 'iterations_measured', 'count'))})`,
    `  http_reqs ............. ${fmtCount(value(data, 'http_reqs', 'count'))}   failed ${((value(data, 'http_req_failed', 'rate') || 0) * 100).toFixed(2)} %`,
    `  read_ms   p50 / p95 ... ${fmtMs(value(data, 'read_ms', 'med'))} / ${fmtMs(value(data, 'read_ms', 'p(95)'))}`,
    `  command_ms (202) ...... ${fmtMs(value(data, 'command_ms', 'med'))} / ${fmtMs(value(data, 'command_ms', 'p(95)'))}`,
    `  poll_ms ............... ${fmtMs(value(data, 'poll_ms', 'med'))} / ${fmtMs(value(data, 'poll_ms', 'p(95)'))}`,
    `  settle_ms (client) .... ${fmtMs(value(data, 'settle_ms', 'med'))} / ${fmtMs(value(data, 'settle_ms', 'p(95)'))}`,
    `  server_settle_ms ...... ${fmtMs(value(data, 'server_settle_ms', 'med'))} / ${fmtMs(value(data, 'server_settle_ms', 'p(95)'))}`,
    `  polls per command avg . ${value(data, 'polls_per_command', 'avg') === undefined ? '-' : value(data, 'polls_per_command', 'avg').toFixed(2)}`,
    `  commands_failed ....... ${fmtCount(value(data, 'commands_failed', 'count'))}   rejected ${fmtCount(value(data, 'commands_rejected', 'count'))}   settle_timeouts ${fmtCount(value(data, 'settle_timeouts', 'count'))}`,
    `  thresholds ............ ${failed.length === 0 ? 'all passed' : `FAILED: ${failed.join('; ')}`}`,
    '',
  ];
  return lines.join('\n');
}

/** handleSummary: JSON to OUT_DIR/<scenario>-<vus>-<round>.json plus the text summary on stdout. */
export function makeSummaryHandler(scenarioName) {
  return function handleSummary(data) {
    const file = `${CONFIG.outDir}/${scenarioName}-${CONFIG.vus}-${CONFIG.round}.json`;
    const enriched = Object.assign({}, data, {
      seatrelay: {
        scenario: scenarioName,
        target,
        vus: CONFIG.vus,
        round: CONFIG.round,
        warmup: CONFIG.warmup,
        duration: CONFIG.duration,
        pollIntervalMs: POLL_INTERVAL_S * 1000,
        api: CONFIG.api,
        finishedAt: new Date().toISOString(),
      },
    });
    const out = {};
    out[file] = JSON.stringify(enriched, null, 2);
    out.stdout = textSummary(enriched);
    return out;
  };
}
