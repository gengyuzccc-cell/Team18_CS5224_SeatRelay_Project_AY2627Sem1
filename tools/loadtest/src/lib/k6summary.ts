/**
 * The JSON `handleSummary` writes (`scripts/lib.js`): k6's end-of-test summary plus a
 * `seatrelay` block with the run parameters. `parseK6Summary` reduces it to one CSV row.
 */
export interface K6MetricSummary {
  type: 'trend' | 'counter' | 'rate' | 'gauge';
  contains?: string;
  values: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
}

export interface K6Summary {
  metrics: Record<string, K6MetricSummary>;
  seatrelay?: {
    scenario: string;
    target: string;
    vus: number;
    round: string | number;
    warmup: string;
    duration: string;
    pollIntervalMs?: number;
    api: string;
    finishedAt: string;
  };
}

export interface RunRow {
  /**
   * The run-matrix invocation that produced the row (`invocationId`); its k6 summary and log
   * live in `k6/<target>/<runId>/` and `logs/<target>/<runId>/`.
   */
  runId?: string;
  scenario: string;
  target: string;
  vus: number;
  round: number;
  startedAt: string;
  measuredStart: string;
  endedAt: string;
  /** k6 durations of the run (`WARMUP`, `DURATION`). */
  warmup: string;
  duration: string;
  /** Short git commit of the code under test (plan §3 step 21: record the commit per run). */
  commit?: string;
  iterations: number;
  iterationsMeasured: number;
  httpReqs: number;
  /** 0–1 */
  httpReqFailedRate: number;
  readP50?: number;
  readP95?: number;
  commandP50?: number;
  commandP95?: number;
  pollP50?: number;
  pollP95?: number;
  settleP50?: number;
  settleP95?: number;
  serverSettleP50?: number;
  serverSettleP95?: number;
  pollsPerCommandAvg?: number;
  commandsFailed: number;
  commandsRejected: number;
  settleTimeouts: number;
  thresholdsOk: boolean;
  failedThresholds: string[];
  /**
   * CloudWatch (dev/pilot only), over the whole minutes `cwWindowStart`–`cwWindowEnd` of the
   * measured phase: SQS maxima, and the worker's server-side `CommandSettledLatency` p95 and
   * sample count over the window (every command of the stage, not only k6's).
   */
  sqsDepthMax?: number;
  sqsOldestAgeMax?: number;
  cwSettleP95?: number;
  cwSettleCount?: number;
  cwWindowStart?: string;
  cwWindowEnd?: string;
  exitCode?: number;
  /** Paths relative to the results directory. */
  summaryFile?: string;
  logFile?: string;
  /**
   * Set when a later invocation re-ran the same target / scenario / VUs / round: the row is
   * kept (raw.csv, runs.json, "Superseded runs" in summary.md) but left out of the tables.
   */
  supersededBy?: string;
  note?: string;
}

export interface RunMeta {
  runId?: string;
  scenario: string;
  target: string;
  vus: number;
  round: number;
  startedAt: string;
  measuredStart: string;
  endedAt: string;
  warmup: string;
  duration: string;
  commit?: string;
  exitCode?: number;
  summaryFile?: string;
  logFile?: string;
}

export function metricValue(summary: K6Summary, metric: string, key: string): number | undefined {
  const value = summary.metrics[metric]?.values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function failedThresholds(summary: K6Summary): string[] {
  const failed: string[] = [];
  for (const [name, metric] of Object.entries(summary.metrics)) {
    for (const [expr, result] of Object.entries(metric.thresholds ?? {})) {
      if (!result.ok) {
        failed.push(`${name} ${expr}`);
      }
    }
  }
  return failed;
}

export function isK6Summary(value: unknown): value is K6Summary {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as K6Summary).metrics === 'object' &&
    (value as K6Summary).metrics !== null
  );
}

/** One run → one row. Trend `med` is p50; `p(95)` is p95. */
export function parseK6Summary(summary: K6Summary, meta: RunMeta): RunRow {
  const failed = failedThresholds(summary);
  const row: RunRow = {
    ...meta,
    iterations: metricValue(summary, 'iterations', 'count') ?? 0,
    iterationsMeasured: metricValue(summary, 'iterations_measured', 'count') ?? 0,
    httpReqs: metricValue(summary, 'http_reqs', 'count') ?? 0,
    httpReqFailedRate: metricValue(summary, 'http_req_failed', 'rate') ?? 0,
    commandsFailed: metricValue(summary, 'commands_failed', 'count') ?? 0,
    commandsRejected: metricValue(summary, 'commands_rejected', 'count') ?? 0,
    settleTimeouts: metricValue(summary, 'settle_timeouts', 'count') ?? 0,
    thresholdsOk: failed.length === 0,
    failedThresholds: failed,
  };
  const optional: [keyof RunRow, string, string][] = [
    ['readP50', 'read_ms', 'med'],
    ['readP95', 'read_ms', 'p(95)'],
    ['commandP50', 'command_ms', 'med'],
    ['commandP95', 'command_ms', 'p(95)'],
    ['pollP50', 'poll_ms', 'med'],
    ['pollP95', 'poll_ms', 'p(95)'],
    ['settleP50', 'settle_ms', 'med'],
    ['settleP95', 'settle_ms', 'p(95)'],
    ['serverSettleP50', 'server_settle_ms', 'med'],
    ['serverSettleP95', 'server_settle_ms', 'p(95)'],
    ['pollsPerCommandAvg', 'polls_per_command', 'avg'],
  ];
  for (const [field, metric, key] of optional) {
    const value = metricValue(summary, metric, key);
    if (value !== undefined) {
      (row as unknown as Record<string, number>)[field] = value;
    }
  }
  return row;
}
