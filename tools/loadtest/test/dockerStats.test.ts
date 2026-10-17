import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDockerStatsSampler,
  DOCKER_STATS_CSV_HEADER,
  dockerStatsCsvLine,
  parseDockerStatsLine,
  parseSize,
} from '../src/lib/dockerStats';

const LINE =
  '{"BlockIO":"12.3MB / 4.1kB","CPUPerc":"1.25%","Container":"abc","ID":"abc","MemPerc":"0.80%","MemUsage":"62.5MiB / 7.6GiB","Name":"seatrelay-local-server-1","NetIO":"1.5kB / 820B","PIDs":"23"}';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('docker stats parsing', () => {
  it('parses docker size strings', () => {
    expect(parseSize('0B')).toBe(0);
    expect(parseSize('1.5kB')).toBe(1500);
    expect(parseSize('62.5MiB')).toBe(62.5 * 1_048_576);
    expect(parseSize('7.6GiB')).toBe(7.6 * 1_073_741_824);
    expect(parseSize('12.3MB')).toBe(12_300_000);
    expect(Number.isNaN(parseSize('lots'))).toBe(true);
  });

  it('parses one `docker stats --format {{json .}}` line', () => {
    const row = parseDockerStatsLine(LINE, '2026-10-17T07:00:00.000Z');
    expect(row).toEqual({
      ts: '2026-10-17T07:00:00.000Z',
      container: 'seatrelay-local-server-1',
      cpuPercent: 1.25,
      memUsageBytes: 62.5 * 1_048_576,
      memLimitBytes: 7.6 * 1_073_741_824,
      memPercent: 0.8,
      netInputBytes: 1500,
      netOutputBytes: 820,
      blockInputBytes: 12_300_000,
      blockOutputBytes: 4100,
      pids: 23,
    });
    expect(parseDockerStatsLine('', 'x')).toBeUndefined();
    expect(parseDockerStatsLine('not json', 'x')).toBeUndefined();
    expect(row && dockerStatsCsvLine(row)).toBe(
      '2026-10-17T07:00:00.000Z,seatrelay-local-server-1,1.25,62.50,7782.40,0.80,1500,820,12300000,4100,23',
    );
  });

  it('samples through an injected exec, filters containers and appends CSV lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seatrelay-stats-'));
    dirs.push(dir);
    const outFile = path.join(dir, 'nested', 'docker-stats.csv');
    let calls = 0;
    const sampler = createDockerStatsSampler({
      outFile,
      intervalMs: 5,
      exec: async () => {
        calls += 1;
        return `${LINE}\n${LINE.replace('seatrelay-local-server-1', 'other-container')}\n`;
      },
      now: () => new Date('2026-10-17T07:00:00.000Z'),
    });
    const rows = await sampler.sampleOnce();
    expect(rows.map((r) => r.container)).toEqual(['seatrelay-local-server-1']);
    sampler.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await sampler.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(sampler.samples).toBe(calls);
    const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(DOCKER_STATS_CSV_HEADER);
    expect(lines).toHaveLength(calls + 1);
    expect(lines[1]).toContain('seatrelay-local-server-1');
  });
});
