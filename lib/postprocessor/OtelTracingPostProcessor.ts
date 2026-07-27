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
import { PostConstruct } from '@asenajs/asena/decorators/ioc';
import { getOwnTypedMetadata } from '@asenajs/asena/utils';
import { OtelConstants } from '../constants/OtelConstants';
import type { AsenaOtelOptions, AutoTraceConfig } from '../OtelConfig';
import { otelRuntimeConfig } from '../shared/OtelRuntimeConfig';
import type { ComponentPostProcessor } from '@asenajs/asena/ioc/types';

const COMPONENT_TYPE_SERVICE = 'SERVICE';
const COMPONENT_TYPE_CONTROLLER = 'CONTROLLER';
const LIBRARY_NAME = '@asenajs/asena-otel';

export class OtelTracingPostProcessor implements ComponentPostProcessor {
  protected tracerProvider: BasicTracerProvider | null = null;

  protected meterProvider: MeterProvider | null = null;

  private tracer!: Tracer;

  private autoTraceConfig: AutoTraceConfig = {};

  @PostConstruct()
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

    this.registerShutdownHook();
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

  public async shutdown(): Promise<void> {
    if (this.tracerProvider) {
      await this.tracerProvider.shutdown();
      this.tracerProvider = null;
    }

    if (this.meterProvider) {
      await this.meterProvider.shutdown();
      this.meterProvider = null;
    }

    context.disable();
  }

  private getOptions(): AsenaOtelOptions | undefined {
    return getOwnTypedMetadata<AsenaOtelOptions>(OtelConstants.OptionsKey, this.constructor);
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

  private registerShutdownHook(): void {
    const shutdown = async () => {
      await this.shutdown();
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
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
