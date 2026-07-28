import { trace, metrics, type Meter } from '@opentelemetry/api';
import {
  context as otelContext,
  type Counter,
  type Histogram,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import { Middleware } from '@asenajs/asena/decorators';
import { PostConstruct } from '@asenajs/asena/decorators/ioc';
import type { AsenaContext } from '@asenajs/asena/adapter';
import { isRouteIgnored } from '../shared/OtelRuntimeConfig';

const LIBRARY_NAME = '@asenajs/asena-otel';

@Middleware()
export class OtelTracingMiddleware extends AsenaMiddlewareService {
  private tracer!: Tracer;

  private meter!: Meter;

  private requestCounter!: Counter;

  private requestDuration!: Histogram;

  @PostConstruct()
  public onInit() {
    this.tracer = trace.getTracer(LIBRARY_NAME);
    this.meter = metrics.getMeter(LIBRARY_NAME);

    this.requestCounter = this.meter.createCounter('http.server.request.count', {
      description: 'Total number of HTTP requests',
    });

    this.requestDuration = this.meter.createHistogram('http.server.request.duration', {
      description: 'HTTP request duration in milliseconds',
      unit: 'ms',
    });
  }

  public async handle(ctx: AsenaContext<any, any>, next: () => Promise<void>): Promise<void> {
    const startTime = performance.now();

    const method = ctx.req?.method ?? 'UNKNOWN';
    const url = ctx.req?.url ? new URL(ctx.req.url).pathname : '/';

    // Check ignoreRoutes against static URL path (before route matching)
    if (isRouteIgnored(url)) {
      await next();

      return;
    }

    // Extract W3C traceparent from incoming request headers
    const parentContext = propagation.extract(otelContext.active(), ctx.headers);

    await this.tracer.startActiveSpan(`${method} ${url}`, { kind: SpanKind.SERVER }, parentContext, async (span) => {
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, method);
      span.setAttribute(ATTR_URL_PATH, url);

      try {
        await next();

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        span.recordException(error as Error);

        throw error;
      } finally {
        const duration = performance.now() - startTime;

        // Read routePattern AFTER next() — in Hono, route matching happens during next()
        const raw = (ctx as any).routePattern as string | undefined;
        const trimmed = raw && raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
        const routePattern = trimmed && trimmed !== '/*' ? trimmed : undefined;

        if (routePattern) {
          span.updateName(`${method} ${routePattern}`);
          span.setAttribute(ATTR_HTTP_ROUTE, routePattern);
        }

        const attributes: Record<string, string | number> = {
          [ATTR_HTTP_REQUEST_METHOD]: method,
          [ATTR_HTTP_ROUTE]: routePattern ?? 'unmatched',
        };

        const statusCode = (ctx.res as any)?.status as number | undefined;

        if (statusCode !== undefined) {
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
          attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = statusCode;
        }

        this.requestCounter.add(1, attributes);
        this.requestDuration.record(duration, attributes);

        span.end();
      }
    });
  }
}
