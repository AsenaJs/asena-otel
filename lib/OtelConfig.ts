import type { Sampler, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { MetricReader } from '@opentelemetry/sdk-metrics';

export interface AutoTraceConfig {
  services?: boolean;
  controllers?: boolean;
}

export interface AsenaOtelOptions {
  serviceName: string;
  serviceVersion?: string;
  traceExporter: SpanExporter;
  metricReader?: MetricReader;
  autoTrace?: AutoTraceConfig;
  sampler?: Sampler;
  ignoreRoutes?: string[];
}
