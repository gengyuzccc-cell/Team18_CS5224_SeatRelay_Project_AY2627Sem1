import type { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { DashboardView, SessionView } from '@seatrelay/contracts';
import { ApiClient, type FetchLike } from '@seatrelay/scripts';
import { describe, expect, it } from 'vitest';
import { backfillLayout } from '../src/lib/backfillLayout';
import { DEFAULT_CAPACITIES, capacitiesFrom } from '../src/lib/capacities';
import { classifyEarly, consistentWithServerTime, relayOrder } from '../src/lib/expiryRace';
import {
  describeMetrics,
  getMetricData,
  lambdaQueries,
  metricId,
  seatRelayMetricSum,
  seatRelayQueries,
  sqsQueries,
  toMetricDataQuery,
} from '../src/lib/cloudwatch';
import { answerMatches, statusOf, tamperToken } from '../src/lib/httpProbe';
import { metricSum, metricsSection } from '../src/lib/metrics';
import {
  analyseWorkerTrace,
  commandTraceQuery,
  createAwsOps,
  execFailure,
  messageTraceQuery,
  workerLogGroup,
} from '../src/lib/ops';
import { redeliveryOk, type RedeliveryOutcome } from '../src/lib/redelivery';
import {
  PREFERENCE_CASES,
  expectedAfterRegister,
  expectedAfterRelease,
  fillerSeats,
  firstFreePreference,
  validateCase,
} from '../src/lib/preferenceCases';
import {
  doubleHolds,
  overCapacity,
  randomPreferences,
  seededRandom,
  shuffle,
  waitFor,
  workshopInput,
} from '../src/lib/scenario';
import { describeRegistration, sessionLabeller } from '../src/lib/steps';

describe('preference cases (plan §4 "Preference, order")', () => {
  it('has 20 structurally valid cases with unique ids', () => {
    expect(PREFERENCE_CASES).toHaveLength(20);
    expect(new Set(PREFERENCE_CASES.map((c) => c.id)).size).toBe(20);
    for (const c of PREFERENCE_CASES) {
      expect(validateCase(c), c.id).toEqual([]);
    }
  });

  it('the oracle offers the first acceptable session with a free seat', () => {
    const byId = Object.fromEntries(PREFERENCE_CASES.map((c) => [c.id, c]));
    expect(expectedAfterRegister(byId.P01!)).toBe('OFFERED@S1');
    expect(expectedAfterRegister(byId.P02!)).toBe('OFFERED@S3');
    expect(expectedAfterRegister(byId.P05!)).toBe('OFFERED@S5');
    expect(expectedAfterRegister(byId.P09!)).toBe('OFFERED@S1'); // capacity 2, one seat taken
    expect(expectedAfterRegister(byId.P13!)).toBe('QUEUED#1'); // free sessions exist, none acceptable
    expect(firstFreePreference(byId.P14!)).toBe(4);
  });

  it('a release is relayed only when acceptable and only to someone without an offer (C2)', () => {
    const byId = Object.fromEntries(PREFERENCE_CASES.map((c) => [c.id, c]));
    expect(expectedAfterRelease(byId.P06!)).toBe('OFFERED@S3');
    expect(expectedAfterRelease(byId.P08!)).toBe('QUEUED#1'); // non-acceptable session released
    expect(expectedAfterRelease(byId.P20!)).toBe('OFFERED@S2'); // no upgrade to S1
    expect(expectedAfterRelease(byId.P01!)).toBeUndefined();
  });

  it('validateCase catches broken tables', () => {
    expect(validateCase({ id: 'X', note: '', capacities: [1, 1, 1, 1, 1], fills: [2, 0, 0, 0, 0], prefs: [1, 1] })).toEqual([
      'S1: fills 2 > capacity 1',
      'prefs must be non-empty and distinct',
    ]);
    expect(validateCase({ id: 'Y', note: '', capacities: [1, 1, 1, 1, 1], fills: [0, 0, 0, 0, 0], prefs: [6], release: 2 })).toEqual([
      'prefs out of range',
      'release S2 has no filler to cancel',
    ]);
    expect(fillerSeats({ id: 'Z', note: '', capacities: [2, 1, 1, 1, 1], fills: [2, 0, 1, 0, 0], prefs: [1] })).toEqual([
      [1, 0],
      [1, 1],
      [3, 0],
    ]);
  });
});

describe('backfillLayout', () => {
  it('default: 10 workshops × 2 sessions × capacity 5 = 100 offers, 22 registrations each', () => {
    expect(backfillLayout({ offers: 100, workshops: 10, sessions: 2, rounds: 1, cancellations: 20 })).toEqual({
      workshops: 10,
      sessions: 2,
      capacity: 5,
      rounds: 1,
      seats: 10,
      offers: 100,
      extraPerWorkshop: 2,
      registrantsPerWorkshop: 22,
    });
  });

  it('rounds the offer count up and spreads rounds and cancellations', () => {
    const layout = backfillLayout({ offers: 50, workshops: 3, sessions: 3, rounds: 2, cancellations: 4 });
    expect(layout.capacity).toBe(3); // ceil(50 / 18)
    expect(layout.offers).toBe(3 * 9 * 2);
    expect(layout.extraPerWorkshop).toBe(2);
    expect(layout.registrantsPerWorkshop).toBe(9 * 3 + 2);
  });

  it('clamps sessions to 2..5 and cancellations to the seats of a workshop', () => {
    const layout = backfillLayout({ offers: 1, workshops: 1, sessions: 9, rounds: 0, cancellations: 100 });
    expect(layout.sessions).toBe(5);
    expect(layout.rounds).toBe(1);
    expect(layout.extraPerWorkshop).toBe(layout.seats);
  });
});

describe('access-control probes', () => {
  it('a bare status compares the status only; status + code compares both', () => {
    expect(answerMatches('401', '401 UNAUTHORIZED')).toBe(true);
    expect(answerMatches('401', '401')).toBe(true);
    expect(answerMatches('401', '403 FORBIDDEN')).toBe(false);
    expect(answerMatches('403 FORBIDDEN', '403 FORBIDDEN')).toBe(true);
    expect(answerMatches('403 FORBIDDEN', '403')).toBe(false);
  });

  it('tamperToken keeps header and payload and breaks the signature', () => {
    const token = 'aaa.bbb.signatureXYZW';
    const tampered = tamperToken(token);
    expect(tampered.split('.').slice(0, 2)).toEqual(['aaa', 'bbb']);
    expect(tampered).not.toBe(token);
    expect(tamperToken('aaa.bbb.xxAAAA')).toBe('aaa.bbb.xxBBBB');
  });

  it('statusOf reports the status and, for errors, the body code', async () => {
    const fetch: FetchLike = async (input) => {
      if (input.endsWith('/forbidden')) {
        return new Response(JSON.stringify({ code: 'FORBIDDEN', message: 'no' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      if (input.endsWith('/gateway')) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      }
      if (input.endsWith('/csv')) {
        return new Response('a,b\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } });
      }
      throw new TypeError('fetch failed');
    };
    const client = new ApiClient({ baseUrl: 'http://x', fetch });
    expect(await statusOf(client, 'GET', '/forbidden')).toBe('403 FORBIDDEN');
    expect(await statusOf(client, 'GET', '/gateway')).toBe('401');
    expect(await statusOf(client, 'GET', '/csv')).toBe('200');
    expect(await statusOf(client, 'GET', '/down')).toMatch(/^ERROR /);
  });
});

function session(id: string, capacity: number, confirmed: number, held: number): SessionView {
  return {
    id, workshopId: 'w', title: id, startsAt: '2026-11-04T02:00:00.000Z', cutoffAt: '2026-11-04T01:30:00.000Z',
    capacity, confirmed, held, status: 'OPEN', free: Math.max(0, capacity - confirmed - held), queueLength: 0,
  };
}

describe('scenario helpers', () => {
  it('overCapacity counts sessions with confirmed + held > capacity (C1)', () => {
    expect(overCapacity([session('a', 2, 1, 1), session('b', 1, 1, 1), session('c', 3, 0, 0)])).toBe(1);
  });

  it('doubleHolds counts users with more than one OFFERED/CONFIRMED seat (C2)', () => {
    const offer = (userId: string) => ({ seq: 1, userId, email: `${userId}@x.io`, acceptable: ['a'], status: 'OFFERED' as const, offer: { id: `o-${userId}`, sessionId: 'a', expiresAt: '2026-11-04T00:00:00.000Z' } });
    const confirmed = (userId: string) => ({ seq: 2, userId, email: `${userId}@x.io`, status: 'CONFIRMED' as const, sessionId: 'b', confirmedAt: '2026-11-03T00:00:00.000Z' });
    const dashboard = { offered: [offer('u1'), offer('u2')], confirmed: [confirmed('u1'), confirmed('u3')] } as unknown as DashboardView;
    expect(doubleHolds(dashboard)).toBe(1);
  });

  it('seededRandom is deterministic; shuffle and randomPreferences keep the elements', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    const ids = ['s1', 's2', 's3', 's4'];
    expect([...shuffle(ids, seededRandom(1))].sort()).toEqual(ids);
    const random = seededRandom(7);
    for (let i = 0; i < 50; i += 1) {
      const prefs = randomPreferences(ids, random);
      expect(prefs.length).toBeGreaterThanOrEqual(1);
      expect(new Set(prefs).size).toBe(prefs.length);
      expect(prefs.every((id) => ids.includes(id))).toBe(true);
    }
  });

  it('workshopInput spaces sessions 2 h apart from +24 h by default', () => {
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    const input = workshopInput({ title: 'T', holdSeconds: 60, sessions: [{ capacity: 1 }, { capacity: 2, title: 'Late' }] }, now);
    expect(input.sessions.map((s) => [s.title, s.startsAt, s.capacity])).toEqual([
      ['S1', '2026-11-02T00:00:00.000Z', 1],
      ['Late', '2026-11-02T02:00:00.000Z', 2],
    ]);
  });

  it('waitFor returns the first defined value and times out otherwise', async () => {
    let t = 0;
    const opts = { timeoutMs: 1000, intervalMs: 100, now: () => t, sleep: async (ms: number) => void (t += ms) };
    let calls = 0;
    expect(await waitFor('x', async () => (++calls >= 3 ? 'done' : undefined), opts)).toBe('done');
    await expect(waitFor('never', async () => undefined, opts)).rejects.toThrow(/timed out after 1000 ms waiting for never/);
  });

  it('describeRegistration renders the summary notation used in every check', () => {
    const label = sessionLabeller({ sessionIds: ['a', 'b'] });
    expect(describeRegistration(undefined, label)).toBe('none');
    expect(describeRegistration({ status: 'OFFERED', seq: 1, acceptable: ['b'], currentOffer: { id: 'o', sessionId: 'b', expiresAt: '2026-11-04T00:00:00.000Z' } }, label)).toBe('OFFERED@S2');
    expect(describeRegistration({ status: 'QUEUED', seq: 3, acceptable: ['a'], queuePosition: 2 }, label)).toBe('QUEUED#2');
    expect(describeRegistration({ status: 'ENDED', seq: 3, acceptable: [], endReason: 'NO_ACCEPTABLE_SESSION' }, label)).toBe('ENDED(NO_ACCEPTABLE_SESSION)');
    expect(label('zzzzzzzz-unknown')).toBe('?zzzzzzzz');
  });
});

describe('CloudWatch fetcher', () => {
  it('builds valid ids and queries for the SeatRelay, SQS and Lambda metrics', () => {
    expect(metricId('SweepLateExpiries', 'Sum')).toBe('sweeplateexpiries_sum');
    expect(metricId('1abc')).toBe('m_1abc');
    const queries = seatRelayQueries(['SweepLateExpiries', 'NotificationFailures']);
    expect(queries.map((q) => [q.id, q.dimensions?.service, q.stat])).toEqual([
      ['sweeplateexpiries_sum', 'worker', 'Sum'],
      ['sweeplateexpiries_samplecount', 'worker', 'SampleCount'],
      ['notificationfailures_sum', 'notifier', 'Sum'],
      ['notificationfailures_samplecount', 'notifier', 'SampleCount'],
    ]);
    expect(sqsQueries(['seatrelay-dev-commands.fifo']).map((q) => q.id)).toEqual([
      'sqs_visible_seatrelay_dev_commands_fifo',
      'sqs_oldest_seatrelay_dev_commands_fifo',
    ]);
    expect(lambdaQueries(['seatrelay-dev-notifier'])).toHaveLength(3);
    expect(toMetricDataQuery(queries[0]!, 60)).toMatchObject({
      Id: 'sweeplateexpiries_sum',
      MetricStat: { Metric: { Namespace: 'SeatRelay', MetricName: 'SweepLateExpiries', Dimensions: [{ Name: 'service', Value: 'worker' }] }, Period: 60, Stat: 'Sum' },
    });
  });

  it('adds the stage dimension when asked (deployed stacks emit service + stage)', () => {
    const [query] = seatRelayQueries(['SweepLateExpiries'], ['Sum'], { stage: 'dev' });
    expect(query?.dimensions).toEqual({ service: 'worker', stage: 'dev' });
  });

  it('merges paginated GetMetricData results and totals the series', async () => {
    const sent: GetMetricDataCommand[] = [];
    const client = {
      config: {},
      async send(command: GetMetricDataCommand) {
        sent.push(command);
        return sent.length === 1
          ? { MetricDataResults: [{ Id: 'sweeplateexpiries_sum', Timestamps: [new Date('2026-11-03T06:00:00Z')], Values: [0] }], NextToken: 'next' }
          : { MetricDataResults: [{ Id: 'sweeplateexpiries_sum', Timestamps: [new Date('2026-11-03T06:01:00Z')], Values: [2] }] };
      },
    };
    const window = { start: new Date('2026-11-03T06:00:00Z'), end: new Date('2026-11-03T06:10:00Z') };
    const result = await getMetricData(seatRelayQueries(['SweepLateExpiries']), window, { client, region: 'ap-southeast-1', skipCredentialsCheck: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input.NextToken).toBe('next');
    expect(result.available).toBe(true);
    expect(seatRelayMetricSum(result, 'SweepLateExpiries')).toBe(2);
    const count = result.available ? result.series.find((s) => s.id === 'sweeplateexpiries_samplecount') : undefined;
    expect(count?.empty).toBe(true);
    expect(describeMetrics(result).join('\n')).toContain('| SweepLateExpiries Sum | 2 | 2 | 2 |');
  });

  it('degrades gracefully without credentials or on API errors', async () => {
    const window = { start: new Date(0), end: new Date(60_000) };
    const noCredentials = await getMetricData(seatRelayQueries(['OffersCreated']), window, { client: { config: {}, send: async () => ({}) } });
    expect(noCredentials.available).toBe(false);
    const failing = await getMetricData(seatRelayQueries(['OffersCreated']), window, {
      client: { config: {}, send: async () => { throw new Error('AccessDenied'); } },
      skipCredentialsCheck: true,
    });
    expect(failing).toEqual({ available: false, reason: 'AccessDenied' });
    expect(describeMetrics(failing)).toEqual(['CloudWatch metrics not fetched: AccessDenied']);
    expect(seatRelayMetricSum(failing, 'OffersCreated')).toBeUndefined();
  });

  it('metricsSection / metricSum report unavailable sources instead of zeros', () => {
    expect(metricSum({ available: false, detail: 'no creds', values: {} }, 'SweepLateExpiries')).toBeUndefined();
    expect(metricSum({ available: true, detail: 'ok', values: {} }, 'SweepLateExpiries')).toBe(0);
    expect(metricsSection({ available: false, detail: 'no creds', values: {} })).toEqual(['Metrics not read: no creds']);
    expect(metricsSection({ available: true, detail: 'src', values: { A: { sum: 3, count: 2 } } }, { A: 'note' }).join('\n')).toContain('| A | 3 | 2 | note |');
  });
});

describe('AWS side channels (mocked SDK clients)', () => {
  const outputs = {
    CommandsQueueUrl: 'https://sqs/commands.fifo',
    CommandsDlqUrl: 'https://sqs/commands-dlq.fifo',
    NotifyDlqUrl: 'https://sqs/notify-dlq',
    NotifierFunctionName: 'seatrelay-dev-notifier',
  };

  function recorder(reply: (input: Record<string, unknown>) => unknown = () => ({})) {
    const inputs: { name: string; input: Record<string, unknown> }[] = [];
    return {
      inputs,
      client: {
        config: {},
        send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          inputs.push({ name: command.constructor.name, input: command.input });
          return reply(command.input);
        },
      },
    };
  }

  it('injects a late TICK into the FIFO with group = workshopId and a manual dedup id', async () => {
    const sqs = recorder();
    const ops = createAwsOps({ stage: 'dev', region: 'ap-southeast-1', outputs, sqs: sqs.client as never });
    const injected = await ops.injectLateTick({ type: 'TICK', workshopId: 'ws-9', source: 'TIMER', offerId: 'o-1', expiresAt: '2026-11-03T06:00:00.000Z' });
    expect(injected.available).toBe(true);
    expect(sqs.inputs[0]?.name).toBe('SendMessageCommand');
    expect(sqs.inputs[0]?.input).toMatchObject({ QueueUrl: outputs.CommandsQueueUrl, MessageGroupId: 'ws-9' });
    expect(String(sqs.inputs[0]?.input.MessageDeduplicationId)).toMatch(/^manual#o-1#/);
    expect(JSON.parse(String(sqs.inputs[0]?.input.MessageBody))).toMatchObject({ type: 'TICK', offerId: 'o-1' });
  });

  it('sums visible + in-flight messages of every DLQ', async () => {
    const sqs = recorder((input) => ({
      Attributes: input.QueueUrl === outputs.CommandsDlqUrl ? { ApproximateNumberOfMessages: '2', ApproximateNumberOfMessagesNotVisible: '1' } : { ApproximateNumberOfMessages: '0' },
    }));
    const ops = createAwsOps({ stage: 'dev', region: 'ap-southeast-1', outputs, sqs: sqs.client as never });
    const dead = await ops.deadLetters();
    expect(dead).toMatchObject({ available: true, total: 3, counts: { 'commands-dlq': 3, 'notify-dlq': 0 } });
  });

  it('pauses the notifier with reserved concurrency 0 and restores it by deleting the setting', async () => {
    const lambda = recorder();
    const ops = createAwsOps({ stage: 'dev', region: 'ap-southeast-1', outputs, lambda: lambda.client as never });
    expect((await ops.pauseNotifier()).available).toBe(true);
    expect((await ops.resumeNotifier()).available).toBe(true);
    expect(lambda.inputs).toEqual([
      { name: 'PutFunctionConcurrencyCommand', input: { FunctionName: 'seatrelay-dev-notifier', ReservedConcurrentExecutions: 0 } },
      { name: 'DeleteFunctionConcurrencyCommand', input: { FunctionName: 'seatrelay-dev-notifier' } },
    ]);
    expect(ops.faultFlagsExpected()).toBe(true);
    expect(createAwsOps({ stage: 'pilot', outputs }).faultFlagsExpected()).toBe(false);
  });

  it('reports a failing call as unavailable instead of throwing', async () => {
    const sqs = { config: {}, send: async () => { throw new Error('ExpiredToken'); } };
    const ops = createAwsOps({ stage: 'dev', region: 'ap-southeast-1', outputs, sqs: sqs as never });
    expect(await ops.injectLateTick({ type: 'TICK', workshopId: 'w' })).toEqual({ available: false, detail: 'ExpiredToken' });
  });

  it('builds the worker log group and a sanitised Logs Insights query', () => {
    expect(workerLogGroup('dev')).toBe('/aws/lambda/seatrelay-dev-worker');
    expect(commandTraceQuery("abc' or 1=1")).toContain("filter commandId = 'abcor11' or error like /abcor11/");
    expect(messageTraceQuery(['m-1'], ['r"1'])).toContain('filter messageId in ["m-1"] or function_request_id in ["r1"]');
    expect(messageTraceQuery([], [])).toBeUndefined();
    expect(execFailure(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))).toBe('docker CLI not found');
    expect(execFailure({ stderr: 'Error: No such container: x\nmore' })).toBe('Error: No such container: x');
  });
});

/**
 * Worker log lines exactly as services/aws writes them (Powertools JSON): the engine lines carry
 * `commandId` but no `deliveryAttempt`; the per-message lines carry `messageId` and
 * `deliveryAttempt` but no `commandId`; the injected-fault line names the command only in
 * `error`. `function_request_id` is the Lambda request id (one message per invocation).
 */
type WorkerLine = Record<string, string | number | boolean>;

function workerLines(commandId: string, fault: 'BEFORE_COMMIT' | 'AFTER_COMMIT' | 'none', options: { secondDelivery?: boolean } = {}): WorkerLine[] {
  const base = { service: 'worker', workshopId: 'ws-1', type: 'REGISTER' };
  const messageId = `msg-${commandId}`;
  const lines: WorkerLine[] = [];
  if (fault === 'none') {
    lines.push(
      { ...base, '@timestamp': '2026-10-17 07:00:01.000', level: 'INFO', message: 'command settled', function_request_id: `r1-${commandId}`, commandId, status: 'APPLIED', attempt: 1 },
      { ...base, '@timestamp': '2026-10-17 07:00:01.010', level: 'INFO', message: 'message processed', function_request_id: `r1-${commandId}`, messageId, outcome: 'APPLIED', attempts: 1, deliveryAttempt: 1 },
    );
    return lines;
  }
  lines.push({
    ...base, '@timestamp': '2026-10-17 07:00:01.000', level: 'WARN', message: 'injected fault; message will be redelivered',
    function_request_id: `r1-${commandId}`, messageId, deliveryAttempt: 1, failedFromIndex: 0,
    error: `injected fault ${fault} on command ${commandId}`, errorName: 'FaultInjectedError',
  });
  if (options.secondDelivery === false) {
    return lines;
  }
  if (fault === 'BEFORE_COMMIT') {
    lines.push({ ...base, '@timestamp': '2026-10-17 07:02:01.000', level: 'INFO', message: 'command settled', function_request_id: `r2-${commandId}`, commandId, status: 'APPLIED', attempt: 1 });
  } else {
    lines.push(
      { ...base, '@timestamp': '2026-10-17 07:02:01.000', level: 'INFO', message: 'command already settled; acknowledging redelivery', function_request_id: `r2-${commandId}`, commandId },
      { service: 'worker', '@timestamp': '2026-10-17 07:02:01.005', level: 'INFO', message: 'internal command had nothing to do', function_request_id: `r2-${commandId}`, type: 'TICK', workshopId: 'ws-1' },
      { ...base, '@timestamp': '2026-10-17 07:02:01.008', level: 'INFO', message: 'convergence pass after a settled redelivery', function_request_id: `r2-${commandId}`, commandId, outcome: 'NOOP', continuation: false },
    );
  }
  lines.push({
    ...base, '@timestamp': '2026-10-17 07:02:01.010', level: 'INFO', message: 'message processed', function_request_id: `r2-${commandId}`,
    messageId, outcome: fault === 'AFTER_COMMIT' ? 'ALREADY_SETTLED' : 'APPLIED', attempts: fault === 'AFTER_COMMIT' ? 0 : 1, deliveryAttempt: 2,
  });
  return lines;
}

/** Just enough of Logs Insights for the trace queries: `fields`, and `filter` clauses joined by `or`. */
function logsInsights(lines: readonly WorkerLine[]) {
  const results = new Map<string, { field: string; value: string }[][]>();
  const queries: string[] = [];
  const matches = (clause: string, line: WorkerLine): boolean => {
    const eq = /^(\S+) = '([^']*)'$/.exec(clause);
    if (eq) return String(line[eq[1] as string] ?? '') === eq[2];
    const like = /^(\S+) like \/(.*)\/$/.exec(clause);
    if (like) return new RegExp(like[2] as string).test(String(line[like[1] as string] ?? ''));
    const inList = /^(\S+) in \[(.*)\]$/.exec(clause);
    if (inList) {
      const values = (inList[2] as string).split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      return values.includes(String(line[inList[1] as string] ?? '\u0000'));
    }
    throw new Error(`unsupported clause ${clause}`);
  };
  const client = {
    config: {},
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'StartQueryCommand') {
        const query = String(command.input.queryString);
        queries.push(query);
        const fields = (/^fields (.*?) \|/.exec(query)?.[1] ?? '').split(',').map((f) => f.trim());
        const filter = /\| filter (.*?) \| sort/.exec(query)?.[1] ?? '';
        const clauses = filter.split(' or ');
        const rows = lines
          .filter((line) => clauses.some((clause) => matches(clause, line)))
          .map((line) => fields.filter((f) => line[f] !== undefined).map((f) => ({ field: f, value: String(line[f]) })));
        const id = `q${queries.length}`;
        results.set(id, rows);
        return { queryId: id };
      }
      return { status: 'Complete', results: results.get(String(command.input.queryId)) ?? [] };
    },
  };
  return { client, queries };
}

