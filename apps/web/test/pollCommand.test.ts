import type { CommandResultView } from '@seatrelay/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PollAbortedError, PollGaveUpError, pollCommand } from '../src/commands/pollCommand';

const COMMAND_ID = '0f9a7d3e-5c4b-4a2e-9f1d-6b8c2e4a1d37';

function view(status: CommandResultView['status']): CommandResultView {
  return {
    commandId: COMMAND_ID,
    type: 'REGISTER',
    workshopId: 'ws-1',
    status,
    acceptedAt: '2026-11-03T06:00:00.000Z',
    ...(status === 'APPLIED'
      ? { settledAt: '2026-11-03T06:00:01.000Z', result: { offersCreated: 1 } }
      : {}),
  };
}

/** Virtual clock: sleep advances `now` instead of waiting. */
function clock() {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

describe('pollCommand', () => {
  it('polls with the backoff schedule until the record is terminal', async () => {
    const { now, sleep, slept } = clock();
    const answers = [view('ACCEPTED'), view('ACCEPTED'), view('ACCEPTED'), view('APPLIED')];
    const getCommand = vi.fn(async () => answers.shift() ?? view('APPLIED'));
    const result = await pollCommand(getCommand, COMMAND_ID, { sleep, now });
    expect(result.status).toBe('APPLIED');
    expect(getCommand).toHaveBeenCalledTimes(4);
    expect(slept).toEqual([300, 500, 1000, 2000]);
  });

  it('returns REJECTED as a terminal state too', async () => {
    const { now, sleep } = clock();
    const result = await pollCommand(async () => view('REJECTED'), COMMAND_ID, { sleep, now });
    expect(result.status).toBe('REJECTED');
  });

  it('tolerates transient errors and resets the error counter on success', async () => {
    const { now, sleep } = clock();
    let calls = 0;
    const getCommand = async () => {
      calls += 1;
      if (calls === 1 || calls === 3) {
        throw new Error('network');
      }
      return calls >= 4 ? view('APPLIED') : view('ACCEPTED');
    };
    const result = await pollCommand(getCommand, COMMAND_ID, {
      sleep,
      now,
      maxConsecutiveErrors: 2,
    });
    expect(result.status).toBe('APPLIED');
    expect(calls).toBe(4);
  });

  it('gives up after maxConsecutiveErrors in a row, keeping the commandId for a resume', async () => {
    const { now, sleep } = clock();
    const getCommand = async () => {
      throw new Error('down');
    };
    await expect(
      pollCommand(getCommand, COMMAND_ID, { sleep, now, maxConsecutiveErrors: 3 }),
    ).rejects.toBeInstanceOf(PollGaveUpError);
  });

  it('fires the slow hint exactly once after the 30 s budget', async () => {
    const { now, sleep, slept } = clock();
    let calls = 0;
    const onSlow = vi.fn();
    const getCommand = async () => {
      calls += 1;
      return calls >= 21 ? view('APPLIED') : view('ACCEPTED');
    };
    await pollCommand(getCommand, COMMAND_ID, { sleep, now, onSlow });
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(slept.slice(18)).toEqual([5000, 5000, 5000]);
  });

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController();
    const sleep = async () => {
      controller.abort();
    };
    await expect(
      pollCommand(async () => view('ACCEPTED'), COMMAND_ID, {
        sleep,
        now: () => 0,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(PollAbortedError);
  });
});
