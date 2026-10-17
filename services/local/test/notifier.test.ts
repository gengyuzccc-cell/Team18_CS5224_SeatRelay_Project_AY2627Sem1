import { describe, expect, test } from 'vitest';
import {
  NOTIFIER_MAX_RETRY_DELAY_MS,
  notificationRetryDelayMs,
  withSmtpTimeouts,
} from '../src/notifier';

describe('notifier retry backoff', () => {
  test('doubles from the base and is capped at 5 minutes', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => notificationRetryDelayMs(attempt, 2000))).toEqual([
      2000, 4000, 8000, 16_000, 32_000,
    ]);
    expect(notificationRetryDelayMs(9, 2000)).toBe(NOTIFIER_MAX_RETRY_DELAY_MS);
    expect(notificationRetryDelayMs(1000, 2000)).toBe(NOTIFIER_MAX_RETRY_DELAY_MS);
    expect(notificationRetryDelayMs(3, 0)).toBe(0);
    expect(notificationRetryDelayMs(0, 2000)).toBe(2000);
  });

  test('the defaults (10 attempts, 2 s base) ride out an outage of about 13.5 minutes', () => {
    // Attempt n fails at t, attempt n+1 runs delay(n) later; the 10th failure parks the row.
    let total = 0;
    for (let failed = 1; failed < 10; failed += 1) {
      total += notificationRetryDelayMs(failed, 2000);
    }
    expect(total).toBe(810_000);
  });
});

describe('SMTP transport URL', () => {
  test('adds connect/greeting/socket timeouts unless the URL sets them', () => {
    expect(withSmtpTimeouts('smtp://mailpit:1025')).toBe(
      'smtp://mailpit:1025?connectionTimeout=10000&greetingTimeout=10000&socketTimeout=30000',
    );
    const custom = new URL(
      withSmtpTimeouts('smtps://user:secret@relay.example.com:465?socketTimeout=5000'),
    );
    expect(custom.searchParams.get('socketTimeout')).toBe('5000');
    expect(custom.searchParams.get('connectionTimeout')).toBe('10000');
    expect(custom.username).toBe('user');
    expect(custom.password).toBe('secret');
  });
});
