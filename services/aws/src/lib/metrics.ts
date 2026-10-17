import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { MetricName, MetricUnit as PortUnit, MetricsSink } from '@seatrelay/service';
import { SERVICE_NAME } from './env';

export const METRICS_NAMESPACE = 'SeatRelay';

/**
 * EMF metrics through Powertools: namespace `SeatRelay`, the `service` dimension only (set from
 * `POWERTOOLS_SERVICE_NAME`; CONVENTIONS §7 forbids high-cardinality dimensions). Metrics are
 * buffered during the invocation and flushed once by `flush()`.
 */
export class LambdaMetrics implements MetricsSink {
  readonly powertools: Metrics;

  constructor(powertools?: Metrics) {
    this.powertools =
      powertools ??
      new Metrics({
        namespace: METRICS_NAMESPACE,
        serviceName: SERVICE_NAME(),
        singleMetric: false,
      });
  }

  emit(name: MetricName, value: number, unit: PortUnit = 'Count'): void {
    this.powertools.addMetric(
      name,
      unit === 'Milliseconds' ? MetricUnit.Milliseconds : MetricUnit.Count,
      value,
    );
  }

  /** Publishes the buffered metrics (one EMF blob); a no-op when nothing was emitted. */
  flush(): void {
    if (this.powertools.hasStoredMetrics()) {
      this.powertools.publishStoredMetrics();
    }
  }
}
