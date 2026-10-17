import type { LogFields, Logger, MetricName, MetricUnit, MetricsSink } from '../ports';

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields?: LogFields;
}

/** Captures log lines for assertions. */
export class InMemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(message: string, fields?: LogFields): void {
    this.push('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.push('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.push('error', message, fields);
  }

  private push(level: LogEntry['level'], message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields });
  }
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Structured JSON lines on stdout/stderr (the local reference server). */
export const consoleJsonLogger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

export interface MetricSample {
  name: MetricName;
  value: number;
  unit: MetricUnit;
}

/** Captures emitted metrics for assertions. */
export class InMemoryMetrics implements MetricsSink {
  readonly samples: MetricSample[] = [];

  emit(name: MetricName, value: number, unit: MetricUnit = 'Count'): void {
    this.samples.push({ name, value, unit });
  }

  of(name: MetricName): number[] {
    return this.samples.filter((sample) => sample.name === name).map((sample) => sample.value);
  }

  sum(name: MetricName): number {
    return this.of(name).reduce((total, value) => total + value, 0);
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export const noopMetrics: MetricsSink = {
  emit: () => undefined,
};
