import { Metrics } from '@aws-lambda-powertools/metrics';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { userFromEvent } from '../src/lib/auth';
import { renderEmail } from '../src/lib/email';
import { env, envFlag, envNumber, requireEnv } from '../src/lib/env';
import { LambdaLogger, errorFields } from '../src/lib/logger';
import { LambdaMetrics, METRICS_NAMESPACE } from '../src/lib/metrics';
import { createLambdaRuntime, lazy } from '../src/lib/runtime';
import { TokenBucket } from '../src/lib/tokenBucket';
import { apiEvent, bob, claimsOf } from './harness';

describe('auth: JWT authorizer claims → AuthUser', () => {
  test('sub, email and name are read from requestContext.authorizer.jwt.claims', () => {
    expect(userFromEvent(apiEvent({ path: '/me', claims: claimsOf(bob) }))).toEqual({
      userId: 'bob',
      email: 'bob@example.com',
      name: 'Bob',
    });
    expect(
      userFromEvent(apiEvent({ path: '/me', claims: { sub: ' u1 ', email: 'u1@example.com' } })),
    ).toEqual({ userId: 'u1', email: 'u1@example.com' });
  });

  test('no authorizer, or a token without sub/email, is anonymous', () => {
    expect(userFromEvent(apiEvent({ path: '/health' }))).toBeUndefined();
    expect(userFromEvent(apiEvent({ path: '/me', claims: { sub: 'u1' } }))).toBeUndefined();
    expect(userFromEvent(apiEvent({ path: '/me', claims: { email: 'x@y.z' } }))).toBeUndefined();
    expect(
      userFromEvent(apiEvent({ path: '/me', claims: { sub: '', email: 'x@y.z' } })),
    ).toBeUndefined();
  });

  test('display names are bounded', () => {
    const user = userFromEvent(
      apiEvent({
        path: '/me',
        claims: { sub: 'u', email: 'u@example.com', name: 'n'.repeat(500) },
      }),
    );
    expect(user?.name).toHaveLength(120);
  });
});

describe('env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('flags are on only for "true"; numbers fall back; required variables throw', () => {
    vi.stubEnv('ALLOW_FAULT_FLAGS', 'TRUE');
    vi.stubEnv('EMAIL_ENABLED', 'yes');
    vi.stubEnv('EMAIL_RATE_PER_SEC', '2.5');
    vi.stubEnv('BROKEN_NUMBER', 'fast');
    vi.stubEnv('EMPTY', '');
    expect(envFlag('ALLOW_FAULT_FLAGS')).toBe(true);
    expect(envFlag('EMAIL_ENABLED')).toBe(false);
    expect(envFlag('UNSET_FLAG_X')).toBe(false);
    expect(envNumber('EMAIL_RATE_PER_SEC', 1)).toBe(2.5);
    expect(envNumber('BROKEN_NUMBER', 1)).toBe(1);
    expect(env('EMPTY')).toBeUndefined();
    expect(() => requireEnv('UNSET_VAR_X')).toThrow(
      /Missing required environment variable UNSET_VAR_X/,
    );
  });
});

describe('TokenBucket', () => {
  test('paces to the configured rate using the injected clock and sleep', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(
      1,
      1,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    await bucket.take(); // the initial token
    await bucket.take(); // waits ~1 s for the next one
    await bucket.take();
    expect(sleeps).toEqual([1000, 1000]);
    now += 5000; // idle time refills at most `capacity`
    await bucket.take();
    await bucket.take();
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  test('rejects a non-positive rate', () => {
    expect(() => new TokenBucket(0)).toThrow(/positive/);
  });
});

describe('email rendering', () => {
  test('subject by kind, text and minimal HTML with escaping', () => {
    const email = renderEmail({
      kind: 'SESSION_CANCELLED',
      title: 'Session cancelled: <Morning>',
      body: 'Line one & two.\n\nSecond paragraph.',
    });
    expect(email.subject).toBe('[SeatRelay] Session cancelled: Session cancelled: <Morning>');
    expect(email.text).toBe(
      'Session cancelled: <Morning>\n\nLine one & two.\n\nSecond paragraph.\n\n--\nYou receive this e-mail because you registered with SeatRelay.\n',
    );
    expect(email.html).toContain('<h2>Session cancelled: &lt;Morning&gt;</h2>');
    expect(email.html).toContain('<p>Line one &amp; two.</p>\n<p>Second paragraph.</p>');
    expect(email.html).not.toContain('<Morning>');
  });
});

describe('observability wrappers', () => {
  test('LambdaMetrics buffers EMF metrics in the SeatRelay namespace and flushes once', () => {
    const powertools = new Metrics({ namespace: METRICS_NAMESPACE, serviceName: 'worker' });
    const addMetric = vi.spyOn(powertools, 'addMetric');
    const publish = vi
      .spyOn(powertools, 'publishStoredMetrics')
      .mockImplementation(() => powertools);
    const metrics = new LambdaMetrics(powertools);
    metrics.emit('CommandSettledLatency', 250, 'Milliseconds');
    metrics.emit('OffersCreated', 2);
    expect(addMetric.mock.calls).toEqual([
      ['CommandSettledLatency', 'Milliseconds', 250],
      ['OffersCreated', 'Count', 2],
    ]);
    expect(powertools.hasStoredMetrics()).toBe(true);
    metrics.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    // An invocation that emitted nothing publishes nothing (no empty EMF blob).
    const idle = new LambdaMetrics(
      new Metrics({ namespace: METRICS_NAMESPACE, serviceName: 'sweep' }),
    );
    expect(() => idle.flush()).not.toThrow();
  });

  test('LambdaLogger forwards structured fields; errorFields keeps the stack out of the response path', () => {
    const logger = new LambdaLogger();
    const info = vi.spyOn(logger.powertools, 'info').mockImplementation(() => undefined);
    logger.info('command settled', { commandId: 'c1', workshopId: 'w1' });
    expect(info).toHaveBeenCalledWith('command settled', { commandId: 'c1', workshopId: 'w1' });
    const fields = errorFields(new RangeError('bad'));
    expect(fields).toMatchObject({ error: 'bad', errorName: 'RangeError' });
    expect(String(fields.stack)).toContain('RangeError: bad');
    expect(errorFields('plain')).toEqual({ error: 'plain' });
  });

  test('createLambdaRuntime binds the context at begin and flushes at end; lazy memoises', () => {
    const runtime = createLambdaRuntime();
    const bind = vi.spyOn(runtime.logger, 'bind').mockImplementation(() => undefined);
    const unbind = vi.spyOn(runtime.logger, 'unbind').mockImplementation(() => undefined);
    const flush = vi.spyOn(runtime.metrics, 'flush').mockImplementation(() => undefined);
    runtime.begin(undefined, { requestId: 'r1' });
    runtime.end();
    expect(bind).toHaveBeenCalledWith(undefined, { requestId: 'r1' });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledTimes(1);

    let builds = 0;
    const value = lazy(() => ({ n: ++builds }));
    expect(value()).toBe(value());
    expect(builds).toBe(1);
  });
});
