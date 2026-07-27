import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { defineMetadata } from 'reflect-metadata/no-conflict';
import { AlwaysOffSampler, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OtelTracingPostProcessor } from '../lib/postprocessor/OtelTracingPostProcessor';
import { Otel } from '../lib/decorators/Otel';
import { ratioBasedSampler } from '../lib/samplers';
import { cleanupOtel } from './utils/otelTestUtils';
import type { AutoTraceConfig } from '../lib/OtelConfig';
import type { Sampler } from '@opentelemetry/sdk-trace-base';

function createProcessor(
  autoTrace: AutoTraceConfig,
  options?: { sampler?: Sampler },
): { processor: OtelTracingPostProcessor; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();

  @Otel({
    serviceName: 'test',
    traceExporter: exporter,
    autoTrace,
    ...options,
  })
  class TestOtel extends OtelTracingPostProcessor {}

  const processor = new TestOtel();

  processor.onInit();

  return { processor, exporter };
}

describe('OtelTracingPostProcessor', () => {
  let processor: OtelTracingPostProcessor;
  let exporter: InMemorySpanExporter;

  afterEach(async () => {
    await cleanupOtel();
  });

  describe('component type detection', () => {
    it('should return instance unchanged when class has no metadata', () => {
      ({ processor, exporter } = createProcessor({ services: true, controllers: true }));

      class PlainClass {
        doWork() {
          return 'result';
        }
      }

      const instance = new PlainClass();
      const result = processor.postProcess(instance, PlainClass);

      expect(result).toBe(instance);
    });

    it('should detect SERVICE type and return Proxy', () => {
      ({ processor, exporter } = createProcessor({ services: true }));

      class TestService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, TestService);

      const instance = new TestService();
      const result = processor.postProcess(instance, TestService);

      expect(result).not.toBe(instance);
    });

    it('should detect CONTROLLER type and return Proxy', () => {
      ({ processor, exporter } = createProcessor({ controllers: true }));

      class TestController {
        handle() {
          return 'response';
        }
      }

      defineMetadata('CONTROLLER', true, TestController);

      const instance = new TestController();
      const result = processor.postProcess(instance, TestController);

      expect(result).not.toBe(instance);
    });
  });

  describe('autoTrace config filtering', () => {
    it('should skip wrapping when autoTrace.services is false for a SERVICE', () => {
      ({ processor, exporter } = createProcessor({ services: false }));

      class TestService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, TestService);

      const instance = new TestService();
      const result = processor.postProcess(instance, TestService);

      expect(result).toBe(instance);
    });

    it('should skip wrapping when autoTrace.controllers is false for a CONTROLLER', () => {
      ({ processor, exporter } = createProcessor({ controllers: false }));

      class TestController {
        handle() {
          return 'response';
        }
      }

      defineMetadata('CONTROLLER', true, TestController);

      const instance = new TestController();
      const result = processor.postProcess(instance, TestController);

      expect(result).toBe(instance);
    });

    it('should skip wrapping when autoTrace.services is undefined for a SERVICE', () => {
      ({ processor, exporter } = createProcessor({}));

      class TestService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, TestService);

      const instance = new TestService();
      const result = processor.postProcess(instance, TestService);

      expect(result).toBe(instance);
    });

    it('should wrap when autoTrace.services is true for a SERVICE', () => {
      ({ processor, exporter } = createProcessor({ services: true }));

      class TestService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, TestService);

      const instance = new TestService();
      const result = processor.postProcess(instance, TestService);

      expect(result).not.toBe(instance);
    });
  });

  describe('Proxy behavior - public methods', () => {
    beforeEach(() => {
      ({ processor, exporter } = createProcessor({ services: true }));
    });

    it('should wrap public methods in trace spans', async () => {
      class MyService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const instance = new MyService();
      const proxied = processor.postProcess(instance, MyService);

      await proxied.doWork();
      await processor.forceFlush();

      const spans = exporter.getFinishedSpans();

      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('MyService.doWork');
    });

    it('should return the result of the original method', async () => {
      class MyService {
        compute() {
          return 'computed-value';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = await proxied.compute();

      expect(result).toBe('computed-value');
    });

    it('should set span status OK on success', async () => {
      class MyService {
        succeed() {
          return 'ok';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      await proxied.succeed();
      await processor.forceFlush();

      const span = exporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('should set span status ERROR and record exception on failure', async () => {
      class MyService {
        fail() {
          throw new Error('service-error');
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      try {
        await proxied.fail();
      } catch {
        // expected
      }

      await processor.forceFlush();

      const span = exporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('service-error');

      const exceptionEvent = span.events.find((e) => e.name === 'exception');

      expect(exceptionEvent).toBeDefined();
    });

    it('should re-throw the original error for sync methods', () => {
      class MyService {
        fail() {
          throw new Error('rethrow-error');
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      expect(() => proxied.fail()).toThrow('rethrow-error');
    });

    it('should use SpanKind.INTERNAL for wrapped method spans', async () => {
      class MyService {
        process() {
          return 'done';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      await proxied.process();
      await processor.forceFlush();

      const span = exporter.getFinishedSpans()[0];

      expect(span.kind).toBe(SpanKind.INTERNAL);
    });
  });

  describe('Proxy behavior - skipped members', () => {
    beforeEach(() => {
      ({ processor, exporter } = createProcessor({ services: true }));
    });

    it('should not wrap methods starting with underscore', async () => {
      class MyService {
        _privateMethod() {
          return 'private-result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = proxied._privateMethod();

      expect(result).toBe('private-result');

      await processor.forceFlush();

      expect(exporter.getFinishedSpans().length).toBe(0);
    });

    it('should not wrap the constructor property', () => {
      class MyService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      expect(proxied.constructor).toBe(MyService);

      expect(exporter.getFinishedSpans().length).toBe(0);
    });

    it('should not wrap symbol-keyed methods', () => {
      const mySymbol = Symbol('custom');

      class MyService {
        [mySymbol]() {
          return 'symbol-result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = proxied[mySymbol]();

      expect(result).toBe('symbol-result');
      expect(exporter.getFinishedSpans().length).toBe(0);
    });

    it('should not wrap non-function properties', () => {
      class MyService {
        name = 'test-service';

        count = 42;
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      expect(proxied.name).toBe('test-service');
      expect(proxied.count).toBe(42);
      expect(exporter.getFinishedSpans().length).toBe(0);
    });
  });

  describe('Proxy behavior - edge cases', () => {
    beforeEach(() => {
      ({ processor, exporter } = createProcessor({ services: true }));
    });

    it('should pass arguments through to the original method', async () => {
      class MyService {
        add(a: number, b: number) {
          return a + b;
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = await proxied.add(2, 3);

      expect(result).toBe(5);
    });

    it('should preserve this context of the original target', async () => {
      class MyService {
        value = 'hello';

        getValue() {
          return this.value;
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = await proxied.getValue();

      expect(result).toBe('hello');
    });

    it('should handle async methods correctly', async () => {
      class MyService {
        async fetchData() {
          return 'async-result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = await proxied.fetchData();

      expect(result).toBe('async-result');

      await processor.forceFlush();

      const span = exporter.getFinishedSpans()[0];

      expect(span.name).toBe('MyService.fetchData');
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('should handle methods returning rejected promises', async () => {
      class MyService {
        async failAsync() {
          throw new Error('async-fail');
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      await expect(proxied.failAsync()).rejects.toThrow('async-fail');

      await processor.forceFlush();

      const span = exporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('sync/async method handling', () => {
    beforeEach(() => {
      ({ processor, exporter } = createProcessor({ services: true }));
    });

    it('should return raw value for sync methods (not a Promise)', () => {
      class MyService {
        getCount() {
          return 42;
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = proxied.getCount();

      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toBe(42);
    });

    it('should return Promise for async methods', async () => {
      class MyService {
        async fetchData() {
          return 'async-data';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = proxied.fetchData();

      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe('async-data');
    });

    it('should throw synchronously for sync methods that throw', () => {
      class MyService {
        fail() {
          throw new Error('sync-error');
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      expect(() => proxied.fail()).toThrow('sync-error');
    });

    it('should reject Promise for async methods that throw', async () => {
      class MyService {
        async failAsync() {
          throw new Error('async-error');
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      await expect(proxied.failAsync()).rejects.toThrow('async-error');
    });

    it('should create span for sync methods', async () => {
      class MyService {
        getCount() {
          return 42;
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      proxied.getCount();

      await processor.forceFlush();

      const spans = exporter.getFinishedSpans();

      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('MyService.getCount');
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it('should record error span for sync throw', async () => {
      class MyService {
        fail() {
          throw new Error('sync-fail');
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      try {
        proxied.fail();
      } catch {
        // expected
      }

      await processor.forceFlush();

      const spans = exporter.getFinishedSpans();

      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('sync-fail');
    });

    it('should return string for sync string method', () => {
      class MyService {
        getName() {
          return 'hello';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);
      const result = proxied.getName();

      expect(typeof result).toBe('string');
      expect(result).toBe('hello');
    });
  });

  describe('sampling configuration', () => {
    it('should record no spans when AlwaysOffSampler is used', async () => {
      ({ processor, exporter } = createProcessor({ services: true }, { sampler: new AlwaysOffSampler() }));

      class MyService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      proxied.doWork();

      await processor.forceFlush();

      expect(exporter.getFinishedSpans().length).toBe(0);
    });

    it('should record all spans when no sampler is provided (default behavior)', async () => {
      ({ processor, exporter } = createProcessor({ services: true }));

      class MyService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      proxied.doWork();

      await processor.forceFlush();

      expect(exporter.getFinishedSpans().length).toBe(1);
    });

    it('should record all spans with ratioBasedSampler(1.0)', async () => {
      ({ processor, exporter } = createProcessor({ services: true }, { sampler: ratioBasedSampler(1.0) }));

      class MyService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      proxied.doWork();

      await processor.forceFlush();

      expect(exporter.getFinishedSpans().length).toBe(1);
    });

    it('should record no spans with ratioBasedSampler(0.0)', async () => {
      ({ processor, exporter } = createProcessor({ services: true }, { sampler: ratioBasedSampler(0.0) }));

      class MyService {
        doWork() {
          return 'result';
        }
      }

      defineMetadata('SERVICE', true, MyService);

      const proxied = processor.postProcess(new MyService(), MyService);

      proxied.doWork();

      await processor.forceFlush();

      expect(exporter.getFinishedSpans().length).toBe(0);
    });
  });

  describe('SDK initialization via @PostConstruct', () => {
    it('should set global tracer provider', async () => {
      const testExporter = new InMemorySpanExporter();

      @Otel({ serviceName: 'init-test', traceExporter: testExporter })
      class InitTestOtel extends OtelTracingPostProcessor {}

      const p = new InitTestOtel();

      p.onInit();

      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');

      span.end();

      await p.forceFlush();

      const spans = testExporter.getFinishedSpans();

      expect(spans.length).toBeGreaterThan(0);
      expect(spans[0].name).toBe('test-span');

      await p.shutdown();
      trace.disable();
    });

    it('should store autoTrace config from decorator options', () => {
      const testExporter = new InMemorySpanExporter();

      @Otel({
        serviceName: 'config-test',
        traceExporter: testExporter,
        autoTrace: { services: true, controllers: false },
      })
      class ConfigTestOtel extends OtelTracingPostProcessor {}

      const p = new ConfigTestOtel();

      p.onInit();

      expect((p as any)['autoTraceConfig']).toEqual({ services: true, controllers: false });

      // Cleanup
      p.shutdown();
      trace.disable();
    });

    it('should default autoTrace to empty object when not provided', () => {
      const testExporter = new InMemorySpanExporter();

      @Otel({ serviceName: 'default-test', traceExporter: testExporter })
      class DefaultTestOtel extends OtelTracingPostProcessor {}

      const p = new DefaultTestOtel();

      p.onInit();

      expect((p as any)['autoTraceConfig']).toEqual({});

      // Cleanup
      p.shutdown();
      trace.disable();
    });
  });

  describe('forceFlush', () => {
    it('should flush tracer provider', async () => {
      const testExporter = new InMemorySpanExporter();

      @Otel({ serviceName: 'flush-test', traceExporter: testExporter })
      class FlushTestOtel extends OtelTracingPostProcessor {}

      const p = new FlushTestOtel();

      p.onInit();

      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('flush-span');

      span.end();

      await p.forceFlush();

      expect(testExporter.getFinishedSpans().length).toBeGreaterThan(0);

      await p.shutdown();
      trace.disable();
    });
  });

  describe('metric View whitelist (defense in depth)', () => {
    it('should drop non-whitelisted attributes from http.server.* metrics', async () => {
      const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 100,
      });
      const traceExporter = new InMemorySpanExporter();

      @Otel({ serviceName: 'view-test', traceExporter, metricReader: reader })
      class ViewTestOtel extends OtelTracingPostProcessor {}

      const p = new ViewTestOtel();

      p.onInit();

      const counter = metrics.getMeter('test').createCounter('http.server.request.count');

      counter.add(1, {
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'http.route': '/api/users/:id',
        'url.path': '/api/users/123',
        'user.id': 'user-42',
      });

      const { resourceMetrics } = await reader.collect();
      const dataPoint = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.count')!.dataPoints[0];

      expect(dataPoint.attributes['http.request.method']).toBe('GET');
      expect(dataPoint.attributes['http.response.status_code']).toBe(200);
      expect(dataPoint.attributes['http.route']).toBe('/api/users/:id');
      expect(dataPoint.attributes['url.path']).toBeUndefined();
      expect(dataPoint.attributes['user.id']).toBeUndefined();

      await p.shutdown();
      trace.disable();
      metrics.disable();
    });

    it('should collapse multiple high-cardinality requests into bounded time series', async () => {
      const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 100,
      });
      const traceExporter = new InMemorySpanExporter();

      @Otel({ serviceName: 'view-cardinality-test', traceExporter, metricReader: reader })
      class ViewCardinalityOtel extends OtelTracingPostProcessor {}

      const p = new ViewCardinalityOtel();

      p.onInit();

      const counter = metrics.getMeter('test').createCounter('http.server.request.count');

      for (let i = 0; i < 50; i++) {
        counter.add(1, {
          'http.request.method': 'GET',
          'http.response.status_code': 404,
          'http.route': 'unmatched',
          'url.path': `/random-${i}`,
        });
      }

      const { resourceMetrics } = await reader.collect();
      const counterMetric = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.count');

      expect(counterMetric!.dataPoints.length).toBe(1);
      expect(counterMetric!.dataPoints[0].value).toBe(50);

      await p.shutdown();
      trace.disable();
      metrics.disable();
    });
  });

  describe('shutdown', () => {
    it('should set providers to null after shutdown', async () => {
      const testExporter = new InMemorySpanExporter();

      @Otel({ serviceName: 'shutdown-test', traceExporter: testExporter })
      class ShutdownTestOtel extends OtelTracingPostProcessor {}

      const p = new ShutdownTestOtel();

      p.onInit();

      expect((p as any)['tracerProvider']).not.toBeNull();

      await p.shutdown();

      expect((p as any)['tracerProvider']).toBeNull();
      expect((p as any)['meterProvider']).toBeNull();

      trace.disable();
    });
  });
});