describe('AWS command trace over worker-shaped log lines', () => {
  const noise = [...workerLines('other-1', 'none'), ...workerLines('other-2', 'AFTER_COMMIT')];
  const trace = async (lines: WorkerLine[], commandId: string) => {
    const insights = logsInsights([...noise, ...lines]);
    const ops = createAwsOps({ stage: 'dev', region: 'ap-southeast-1', outputs: {}, logs: insights.client as never, sleep: async () => undefined });
    return { result: await ops.commandTrace(commandId, Date.parse('2026-10-17T07:00:00.000Z')), queries: insights.queries };
  };

  it('BEFORE_COMMIT: finds the redelivery through the fault line\'s messageId (2 deliveries)', async () => {
    const { result, queries } = await trace(workerLines('cmd-b', 'BEFORE_COMMIT'), 'cmd-b');
    expect(result).toMatchObject({ available: true, deliveries: 2, faultInjected: true });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('messageId in ["msg-cmd-b"]');
    expect(result.events.join('\n')).toContain('message processed (delivery 2) outcome=APPLIED');
    expect(result.events.some((event) => event.includes('other-'))).toBe(false);
  });

  it('AFTER_COMMIT: the acknowledged redelivery is counted (2 deliveries, ALREADY_SETTLED)', async () => {
    const { result } = await trace(workerLines('cmd-a', 'AFTER_COMMIT'), 'cmd-a');
    expect(result).toMatchObject({ available: true, deliveries: 2, faultInjected: true });
    expect(result.events.join('\n')).toContain('command already settled; acknowledging redelivery');
    expect(result.events.join('\n')).toContain('outcome=ALREADY_SETTLED');
  });

  it('a fault that never fired (flag stripped) shows ONE delivery, so the case fails', async () => {
    const { result } = await trace(workerLines('cmd-n', 'none'), 'cmd-n');
    expect(result).toMatchObject({ available: true, deliveries: 1, faultInjected: false });
    const outcome: RedeliveryOutcome = { how: 'trace', deliveries: result.deliveries as number, detail: result.detail, events: result.events };
    expect(redeliveryOk('aws', outcome)).toBe(false);
    expect(redeliveryOk('aws', { how: 'waited', detail: 'no credentials', events: [] })).toBe(false);
    expect(redeliveryOk('local', { how: 'waited', detail: 'no psql', events: [] })).toBe(true);
  });

  it('only the crashed delivery ingested so far: 1 delivery (the caller polls again)', async () => {
    const { result } = await trace(workerLines('cmd-p', 'BEFORE_COMMIT', { secondDelivery: false }), 'cmd-p');
    expect(result).toMatchObject({ deliveries: 1, faultInjected: true });
  });

  it('analyseWorkerTrace: a future worker that logs commandId with deliveryAttempt is read directly', () => {
    const analysis = analyseWorkerTrace(
      [{ '@timestamp': 't2', message: 'message processed', commandId: 'c', deliveryAttempt: '3' }],
      [],
    );
    expect(analysis.deliveries).toBe(3);
    expect(analyseWorkerTrace([], []).deliveries).toBeUndefined();
  });
});

