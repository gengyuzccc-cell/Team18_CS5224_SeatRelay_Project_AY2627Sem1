import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * `docker stats` sampling of the local containers (plan §2.7): one CSV line per container
 * per sample, every 2 s by default, while a load-test run is in progress.
 */
export interface DockerStatsRow {
  ts: string;
  container: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netInputBytes: number;
  netOutputBytes: number;
  blockInputBytes: number;
  blockOutputBytes: number;
  pids: number;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000_000,
  mib: 1_048_576,
  gb: 1_000_000_000,
  gib: 1_073_741_824,
  tb: 1_000_000_000_000,
  tib: 1_099_511_627_776,
};

/** `123.4MiB` → bytes; `1.2kB` → 1200; `0B` → 0. */
export function parseSize(text: string): number {
  const match = /^\s*([\d.]+)\s*([A-Za-z]*)\s*$/.exec(text);
  if (match === null) {
    return Number.NaN;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = UNITS[unit === '' ? 'b' : unit];
  return factor === undefined ? Number.NaN : amount * factor;
}

function parsePercent(text: string): number {
  return Number(text.replace('%', '').trim());
}

function parsePair(text: string): [number, number] {
  const [left, right] = text.split('/');
  return [parseSize(left ?? ''), parseSize(right ?? '')];
}

/** One line of `docker stats --no-stream --format '{{json .}}'`. */
export function parseDockerStatsLine(line: string, ts: string): DockerStatsRow | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(trimmed) as Record<string, string>;
  } catch {
    return undefined;
  }
  const name = raw.Name ?? raw.Container;
  if (name === undefined) {
    return undefined;
  }
  const [memUsageBytes, memLimitBytes] = parsePair(raw.MemUsage ?? '0B / 0B');
  const [netInputBytes, netOutputBytes] = parsePair(raw.NetIO ?? '0B / 0B');
  const [blockInputBytes, blockOutputBytes] = parsePair(raw.BlockIO ?? '0B / 0B');
  return {
    ts,
    container: name,
    cpuPercent: parsePercent(raw.CPUPerc ?? '0%'),
    memUsageBytes,
    memLimitBytes,
    memPercent: parsePercent(raw.MemPerc ?? '0%'),
    netInputBytes,
    netOutputBytes,
    blockInputBytes,
    blockOutputBytes,
    pids: Number(raw.PIDs ?? '0'),
  };
}

export const DOCKER_STATS_CSV_HEADER =
  'ts,container,cpuPercent,memUsageMiB,memLimitMiB,memPercent,netInputBytes,netOutputBytes,blockInputBytes,blockOutputBytes,pids';

export function dockerStatsCsvLine(row: DockerStatsRow): string {
  const mib = (bytes: number): string => (bytes / 1_048_576).toFixed(2);
  return [
    row.ts,
    row.container,
    row.cpuPercent.toFixed(2),
    mib(row.memUsageBytes),
    mib(row.memLimitBytes),
    row.memPercent.toFixed(2),
    String(row.netInputBytes),
    String(row.netOutputBytes),
    String(row.blockInputBytes),
    String(row.blockOutputBytes),
    String(row.pids),
  ].join(',');
}

export const DEFAULT_CONTAINER_PREFIX = 'seatrelay-local-';

const execFileAsync = promisify(execFile);

export async function dockerStatsOnce(): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['stats', '--no-stream', '--format', '{{json .}}'],
    {
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return stdout;
}

export interface DockerStatsSamplerOptions {
  outFile: string;
  intervalMs?: number;
  /** Which containers to keep (default: names starting with `seatrelay-local-`). */
  filter?: (containerName: string) => boolean;
  /** Runs `docker stats --no-stream --format '{{json .}}'` (injectable for tests). */
  exec?: () => Promise<string>;
  now?: () => Date;
  onSample?: (rows: DockerStatsRow[]) => void;
  onError?: (error: unknown) => void;
}

export interface DockerStatsSampler {
  start(): void;
  /** Stops the timer and waits for an in-flight sample. */
  stop(): Promise<void>;
  sampleOnce(): Promise<DockerStatsRow[]>;
  readonly samples: number;
  readonly errors: number;
  /** Ticks skipped because the previous `docker stats` call was still running. */
  readonly skipped: number;
  readonly outFile: string;
}

/**
 * One `docker stats` call before sampling starts: returns why sampling cannot work (daemon
 * down, docker missing) or which containers match, so callers fail fast instead of logging an
 * error every 2 s for the whole run.
 */
export async function dockerStatsPreflight(
  filter: (containerName: string) => boolean = (name) => name.startsWith(DEFAULT_CONTAINER_PREFIX),
  exec: () => Promise<string> = dockerStatsOnce,
): Promise<{ ok: true; containers: string[] } | { ok: false; reason: string }> {
  let stdout: string;
  try {
    stdout = await exec();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      message
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('Command failed'))
        .join(' ') || message;
    return { ok: false, reason };
  }
  const containers = stdout
    .split('\n')
    .map((line) => parseDockerStatsLine(line, ''))
    .filter((row): row is DockerStatsRow => row !== undefined && filter(row.container))
    .map((row) => row.container);
  return { ok: true, containers };
}

export function createDockerStatsSampler(options: DockerStatsSamplerOptions): DockerStatsSampler {
  const intervalMs = options.intervalMs ?? 2000;
  const filter = options.filter ?? ((name: string) => name.startsWith(DEFAULT_CONTAINER_PREFIX));
  const exec = options.exec ?? dockerStatsOnce;
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<unknown> = Promise.resolve();
  let busy = false;
  let samples = 0;
  let errors = 0;
  let skipped = 0;
  let headerWritten = false;

  function ensureHeader(): void {
    if (headerWritten) {
      return;
    }
    fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
    const exists = fs.existsSync(options.outFile) && fs.statSync(options.outFile).size > 0;
    if (!exists) {
      fs.writeFileSync(options.outFile, `${DOCKER_STATS_CSV_HEADER}\n`);
    }
    headerWritten = true;
  }

  async function sampleOnce(): Promise<DockerStatsRow[]> {
    const ts = now().toISOString();
    const stdout = await exec();
    const rows = stdout
      .split('\n')
      .map((line) => parseDockerStatsLine(line, ts))
      .filter((row): row is DockerStatsRow => row !== undefined && filter(row.container));
    ensureHeader();
    if (rows.length > 0) {
      fs.appendFileSync(options.outFile, `${rows.map(dockerStatsCsvLine).join('\n')}\n`);
    }
    samples += 1;
    options.onSample?.(rows);
    return rows;
  }

  /** `docker stats --no-stream` itself takes ~2 s: never run two at once, skip the tick. */
  function tick(): void {
    if (busy) {
      skipped += 1;
      return;
    }
    busy = true;
    inflight = sampleOnce()
      .catch((error: unknown) => {
        errors += 1;
        options.onError?.(error);
      })
      .finally(() => {
        busy = false;
      });
  }

  return {
    get samples() {
      return samples;
    },
    get errors() {
      return errors;
    },
    get skipped() {
      return skipped;
    },
    outFile: options.outFile,
    start() {
      if (timer !== undefined) {
        return;
      }
      tick();
      timer = setInterval(tick, intervalMs);
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await inflight;
    },
    sampleOnce,
  };
}
