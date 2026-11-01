/* global __ENV -- provided by the k6 runtime */
// Load test for the public, read-only surface (infra/README.md, "Load test"). Run it through
// infra/load/run.sh, which pins the k6 image and keeps the report outside git (data/load/).
//
// What it does: ramps concurrent virtual users (VUs) up in steps, holds each step, and reports
// the first step whose p95 latency or error rate crosses the thresholds. Every VU is a visitor:
// it views pages with think time in between, now and then fetches the page's static assets as a
// first-time visitor would, and a share of the VUs watches the demo replay stream. Only GET
// requests, no account, no project, no live run.
//
// Configuration (all through -e NAME=value, set by run.sh from its environment):
//   BASE_URL        required; origin to test, e.g. https://evidomo.example
//   STEPS           VU steps, comma separated            default 50,100,250,500,750,1000
//   RAMP            ramp time into each step             default 30s
//   HOLD            hold time of each step               default 2m
//   P95_MS          p95 latency threshold, ms            default 1000
//   MAX_ERROR_RATE  error rate threshold                 default 0.01
//   SSE_SHARE       share of VUs on the replay stream    default 0.1
//   SSE_TTFB_MS     p95 time-to-first-byte of the stream default 1000
//   COLD_SHARE      share of page views that also fetch the page's assets (cold cache)
//                                                        default 0.2
//   THINK_MIN_S / THINK_MAX_S   pause between page views default 1 / 4
//   DEMO_RUN_ID     demo run to use                      default: the first of GET /api/demo/runs
//   STOP_AT_FIRST_FAIL=1  abort the test when a step crosses a threshold (default: go on, so the
//                   report shows how the service degrades)
//   REPORT_DIR      where handleSummary writes           default /out

import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const env = (name, fallback) =>
  __ENV[name] === undefined || __ENV[name] === '' ? fallback : __ENV[name];

const BASE_URL = env('BASE_URL', '').replace(/\/+$/, '');
const STEPS = env('STEPS', '50,100,250,500,750,1000')
  .split(',')
  .map((part) => Number.parseInt(part.trim(), 10));
const RAMP_S = seconds(env('RAMP', '30s'));
const HOLD_S = seconds(env('HOLD', '2m'));
const P95_MS = Number(env('P95_MS', '1000'));
const MAX_ERROR_RATE = Number(env('MAX_ERROR_RATE', '0.01'));
const SSE_SHARE = Number(env('SSE_SHARE', '0.1'));
const SSE_TTFB_MS = Number(env('SSE_TTFB_MS', '1000'));
const COLD_SHARE = Number(env('COLD_SHARE', '0.2'));
const THINK_MIN_S = Number(env('THINK_MIN_S', '1'));
const THINK_MAX_S = Number(env('THINK_MAX_S', '4'));
const STOP_AT_FIRST_FAIL = env('STOP_AT_FIRST_FAIL', '0') === '1';
const REPORT_DIR = env('REPORT_DIR', '/out');
const STREAM_SPEEDS = [0.5, 0.5, 0.5, 1, 2.5, 5]; // the API values behind 1x (default), 2x, 5x, 10x

if (BASE_URL === '')
  throw new Error('BASE_URL is required, e.g. -e BASE_URL=https://evidomo.example');
if (STEPS.length === 0 || STEPS.some((n) => !Number.isInteger(n) || n < 1)) {
  throw new Error(`STEPS must be positive integers, got "${env('STEPS', '')}"`);
}

function seconds(duration) {
  const match = /^(\d+)(s|m)$/.exec(duration);
  if (match === null) throw new Error(`Expected a duration such as 30s or 2m, got "${duration}"`);
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
}

// --- Metrics --------------------------------------------------------------------------------
// Own metrics instead of k6's http_req_*: those would mix the long-lived stream into the page
// latency and count a 429 as a failure. 429 (the per-IP limiter) is counted on its own and
// excluded from the error rate: it says the test measured the limiter, not the capacity.
const reqDuration = new Trend('req_duration', true);
const reqTtfb = new Trend('req_ttfb', true);
const reqBlocked = new Trend('req_blocked', true); // client side: waiting for a free socket + connect + TLS
const reqFailed = new Rate('req_failed');
const rateLimited = new Counter('rate_limited');
// k6 does not tag its own data_received with custom tags, so the per-step volume is the size of
// the decoded response bodies: an upper bound of the bytes on the wire (compression shrinks it).
const bodyBytes = new Counter('body_bytes');
const sseTtfb = new Trend('sse_ttfb', true);
const sseFailed = new Rate('sse_failed');
const sseCompleted = new Counter('sse_completed');

