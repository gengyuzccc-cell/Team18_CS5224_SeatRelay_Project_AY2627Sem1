import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoop } from '../src/loop';
import type { LocalLogger } from '../src/logger';

const logger: LocalLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

afterEach(() => vi.restoreAllMocks());

describe('background loop lifecycle', () => {
  it('continues polling after a stop and restart', async () => {
    const tick = vi.fn(async () => false);
    const loop = createLoop({ name: 'restart', intervalMs: 10, logger, tick });
    loop.start();
    await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    const beforeRestart = tick.mock.calls.length;
    try {
      loop.start();
      await vi.waitFor(() =>
        expect(tick.mock.calls.length).toBeGreaterThanOrEqual(beforeRestart + 2),
      );
    } finally {
      await loop.stop();
    }
  });

  it('drains an in-flight tick before stop resolves', async () => {
    let finish: (busy: boolean) => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const loop = createLoop({ name: 'drain', intervalMs: 10, logger, tick });
    loop.start();
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(false);
    await stopping;
    expect(stopped).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
