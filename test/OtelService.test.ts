import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { SpanStatusCode, propagation, context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OtelService } from '../lib/services/OtelService';
import { createTestOtelSdk, cleanupOtel, type TestOtelSdk } from './utils/otelTestUtils';

describe('OtelService', () => {
  let sdk: TestOtelSdk;
  let service: OtelService;

  beforeEach(() => {
    sdk = createTestOtelSdk({ withMetrics: true });
    service = new OtelService();
    service.onInit();
  });

  afterEach(async () => {
    await cleanupOtel(sdk);
  });

  describe('onInit', () => {
    it('should set tracer from global trace API', () => {
      expect(service.tracer).toBeDefined();

      const span = service.tracer.startSpan('tracer-check');

      span.end();

      const spans = sdk.spanExporter.getFinishedSpans();

      expect(spans.length).toBe(1);
    });

    it('should set meter from global metrics API', async () => {
      expect(service.meter).toBeDefined();

      const counter = service.meter.createCounter('init_test_counter');

      counter.add(1);

      const { resourceMetrics } = await sdk.metricReader!.collect();

      expect(resourceMetrics.scopeMetrics.length).toBeGreaterThan(0);
    });
  });

  describe('withSpan', () => {
    it('should create a span with the given name', async () => {
      await service.withSpan('test-operation', async () => 'done');

      const spans = sdk.spanExporter.getFinishedSpans();

      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('test-operation');
    });

    it('should return the result of the callback', async () => {
      const result = await service.withSpan('op', async () => 42);

      expect(result).toBe(42);
    });

    it('should set span status to OK on success', async () => {
      await service.withSpan('ok-op', async () => 'success');

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('should set span status to ERROR on failure', async () => {
      try {
        await service.withSpan('error-op', async () => {
          throw new Error('boom');
        });
      } catch {
        // expected
      }

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('should record exception event on failure', async () => {
      try {
        await service.withSpan('exception-op', async () => {
          throw new Error('exception-test');
        });
      } catch {
        // expected
      }

      const span = sdk.spanExporter.getFinishedSpans()[0];
      const exceptionEvent = span.events.find((e) => e.name === 'exception');

      expect(exceptionEvent).toBeDefined();
    });

    it('should re-throw the original error', async () => {
      const error = new Error('original-error');

      await expect(
        service.withSpan('rethrow-op', async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    });

    it('should end the span in both success and error cases', async () => {
      await service.withSpan('success-end', async () => 'ok');

      expect(sdk.spanExporter.getFinishedSpans()[0].ended).toBe(true);

      sdk.spanExporter.reset();

      try {
        await service.withSpan('error-end', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      expect(sdk.spanExporter.getFinishedSpans()[0].ended).toBe(true);
    });

    it('should pass the active span to the callback', async () => {
      await service.withSpan('attr-op', async (span) => {
        span.setAttribute('custom-key', 'custom-value');
      });

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes['custom-key']).toBe('custom-value');
    });
  });

  describe('getActiveSpan', () => {
    it('should return undefined when no span is active', () => {
      expect(service.getActiveSpan()).toBeUndefined();
    });
  });

  describe('injectTraceContext', () => {
    let contextManager: AsyncLocalStorageContextManager;

    beforeEach(() => {
      contextManager = new AsyncLocalStorageContextManager();
      contextManager.enable();
      context.setGlobalContextManager(contextManager);
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    });

    afterEach(() => {
      context.disable();
    });

    it('should inject traceparent header within an active span', async () => {
      const headers: Record<string, string> = {};

      await service.withSpan('inject-test', async () => {
        service.injectTraceContext(headers);
      });

      expect(headers['traceparent']).toBeDefined();
      expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    });

    it('should preserve existing headers', async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      await service.withSpan('preserve-test', async () => {
        service.injectTraceContext(headers);
      });

      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['traceparent']).toBeDefined();
    });

    it('should return the same headers object reference', () => {
      const headers: Record<string, string> = {};
      const result = service.injectTraceContext(headers);

      expect(result).toBe(headers);
    });

    it('should work with default empty headers', () => {
      const result = service.injectTraceContext();

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should not throw when no active span exists', () => {
      expect(() => service.injectTraceContext({})).not.toThrow();
    });
  });
});