// --- Scenarios ------------------------------------------------------------------------------
function stagesFor(share) {
  const stages = [];
  for (const target of STEPS) {
    stages.push({ duration: `${RAMP_S}s`, target: Math.round(target * share) });
    stages.push({ duration: `${HOLD_S}s`, target: Math.round(target * share) });
  }
  return stages;
}

const scenarios = {
  browse: {
    executor: 'ramping-vus',
    exec: 'browse',
    startVUs: 0,
    stages: stagesFor(1 - SSE_SHARE),
    gracefulRampDown: '30s',
    gracefulStop: '30s',
  },
};
if (SSE_SHARE > 0) {
  scenarios.stream = {
    executor: 'ramping-vus',
    exec: 'stream',
    startVUs: 0,
    stages: stagesFor(SSE_SHARE),
    gracefulRampDown: '30s',
    gracefulStop: '60s', // a replay at 1x takes about 11 s; let running ones end
  };
}

// Thresholds exist per step so that k6 builds the per-step sub-metrics handleSummary reads, and
// so that the exit code is 99 when a step crosses one. Empty lists only create the sub-metric.
function abortable(threshold) {
  return STOP_AT_FIRST_FAIL ? { threshold, abortOnFail: true, delayAbortEval: '20s' } : threshold;
}
const thresholds = {};
for (const step of STEPS) {
  thresholds[`req_duration{step:${step}}`] = [abortable(`p(95)<${P95_MS}`)];
  thresholds[`req_failed{step:${step}}`] = [abortable(`rate<${MAX_ERROR_RATE}`)];
  thresholds[`req_ttfb{step:${step}}`] = [];
  thresholds[`req_blocked{step:${step}}`] = [];
  thresholds[`rate_limited{step:${step}}`] = [];
  thresholds[`http_reqs{step:${step}}`] = [];
  thresholds[`body_bytes{step:${step}}`] = [];
  if (SSE_SHARE > 0) {
    thresholds[`sse_ttfb{step:${step}}`] = [abortable(`p(95)<${SSE_TTFB_MS}`)];
    thresholds[`sse_failed{step:${step}}`] = [abortable(`rate<${MAX_ERROR_RATE}`)];
    thresholds[`sse_completed{step:${step}}`] = [];
  }
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
  userAgent: 'evidomo-load-test/1',
};

// --- Timeline -------------------------------------------------------------------------------
// The step a request belongs to follows from the time since the scenario started: the ramp into
// a step is tagged "ramp" and is not judged, the hold is tagged with the step's VU count.
function currentStep() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  const index = Math.floor(elapsed / (RAMP_S + HOLD_S));
  if (index >= STEPS.length) return 'down';
  return elapsed - index * (RAMP_S + HOLD_S) < RAMP_S ? 'ramp' : String(STEPS[index]);
}

// --- Setup ----------------------------------------------------------------------------------
export function setup() {
  const health = http.get(`${BASE_URL}/api/healthz`);
  if (health.status !== 200) {
    throw new Error(`GET ${BASE_URL}/api/healthz answered ${health.status}; is BASE_URL right?`);
  }
  let runId = env('DEMO_RUN_ID', '');
  if (runId === '') {
    const list = http.get(`${BASE_URL}/api/demo/runs`);
    if (list.status !== 200) throw new Error(`GET /api/demo/runs answered ${list.status}`);
    const runs = list.json('runs');
    if (!Array.isArray(runs) || runs.length === 0) {
      throw new Error(
        'No demo run is published (DEMO_RUN_IDS is empty); see infra/README.md, "Demo run".',
      );
    }
    runId = runs[0].id;
  }
  return { runId };
}

// --- Visitors -------------------------------------------------------------------------------
const HEADERS = { 'Accept-Language': 'en', 'Accept-Encoding': 'gzip, br' };

function record(res, route, step) {
  const tags = { step, route };
  if (res.status === 429) {
    rateLimited.add(1, { step });
    return;
  }
  reqFailed.add(res.status < 200 || res.status >= 400, { step });
  reqDuration.add(res.timings.duration, tags);
  reqTtfb.add(res.timings.waiting, { step });
  if (typeof res.body === 'string') bodyBytes.add(res.body.length, { step });
  reqBlocked.add(res.timings.blocked + res.timings.connecting + res.timings.tls_handshaking, {
    step,
  });
}

function get(path, route, step) {
  const res = http.get(`${BASE_URL}${path}`, { headers: HEADERS, tags: { step, route } });
  record(res, route, step);
  return res;
}

