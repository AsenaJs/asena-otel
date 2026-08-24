import { trace, metrics, context, propagation, SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Sampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { createAllowListAttributesProcessor, MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics';
import { Inject, OnStart, OnStop } from '@asenajs/asena/decorators/ioc';
import { getOwnTypedMetadata } from '@asenajs/asena/utils';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';
import { OtelConstants } from '../constants/OtelConstants';
import type { AsenaOtelOptions, AutoTraceConfig } from '../OtelConfig';
import { otelRuntimeConfig } from '../shared/OtelRuntimeConfig';
import type { ComponentPostProcessor } from '@asenajs/asena/ioc/types';
import type { ServerLogger } from '@asenajs/asena/logger';

const COMPONENT_TYPE_SERVICE = 'SERVICE';
const COMPONENT_TYPE_CONTROLLER = 'CONTROLLER';
const LIBRARY_NAME = '@asenajs/asena-otel';

export class OtelTracingPostProcessor implements ComponentPostProcessor {
  protected tracerProvider: BasicTracerProvider | null = null;

  protected meterProvider: MeterProvider | null = null;

  // Injected by the IoC container when it resolves the processor. Optional because the class is
  // also constructed by hand - unit tests, scripts - and a missing logger must not be the reason
  // telemetry teardown fails.
  @Inject(ICoreServiceNames.SERVER_LOGGER)
  protected serverLogger?: ServerLogger;

  private tracer!: Tracer;

  private autoTraceConfig: AutoTraceConfig = {};

  private optionsRead = false;

  private options: AsenaOtelOptions | undefined;

  /**
   * Build the SDK and publish it globally.
   *
   * Runs at construction rather than from `server.start()`: the container keeps post-processor
   * start hooks immediate precisely because `postProcess()` below captures `this.tracer` and
   * reads `this.autoTraceConfig` at wrap time. Deferring this would hand every wrapped component
   * an undefined tracer.
   */
  @OnStart()
  public onInit(): void {
    const options = this.getOptions();

    if (!options) return;

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
    });

    this.setupContextManager();
    this.setupTracing(resource, options.traceExporter, options.sampler);

    if (options.metricReader) {
      this.setupMetrics(resource, options.metricReader);
    }

    this.autoTraceConfig = options.autoTrace ?? {};
    otelRuntimeConfig.ignoreRoutes = options.ignoreRoutes ?? [];
    this.tracer = trace.getTracer(LIBRARY_NAME);
  }

  public postProcess<T>(instance: T, Class: any): T {
    const config = this.autoTraceConfig;
    const componentType = this.getComponentType(Class);

    if (!componentType) return instance;

    if (componentType === COMPONENT_TYPE_SERVICE && !config.services) return instance;

    if (componentType === COMPONENT_TYPE_CONTROLLER && !config.controllers) return instance;

    const className = Class.name;
    const tracer = this.tracer;

    return new Proxy(instance as object, {
      get(target, prop) {
        // Receiver is the raw instance, not the proxy. Reflect.get *invokes* an accessor, so
        // passing the proxy ran every getter with `this === proxy` - and a getter that reads a
        // `#private` field then throws, before the typeof guard below can skip it.
        const value = Reflect.get(target, prop, target);

        if (typeof value !== 'function') return value;

        if (prop === 'constructor' || typeof prop === 'symbol') return value;

        if (String(prop).startsWith('_')) return value;

        const spanName = `${className}.${String(prop)}`;

        return function (this: any, ...args: any[]) {
          const span = tracer.startSpan(spanName, { kind: SpanKind.INTERNAL });
          const spanContext = trace.setSpan(context.active(), span);

          let result: any;

          try {
            result = context.with(spanContext, () => value.apply(target, args));
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
            span.recordException(error as Error);
            span.end();

            throw error;
          }

          if (result instanceof Promise) {
            return result
              .then((resolved: any) => {
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();

                return resolved;
              })
              .catch((error: Error) => {
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                span.recordException(error);
                span.end();

                throw error;
              });
          }

          span.setStatus({ code: SpanStatusCode.OK });
          span.end();

          return result;
        };
      },
    }) as T;
  }

  public async forceFlush(): Promise<void> {
    if (this.tracerProvider) {
      await this.tracerProvider.forceFlush();
    }

    if (this.meterProvider) {
      await this.meterProvider.forceFlush();
    }
  }

  /**
   * Release the SDK: flush what is buffered, stop the exporter timers, unhook the context manager.
   *
   * Driven by `server.stop()`. It used to be driven by `process.on('SIGTERM'|'SIGINT')` instead,
   * which was wrong three ways: the async listener's rejection was unheld, so an unreachable
   * collector - the normal case for a local Ctrl+C - killed the process with ECONNREFUSED; the
   * listeners were never removed, so repeated boots in one process piled them up; and
   * `server.stop()` on its own flushed nothing, leaving the BatchSpanProcessor timer and the
   * metric reader's export interval running.
   *
   * Every step is independent and every failure is contained. Awaiting the tracer provider first
   * meant a throw there skipped the meter provider and the context manager entirely - and a
   * telemetry flush that cannot reach its collector must never be what takes the application
   * down. Safe to call twice; the second call has nothing left to release.
   */
  @OnStop()
  public async shutdown(): Promise<void> {
    const tracerProvider = this.tracerProvider;
    const meterProvider = this.meterProvider;

    // Dropped before the awaits, not after: a provider whose shutdown rejected is spent either
    // way, and a second stop() retrying the same failing flush only delays the exit further.
    this.tracerProvider = null;
    this.meterProvider = null;

    await Promise.allSettled([
      this.releaseStep('tracer provider', () => tracerProvider?.shutdown()),
      this.releaseStep('meter provider', () => meterProvider?.shutdown()),
    ]);

    // After the providers rather than alongside them: an exporter still draining reads the active
    // context, and swapping in a no-op context manager mid-flush changes what it sees.
    await this.releaseStep('context manager', () => context.disable());
  }

  private getOptions(): AsenaOtelOptions | undefined {
    if (this.optionsRead) return this.options;

    const metadata = getOwnTypedMetadata<AsenaOtelOptions | (() => AsenaOtelOptions)>(
      OtelConstants.OptionsKey,
      this.constructor,
    );

    this.options = typeof metadata === 'function' ? metadata() : metadata;
    this.optionsRead = true;

    return this.options;
  }

  private setupContextManager(): void {
    const contextManager = new AsyncLocalStorageContextManager();

    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  }

  private setupTracing(resource: Resource, exporter: SpanExporter, sampler?: Sampler): void {
    this.tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
      sampler,
    });

    trace.setGlobalTracerProvider(this.tracerProvider);
  }

  private setupMetrics(resource: Resource, reader: MetricReader): void {
    this.meterProvider = new MeterProvider({
      resource,
      readers: [reader],
      views: [
        {
          instrumentName: 'http.server.*',
          attributesProcessors: [
            createAllowListAttributesProcessor(['http.request.method', 'http.response.status_code', 'http.route']),
          ],
        },
      ],
    });
    metrics.setGlobalMeterProvider(this.meterProvider);
  }

  /**
   * Run one teardown step, reporting failure instead of raising it.
   *
   * The thunk is called inside the async body so a synchronous throw becomes a rejection here
   * too - otherwise it would escape while the sibling steps were being scheduled.
   */
  private async releaseStep(step: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      // Falls back to the console when the container did not build this instance: a contained
      // failure nobody can see is not much better than the crash it replaced.
      (this.serverLogger ?? console).error(`[Otel] ${step} shutdown failed, continuing: ${reason}`);
    }
  }

  /**
   * Own-only, matching the container. A class is whatever its own decorator says it is -
   * walking the chain meant a @Controller extending a @Service base answered SERVICE first,
   * so it was traced under the wrong autoTrace policy and given the wrong span name.
   */
  private getComponentType(Class: any): string | null {
    if (getOwnTypedMetadata(COMPONENT_TYPE_SERVICE, Class)) return COMPONENT_TYPE_SERVICE;

    if (getOwnTypedMetadata(COMPONENT_TYPE_CONTROLLER, Class)) return COMPONENT_TYPE_CONTROLLER;

    return null;
  }
}