describe('expiry-race verdicts (tick-first: expiry judged when the worker processes the ACCEPT)', () => {
  const expiresAt = Date.parse('2026-10-17T07:01:00.000Z');
  const at = (offsetMs: number) => new Date(expiresAt + offsetMs).toISOString();

  it('early ACCEPT: applied = PASS; arrived in time but processed after expiry = INCONCLUSIVE', () => {
    expect(classifyEarly({ status: 'APPLIED', acceptedAt: at(-178), settledAt: at(-167) }, expiresAt)).toBe('PASS');
    // the local repro: arrived 177 ms early, worker pickup 190 ms (200 ms poll) → settled 13 ms late
    expect(classifyEarly({ status: 'REJECTED', reason: 'OFFER_EXPIRED', acceptedAt: at(-177), settledAt: at(13) }, expiresAt)).toBe('INCONCLUSIVE');
    // the send timing missed (dev run 2026-10-17: cold start, arrived 362 ms after expiresAt): the
    // rejection is correct and says nothing about the early case, so the trial is repeated
    expect(classifyEarly({ status: 'REJECTED', reason: 'OFFER_EXPIRED', acceptedAt: at(362), settledAt: at(411) }, expiresAt)).toBe('INCONCLUSIVE');
  });

  it('early ACCEPT: anything the server clock contradicts, or another outcome, is a FAIL', () => {
    expect(classifyEarly(undefined, expiresAt)).toBe('FAIL');
    // rejected as expired although processed before expiresAt
    expect(classifyEarly({ status: 'REJECTED', reason: 'OFFER_EXPIRED', acceptedAt: at(-177), settledAt: at(-20) }, expiresAt)).toBe('FAIL');
    expect(classifyEarly({ status: 'APPLIED', acceptedAt: at(5), settledAt: at(40) }, expiresAt)).toBe('FAIL');
    expect(classifyEarly({ status: 'REJECTED', reason: 'OFFER_NOT_ACTIVE', acceptedAt: at(-177), settledAt: at(13) }, expiresAt)).toBe('FAIL');
    expect(consistentWithServerTime({ status: 'REJECTED', reason: 'OFFER_EXPIRED', acceptedAt: at(200), settledAt: at(262) }, expiresAt)).toBe(true);
  });

  it('labels which pass relayed the expired seat in the late trial', () => {
    const accepted = expiresAt + 200;
    expect(relayOrder(expiresAt + 88, accepted, accepted + 60)).toBe('timer tick processed before the ACCEPT arrived');
    expect(relayOrder(accepted + 61, accepted, accepted + 62)).toContain("the ACCEPT's own tick-first pass");
    expect(relayOrder(accepted + 20, accepted, accepted + 400)).toBe('timer tick processed while the ACCEPT was queued');
  });
});

describe('concurrency capacities (plan §4: 3 sessions, 5 seats in total)', () => {
  it('defaults to 2/2/1 and accepts an explicit list', () => {
    expect(capacitiesFrom({})).toEqual([2, 2, 1]);
    expect(DEFAULT_CAPACITIES.reduce((a, b) => a + b, 0)).toBe(5);
    expect(capacitiesFrom({ capacities: '3, 1' })).toEqual([3, 1]);
  });

  it('--sessions/--capacity expand to uniform sessions; mixing or invalid lists is refused', () => {
    expect(capacitiesFrom({ sessions: '3', capacity: '5' })).toEqual([5, 5, 5]);
    expect(capacitiesFrom({ capacity: '4' })).toEqual([4, 4, 4]);
    expect(() => capacitiesFrom({ capacities: '2,2,1', sessions: '3' })).toThrow(/either/);
    expect(() => capacitiesFrom({ capacities: '2,0,1' })).toThrow(/positive integers/);
    expect(() => capacitiesFrom({ capacities: '5' })).toThrow(/2\.\.5 sessions/);
    expect(() => capacitiesFrom({ capacities: '1,1,1,1,1,1' })).toThrow(/2\.\.5 sessions/);
  });
});