// The page's own scripts, styles, and fonts (what a browser with an empty cache requests),
// fetched in parallel like a browser does.
function fetchAssets(html, step) {
  const paths = [
    ...new Set([...html.matchAll(/["'](\/_next\/static\/[^"']+)["']/g)].map((m) => m[1])),
  ];
  if (paths.length === 0) return;
  const responses = http.batch(
    paths.map((path) => [
      'GET',
      `${BASE_URL}${path}`,
      null,
      { headers: HEADERS, tags: { step, route: 'asset' } },
    ]),
  );
  for (const res of responses) record(res, 'asset', step);
}

function pick(weighted) {
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return weighted[weighted.length - 1];
}

// Weights follow what a visitor does: the landing pages and the demo are the front door; the
// demo run page is the main attraction and loads its snapshot from the API; /api/healthz stands
// for uptime monitors.
const VIEWS = [
  { weight: 20, route: 'landing', path: () => '/', page: true },
  { weight: 10, route: 'landing_tr', path: () => '/tr', page: true },
  { weight: 10, route: 'method', path: () => '/method', page: true },
  { weight: 15, route: 'demo', path: () => '/demo', page: true, api: () => ['/api/demo/runs'] },
  {
    weight: 35,
    route: 'demo_run',
    path: (data) => `/demo/runs/${data.runId}`,
    page: true,
    api: (data) => [`/api/demo/runs/${data.runId}`],
  },
  { weight: 10, route: 'healthz', path: () => '/api/healthz', page: false },
];

export function browse(data) {
  const step = currentStep();
  const view = pick(VIEWS);
  const res = get(view.path(data), view.route, step);
  if (view.page && res.status === 200) {
    if (Math.random() < COLD_SHARE) fetchAssets(res.body, step);
    for (const path of view.api === undefined ? [] : view.api(data))
      get(path, `api_${view.route}`, step);
  }
  sleep(THINK_MIN_S + Math.random() * (THINK_MAX_S - THINK_MIN_S));
}

export function stream(data) {
  const step = currentStep();
  const speed = STREAM_SPEEDS[Math.floor(Math.random() * STREAM_SPEEDS.length)];
  const res = http.get(`${BASE_URL}/api/demo/runs/${data.runId}/events?speed=${speed}`, {
    headers: { Accept: 'text/event-stream' },
    tags: { step, route: 'sse' },
    timeout: '120s',
  });
  if (res.status === 429) {
    rateLimited.add(1, { step });
  } else {
    const completed =
      res.status === 200 && typeof res.body === 'string' && res.body.includes('event: end');
    sseFailed.add(!completed, { step });
    if (res.status === 200) sseTtfb.add(res.timings.waiting, { step });
    if (completed) sseCompleted.add(1, { step });
  }
  sleep(1 + Math.random() * 3);
}

// --- Report ---------------------------------------------------------------------------------
function values(data, name) {
  const metric = data.metrics[name];
  return metric === undefined ? undefined : metric.values;
}

