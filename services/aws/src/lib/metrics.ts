import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { MetricName, MetricUnit as PortUnit, MetricsSink } from '@seatrelay/service';
import { SERVICE_NAME, STAGE } from './env';

export const METRICS_NAMESPACE = 'SeatRelay';

/**
 * Adapter-level operational metrics (not part of the service's `MetricName` list):
 * `WorkerRecordFailures` counts SQS records the worker could not settle (infrastructure errors
 * reported in `batchItemFailures`, malformed messages it had to drop). The handler turns these
 * failures into a normal return, so `AWS/Lambda Errors` never sees them; the template alarms
 * on this metric instead.
 */
export const OPERATIONAL_METRIC_NAMES = ['WorkerRecordFailures'] as const;
export type OperationalMetricName = (typeof OPERATIONAL_METRIC_NAMES)[number];

export interface OperationalMetricsSink {
  count(name: OperationalMetricName, value?: number): void;
}

/**
 * EMF metrics through Powertools: namespace `SeatRelay`, dimensions `service` (from
 * `POWERTOOLS_SERVICE_NAME`) and `stage` (from `STAGE`). Both are low-cardinality
 * (CONVENTIONS §7); the stage keeps the dev and pilot stacks, which share one account and
 * region, on separate metric streams. Metrics are buffered during the invocation and flushed
 * once by `flush()`.
 */
export class LambdaMetrics implements MetricsSink, OperationalMetricsSink {
  readonly powertools: Metrics;

  constructor(powertools?: Metrics) {
    this.powertools =
      powertools ??
      new Metrics({
        namespace: METRICS_NAMESPACE,
        serviceName: SERVICE_NAME(),
        singleMetric: false,
        defaultDimensions: { stage: STAGE() },
      });
  }

  emit(name: MetricName, value: number, unit: PortUnit = 'Count'): void {
    this.powertools.addMetric(
      name,
      unit === 'Milliseconds' ? MetricUnit.Milliseconds : MetricUnit.Count,
      value,
    );
  }

  count(name: OperationalMetricName, value = 1): void {
    this.powertools.addMetric(name, MetricUnit.Count, value);
  }

  /** Publishes the buffered metrics (one EMF blob); a no-op when nothing was emitted. */
  flush(): void {
    if (this.powertools.hasStoredMetrics()) {
      this.powertools.publishStoredMetrics();
    }
  }
}
