import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';
import { OtelTracingMiddleware } from '../lib/middleware/OtelTracingMiddleware';
import { otelRuntimeConfig } from '../lib/shared/OtelRuntimeConfig';
import { createTestOtelSdk, cleanupOtel, createMockAsenaContext, type TestOtelSdk } from './utils/otelTestUtils';

describe('OtelTracingMiddleware', () => {
  let sdk: TestOtelSdk;
  let middleware: OtelTracingMiddleware;

  beforeEach(() => {
    sdk = createTestOtelSdk({ withMetrics: true });

    middleware = new OtelTracingMiddleware();
    middleware.onInit();
  });

  afterEach(async () => {
    otelRuntimeConfig.ignoreRoutes = [];
    await cleanupOtel(sdk);
  });

  describe('onInit', () => {
    it('should create requestCounter instrument', () => {
      expect((middleware as any)['requestCounter']).toBeDefined();
    });

    it('should create requestDuration histogram instrument', () => {
      expect((middleware as any)['requestDuration']).toBeDefined();
    });
  });

  describe('handle - successful request', () => {
    it('should create a SERVER span with method and path in name', async () => {
      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/api/users' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const spans = sdk.spanExporter.getFinishedSpans();

      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('GET /api/users');
      expect(spans[0].kind).toBe(SpanKind.SERVER);
    });

    it('should set HTTP attributes on span', async () => {
      const ctx = createMockAsenaContext({ method: 'POST', url: 'http://localhost/api/items' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes[ATTR_HTTP_REQUEST_METHOD]).toBe('POST');
      expect(span.attributes[ATTR_URL_PATH]).toBe('/api/items');
    });

    it('should set span status to OK when next succeeds', async () => {
      const ctx = createMockAsenaContext();
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('should call next()', async () => {
      const ctx = createMockAsenaContext();
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should increment request counter', async () => {
      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/api/data' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const { resourceMetrics } = await sdk.metricReader!.collect();
      const scopeMetrics = resourceMetrics.scopeMetrics;
      const counterMetric = scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.count');

      expect(counterMetric).toBeDefined();
      expect(counterMetric!.dataPoints.length).toBeGreaterThan(0);

      const dp = counterMetric!.dataPoints[0];

      expect(dp.value).toBe(1);
      expect(dp.attributes[ATTR_HTTP_REQUEST_METHOD]).toBe('GET');
      expect(dp.attributes[ATTR_URL_PATH]).toBe('/api/data');
    });

    it('should record request duration histogram', async () => {
      const ctx = createMockAsenaContext();
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const { resourceMetrics } = await sdk.metricReader!.collect();
      const histMetric = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.duration');

      expect(histMetric).toBeDefined();
      expect(histMetric!.dataPoints.length).toBeGreaterThan(0);
      expect((histMetric!.dataPoints[0].value as any).count).toBe(1);
    });
  });

  describe('handle - failed request', () => {
    it('should set span status to ERROR with error message', async () => {
      const ctx = createMockAsenaContext();
      const next = mock(() => Promise.reject(new Error('handler failed')));

      try {
        await middleware.handle(ctx, next);
      } catch {
        // expected
      }

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('handler failed');
    });

    it('should record exception event on span', async () => {
      const ctx = createMockAsenaContext();
      const next = mock(() => Promise.reject(new Error('exception-test')));

      try {
        await middleware.handle(ctx, next);
      } catch {
        // expected
      }

      const span = sdk.spanExporter.getFinishedSpans()[0];
      const exceptionEvent = span.events.find((e) => e.name === 'exception');

      expect(exceptionEvent).toBeDefined();
    });

    it('should re-throw the error', async () => {
      const ctx = createMockAsenaContext();
      const error = new Error('re-throw-test');
      const next = mock(() => Promise.reject(error));

      await expect(middleware.handle(ctx, next)).rejects.toThrow('re-throw-test');
    });

    it('should still record metrics even on error', async () => {
      const ctx = createMockAsenaContext();
      const next = mock(() => Promise.reject(new Error('metric-error')));

      try {
        await middleware.handle(ctx, next);
      } catch {
        // expected
      }

      const { resourceMetrics } = await sdk.metricReader!.collect();
      const allMetrics = resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics);

      const counter = allMetrics.find((m) => m.descriptor.name === 'http.server.request.count');
      const histogram = allMetrics.find((m) => m.descriptor.name === 'http.server.request.duration');

      expect(counter).toBeDefined();
      expect(counter!.dataPoints.length).toBeGreaterThan(0);
      expect(histogram).toBeDefined();
      expect(histogram!.dataPoints.length).toBeGreaterThan(0);
    });
  });

  describe('handle - route pattern', () => {
    it('should use routePattern for span name when available', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/api/users/123',
        routePattern: '/api/users/:id',
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.name).toBe('GET /api/users/:id');
    });

    it('should set http.route attribute when routePattern is available', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/api/users/123',
        routePattern: '/api/users/:id',
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes[ATTR_HTTP_ROUTE]).toBe('/api/users/:id');
      expect(span.attributes[ATTR_URL_PATH]).toBe('/api/users/123');
    });

    it('should fall back to URL path when routePattern is not set', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/api/users/123',
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.name).toBe('GET /api/users/123');
      expect(span.attributes[ATTR_HTTP_ROUTE]).toBeUndefined();
    });

    it('should use routePattern in metric attributes for low cardinality', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/api/users/123',
        routePattern: '/api/users/:id',
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const { resourceMetrics } = await sdk.metricReader!.collect();
      const counter = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.count');

      expect(counter!.dataPoints[0].attributes[ATTR_URL_PATH]).toBe('/api/users/:id');
    });
  });

  describe('handle - response status code', () => {
    it('should set http.response.status_code when response status is available', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/test',
        responseStatus: 200,
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(200);
    });

    it('should set status code for error responses', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/test',
        responseStatus: 404,
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(404);
    });

    it('should include status code in metric attributes', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/test',
        responseStatus: 200,
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const { resourceMetrics } = await sdk.metricReader!.collect();
      const counter = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.count');

      expect(counter!.dataPoints[0].attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(200);
    });

    it('should not set status code attribute when res.status is undefined', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/test',
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBeUndefined();
    });

    it('should record status code even when handler throws', async () => {
      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/test',
        responseStatus: 500,
      });
      const next = mock(() => Promise.reject(new Error('server error')));

      try {
        await middleware.handle(ctx, next);
      } catch {
        // expected
      }

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(500);
    });
  });

  describe('handle - ignored routes', () => {
    it('should skip tracing for exact match ignored route', async () => {
      otelRuntimeConfig.ignoreRoutes = ['/health'];

      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/health' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(sdk.spanExporter.getFinishedSpans().length).toBe(0);
    });

    it('should still trace non-ignored routes', async () => {
      otelRuntimeConfig.ignoreRoutes = ['/health'];

      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/api/users' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      expect(sdk.spanExporter.getFinishedSpans().length).toBe(1);
    });

    it('should support wildcard prefix matching', async () => {
      otelRuntimeConfig.ignoreRoutes = ['/admin/*'];

      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/admin/settings' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(sdk.spanExporter.getFinishedSpans().length).toBe(0);
    });

    it('should not match wildcard against different prefix', async () => {
      otelRuntimeConfig.ignoreRoutes = ['/admin/*'];

      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/api/admin' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      expect(sdk.spanExporter.getFinishedSpans().length).toBe(1);
    });

    it('should check ignoreRoutes against URL path', async () => {
      otelRuntimeConfig.ignoreRoutes = ['/api/users/123'];

      const ctx = createMockAsenaContext({
        method: 'GET',
        url: 'http://localhost/api/users/123',
        routePattern: '/api/users/:id',
      });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(sdk.spanExporter.getFinishedSpans().length).toBe(0);
    });

    it('should not produce metrics for ignored routes', async () => {
      otelRuntimeConfig.ignoreRoutes = ['/metrics'];

      const ctx = createMockAsenaContext({ method: 'GET', url: 'http://localhost/metrics' });
      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const { resourceMetrics } = await sdk.metricReader!.collect();
      const counter = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === 'http.server.request.count');

      // No data points since route was ignored
      if (counter) {
        expect(counter.dataPoints.length).toBe(0);
      }
    });
  });

  describe('handle - edge cases', () => {
    it('should use UNKNOWN for method when req.method is undefined', async () => {
      const ctx = createMockAsenaContext();

      ctx.req.method = undefined;

      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.name).toContain('UNKNOWN');
    });

    it('should use / for path when req.url is undefined', async () => {
      const ctx = createMockAsenaContext();

      ctx.req.url = undefined;

      const next = mock(() => Promise.resolve());

      await middleware.handle(ctx, next);

      const span = sdk.spanExporter.getFinishedSpans()[0];

      expect(span.name).toContain('/');
    });
  });
});