function stepReport(data, step) {
  const tag = `{step:${step}}`;
  const duration = values(data, `req_duration${tag}`);
  const failed = values(data, `req_failed${tag}`);
  const received = values(data, `body_bytes${tag}`);
  const requests = values(data, `http_reqs${tag}`);
  const ttfb = values(data, `req_ttfb${tag}`);
  const blocked = values(data, `req_blocked${tag}`);
  const limited = values(data, `rate_limited${tag}`);
  const sse = values(data, `sse_ttfb${tag}`);
  const sseFail = values(data, `sse_failed${tag}`);
  const sseDone = values(data, `sse_completed${tag}`);
  const report = {
    step,
    requests: requests === undefined ? 0 : requests.count,
    requestsPerSecond: requests === undefined ? 0 : round(requests.count / HOLD_S),
    p95Ms: duration === undefined ? null : round(duration['p(95)']),
    p99Ms: duration === undefined ? null : round(duration['p(99)']),
    ttfbP95Ms: ttfb === undefined ? null : round(ttfb['p(95)']),
    clientBlockedP95Ms: blocked === undefined ? null : round(blocked['p(95)']),
    errorRate: failed === undefined ? null : round(failed.rate, 4),
    rateLimited: limited === undefined ? 0 : limited.count,
    decodedMbitPerSecond: received === undefined ? 0 : round((received.count * 8) / HOLD_S / 1e6),
    streamTtfbP95Ms: sse === undefined ? null : round(sse['p(95)']),
    streamErrorRate: sseFail === undefined ? null : round(sseFail.rate, 4),
    streamsCompleted: sseDone === undefined ? 0 : sseDone.count,
  };
  const reasons = [];
  if (report.p95Ms === null) reasons.push('no requests recorded');
  if (report.p95Ms !== null && report.p95Ms > P95_MS)
    reasons.push(`p95 ${report.p95Ms} ms > ${P95_MS} ms`);
  if (report.errorRate !== null && report.errorRate > MAX_ERROR_RATE) {
    reasons.push(`error rate ${(report.errorRate * 100).toFixed(2)}% > ${MAX_ERROR_RATE * 100}%`);
  }
  if (SSE_SHARE > 0 && report.streamTtfbP95Ms !== null && report.streamTtfbP95Ms > SSE_TTFB_MS) {
    reasons.push(`stream ttfb p95 ${report.streamTtfbP95Ms} ms > ${SSE_TTFB_MS} ms`);
  }
  if (report.streamErrorRate !== null && report.streamErrorRate > MAX_ERROR_RATE) {
    reasons.push(
      `stream error rate ${(report.streamErrorRate * 100).toFixed(2)}% > ${MAX_ERROR_RATE * 100}%`,
    );
  }
  return { ...report, passed: reasons.length === 0, reasons };
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function handleSummary(data) {
  const steps = STEPS.map((step) => stepReport(data, String(step)));
  // Steps the test never reached (aborted early) have no data; they are not "passed".
  const reached = steps.filter((s) => s.requests > 0);
  const firstFailing = reached.find((s) => !s.passed);
  const totalLimited = steps.reduce((sum, s) => sum + s.rateLimited, 0);
  const lastStep = STEPS[STEPS.length - 1];
  const verdict =
    firstFailing !== undefined
      ? `First failing step: ${firstFailing.step} VUs (${firstFailing.reasons.join('; ')})`
      : reached.length === steps.length
        ? `${String(lastStep).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} passed`
        : `Stopped before ${lastStep} (${reached.length} of ${steps.length} steps reached), no step failed`;

  const lines = [
    '',
    `Load test of ${BASE_URL}`,
    `Thresholds: p95 <= ${P95_MS} ms, error rate <= ${MAX_ERROR_RATE * 100}%, stream ttfb p95 <= ${SSE_TTFB_MS} ms; ${HOLD_S}s hold per step`,
    '',
    'step   req/s   p95 ms   p99 ms  ttfb95  blocked95   err %  429s dMbit/s  stream ttfb95  verdict',
  ];
  for (const s of steps) {
    const cell = (value, width) => String(value === null ? '-' : value).padStart(width);
    lines.push(
      [
        cell(s.step, 4),
        cell(s.requestsPerSecond, 7),
        cell(s.p95Ms, 8),
        cell(s.p99Ms, 8),
        cell(s.ttfbP95Ms, 7),
        cell(s.clientBlockedP95Ms, 10),
        cell(s.errorRate === null ? null : round(s.errorRate * 100, 2), 7),
        cell(s.rateLimited, 5),
        cell(s.decodedMbitPerSecond, 7),
        cell(s.streamTtfbP95Ms, 14),
        s.requests === 0
          ? '  not reached'
          : s.passed
            ? s.rateLimited > 0
              ? '  pass, but limited (429)'
              : '  pass'
            : '  FAIL',
      ].join(' '),
    );
  }
  lines.push('', verdict);
  if (totalLimited > 0) {
    lines.push(
      '',
      `WARNING: ${totalLimited} requests were answered 429 by the per-IP limiter and left out of the error rate.`,
      'The affected routes measured the limiter, not capacity. Raise DEMO_REQUESTS_PER_IP_PER_15_MIN and',
      'DEMO_STREAMS_PER_IP on the server for the test window (infra/README.md, "Load test").',
    );
  }
  lines.push(
    '',
    'Client or server bottleneck? Client side if "blocked95" climbs while "ttfb95" stays flat, if dMbit/s',
    'plateaus while VUs grow, or if the k6 host is near 100% CPU. See infra/README.md, "Load test".',
    '',
  );
  const text = lines.join('\n');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    stdout: text,
    [`${REPORT_DIR}/load-${stamp}.txt`]: text,
    [`${REPORT_DIR}/load-${stamp}.json`]: JSON.stringify(
      {
        baseUrl: BASE_URL,
        finishedAt: new Date().toISOString(),
        config: {
          STEPS,
          RAMP_S,
          HOLD_S,
          P95_MS,
          MAX_ERROR_RATE,
          SSE_SHARE,
          SSE_TTFB_MS,
          COLD_SHARE,
        },
        verdict,
        rateLimitedTotal: totalLimited,
        steps,
      },
      null,
      2,
    ),
  };
}
