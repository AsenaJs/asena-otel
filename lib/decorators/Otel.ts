import { PostProcessor } from '@asenajs/asena/decorators';
import { defineTypedMetadata } from '@asenajs/asena/utils';
import { OtelConstants } from '../constants/OtelConstants';
import type { AsenaOtelOptions } from '../OtelConfig';

/**
 * Decorator that configures an OTel Tracing PostProcessor.
 *
 * Apply to a class extending `OtelTracingPostProcessor` to automatically:
 * 1. Initialize the OpenTelemetry SDK (tracer + meter providers)
 * 2. Auto-trace Service and Controller methods via Proxy
 * 3. Flush and release the SDK from `server.stop()`, via an `@OnStop` hook
 *
 * @example
 * ```typescript
 * @Otel({
 *   serviceName: 'my-app',
 *   traceExporter: new OTLPTraceExporter({ url: 'http://jaeger:4318/v1/traces' }),
 *   autoTrace: { services: true, controllers: true },
 * })
 * export class AppOtel extends OtelTracingPostProcessor {}
 * ```
 */
export function Otel(options: AsenaOtelOptions) {
  return function <T extends new (...args: any[]) => any>(target: T) {
    defineTypedMetadata(OtelConstants.OptionsKey, options, target);

    return PostProcessor()(target) as T;
  };
}
