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
 * Accepts either the options object or a thunk returning them. A thunk is not
 * called at decoration time: it runs when the post-processor initialises
 * (`onInit`), after module-level configuration has been read, so per-service
 * values from the environment can be read lazily and the decorated class can
 * live in a shared package.
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
 *
 * @example
 * ```typescript
 * @Otel(() => ({
 *   serviceName: process.env.SERVICE_NAME!,
 *   traceExporter: new OTLPTraceExporter({ url: process.env.OTLP_URL }),
 * }))
 * export class AppOtel extends OtelTracingPostProcessor {}
 * ```
 */
export function Otel(options: AsenaOtelOptions | (() => AsenaOtelOptions)) {
  return function <T extends new (...args: any[]) => any>(target: T) {
    defineTypedMetadata(OtelConstants.OptionsKey, options, target);

    return PostProcessor()(target) as T;
  };
}
