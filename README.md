# @asenajs/asena-otel

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](https://github.com/AsenaJs/asena-otel)
[![Bun Version](https://img.shields.io/badge/Bun-1.3.12%2B-blueviolet)](https://bun.sh)

OpenTelemetry integration for AsenaJS — automatic HTTP tracing, method-level auto-tracing, metrics, and distributed tracing support.

A single request automatically produces a full waterfall trace:

```
GET /api/users (SERVER)
  └─ UserController.list (INTERNAL)
       └─ UserService.getAll (INTERNAL)
```

## Requirements

- [Bun](https://bun.sh) v1.3.12 or higher
- [@asenajs/asena](https://github.com/AsenaJs/Asena) v0.9.0 or higher

## Installation

```bash
bun add @asenajs/asena-otel @opentelemetry/api @opentelemetry/resources @opentelemetry/sdk-trace-base @opentelemetry/sdk-metrics @opentelemetry/semantic-conventions @opentelemetry/context-async-hooks
```

## Quick Start

### Step 1: Create an @Otel class

Create a class that extends `OtelTracingPostProcessor` and apply the `@Otel` decorator with your configuration. Asena automatically discovers and initializes it during bootstrap.

```typescript
// src/otel/AppOtel.ts
import { Otel, OtelTracingPostProcessor } from '@asenajs/asena-otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

@Otel({
  serviceName: 'my-app',
  serviceVersion: '1.0.0',
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: 'http://localhost:4318/v1/metrics',
    }),
  }),
  autoTrace: {
    services: true,     // auto-trace @Service methods
    controllers: true,  // auto-trace @Controller methods
  },
})
export class AppOtel extends OtelTracingPostProcessor {}
```

### Step 2: Create a Local Middleware Class

Create a class in your `src` folder that extends `OtelTracingMiddleware` and apply the `@Middleware()` decorator. This registers the middleware in Asena's IoC container.

```typescript
// src/middlewares/AppOtelMiddleware.ts
import { Middleware } from '@asenajs/asena/decorators';
import { OtelTracingMiddleware } from '@asenajs/asena-otel';

@Middleware()
export class AppOtelMiddleware extends OtelTracingMiddleware {}
```

> **Important:** Asena's IoC container only scans the `src` folder defined in your `asena.config.ts`. Since `OtelTracingMiddleware` lives in `node_modules`, the container cannot discover it automatically. You **must** create a local class extending it with `@Middleware()` so that Asena can register and use it.

### Step 3: Register the Middleware in your Config

Add `AppOtelMiddleware` to your config's `globalMiddlewares()`. This is required so that all HTTP requests are traced automatically.

```typescript
import { Config } from '@asenajs/asena/decorators';
import { ConfigService, type Context, HttpException } from '@asenajs/ergenecore';
import { AppOtelMiddleware } from '../middlewares/AppOtelMiddleware';
import { AppCorsMiddleware } from '../middlewares/AppCorsMiddleware';

@Config()
export class AppConfig extends ConfigService {

  public globalMiddlewares() {
    return [
      AppOtelMiddleware,  // traces all HTTP requests automatically
      AppCorsMiddleware,
    ];
  }

  public onError(error: Error, context: Context) {
    if (error instanceof HttpException) {
      return context.send(error.body, error.status);
    }
    return context.send({ error: 'Internal Server Error' }, 500);
  }

}
```

That's it. Asena's IoC container automatically discovers `AppOtel` and `OtelService`. All HTTP requests are traced, service methods are auto-traced, and metrics are collected — without changing any business logic.

## Components

### @Otel Decorator

Configures an `OtelTracingPostProcessor` subclass with OpenTelemetry options. Apply it to a class extending `OtelTracingPostProcessor`:

```typescript
import { Otel, OtelTracingPostProcessor } from '@asenajs/asena-otel';

@Otel({
  serviceName: 'my-app',
  traceExporter: exporter,
  autoTrace: { services: true, controllers: true },
})
export class AppOtel extends OtelTracingPostProcessor {}
```

The decorator stores the options as metadata and applies `@PostProcessor()` automatically. During bootstrap, `@PostConstruct()` in `OtelTracingPostProcessor` reads the metadata and initializes the OpenTelemetry SDK — tracer provider, meter provider, context manager, and shutdown hooks.

### OtelService

Injectable `@Service` that provides access to OpenTelemetry tracer and meter. Use it for custom spans and distributed tracing. Asena automatically discovers and registers it.

```typescript
import { Inject } from '@asenajs/asena/decorators/ioc';
import type { OtelService } from '@asenajs/asena-otel';

@Service()
export class OrderService {

  @Inject('OtelService')
  private otelService: OtelService;

  async processOrder(orderId: string) {
    return this.otelService.withSpan('process-order', async (span) => {
      span.setAttribute('order.id', orderId);
      // ... business logic
      return { success: true };
    });
    // span automatically ends, errors are recorded
  }

}
```

**API:**
- `tracer` — OpenTelemetry `Tracer` instance
- `meter` — OpenTelemetry `Meter` instance
- `withSpan(name, fn)` — creates a span, sets OK/ERROR status, records exceptions, ends span automatically
- `getActiveSpan()` — returns current active span (or undefined)
- `injectTraceContext(headers?)` — injects W3C `traceparent` header into a headers object for distributed tracing (see [Outgoing Request Context Propagation](#outgoing-request-context-propagation))

**Expression injection** (for direct tracer/meter access):
```typescript
@Inject('OtelService', (s) => s.tracer)
private tracer: Tracer;

@Inject('OtelService', (s) => s.meter)
private meter: Meter;
```

### OtelTracingMiddleware

`@Middleware` that automatically traces all HTTP requests. Register in your Config's `globalMiddlewares()` to enable request tracing.

**Creates for each request:**
- A `SERVER` span named `"{METHOD} {PATH}"` (e.g., `GET /api/users`)
- **Span attributes** (high-cardinality safe): `http.request.method`, `url.path`, `http.route` (after route matching), `http.response.status_code`
- **Metric attributes** (low-cardinality only): `http.request.method`, `http.route` (or `'unmatched'` for unmatched routes), `http.response.status_code`
- Metrics: `http.server.request.count` (Counter), `http.server.request.duration` (Histogram)
- Extracts W3C `traceparent` header from incoming requests for distributed tracing

> **Note on cardinality:** `url.path` is intentionally excluded from metric attributes — raw paths from scanner/bot traffic would otherwise create unbounded metric series. A `View` with `createAllowListAttributesProcessor` is also configured on `http.server.*` instruments as defense-in-depth.

### OtelTracingPostProcessor

`@PostProcessor` that wraps Service and Controller methods with tracing spans via JavaScript Proxy.

- Creates `INTERNAL` spans named `"{ClassName}.{methodName}"` (e.g., `UserService.getAll`)
- Spans are automatically children of the HTTP span (proper waterfall hierarchy)
- Controlled via `autoTrace` config in the `@Otel` decorator options
- Skips private methods (`_` prefix), constructors, and Symbol properties

## Configuration

### AsenaOtelOptions

```typescript
interface AsenaOtelOptions {
  serviceName: string;           // Required: identifies your service
  serviceVersion?: string;       // Optional: defaults to '0.0.0'
  traceExporter: SpanExporter;   // Required: where to send spans
  metricReader?: MetricReader;   // Optional: enables metrics collection
  autoTrace?: AutoTraceConfig;   // Optional: auto-trace settings
  sampler?: Sampler;             // Optional: custom sampling strategy
  ignoreRoutes?: string[];       // Optional: routes to exclude from tracing
}

interface AutoTraceConfig {
  services?: boolean;     // auto-trace @Service methods (default: false)
  controllers?: boolean;  // auto-trace @Controller methods (default: false)
}
```

## Sampling

Use `ratioBasedSampler()` for production environments to control trace volume:

```typescript
import { Otel, OtelTracingPostProcessor, ratioBasedSampler } from '@asenajs/asena-otel';

@Otel({
  serviceName: 'my-app',
  traceExporter: exporter,
  sampler: ratioBasedSampler(0.1),  // sample 10% of traces
  autoTrace: { services: true, controllers: true },
})
export class AppOtel extends OtelTracingPostProcessor {}
```

`ratioBasedSampler(ratio)` creates a `ParentBasedSampler` wrapping `TraceIdRatioBasedSampler`. Root spans are sampled at the given ratio (0.0–1.0); child spans respect the parent's decision.

## Route Exclusion

Use `ignoreRoutes` to skip tracing on specific paths (e.g., health checks, metrics endpoints):

```typescript
@Otel({
  serviceName: 'my-app',
  traceExporter: exporter,
  ignoreRoutes: ['/health', '/metrics', '/admin/*'],
})
export class AppOtel extends OtelTracingPostProcessor {}
```

- **Exact match:** `/health` matches only `/health`
- **Wildcard suffix:** `/admin/*` matches `/admin/` and all sub-paths

Ignored routes produce no spans and no metrics.

## Outgoing Request Context Propagation

`@asenajs/asena-otel` automatically traces **incoming** HTTP requests via `OtelTracingMiddleware` (extracts W3C `traceparent` header). However, **outgoing** HTTP calls (e.g., `fetch` to another service) are **not** automatically instrumented.

Use `OtelService.injectTraceContext()` to manually propagate trace context to downstream services:

```typescript
@Service()
export class PaymentClient {

  @Inject('OtelService')
  private otelService: OtelService;

  async charge(payload: ChargeRequest) {
    // injectTraceContext() adds the W3C traceparent header
    const headers = this.otelService.injectTraceContext({
      'Content-Type': 'application/json',
    });

    const res = await fetch('http://payment-service/api/charge', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    return res.json();
  }

}
```

For full visibility, combine with `withSpan()` to create a dedicated span for the outgoing call:

```typescript
async charge(payload: ChargeRequest) {
  return this.otelService.withSpan('call-payment-service', async (span) => {
    span.setAttribute('service.target', 'payment-service');

    const headers = this.otelService.injectTraceContext();
    const res = await fetch('http://payment-service/api/charge', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return res.json();
  });
}
```

This writes a `traceparent` header in the format `00-{traceId}-{spanId}-{traceFlags}`. The downstream service extracts this header to continue the same trace, enabling end-to-end distributed tracing across microservices.

## Testing

Use `InMemorySpanExporter` and `InMemoryMetricExporter` for testing:

```typescript
import { Otel, OtelTracingPostProcessor } from '@asenajs/asena-otel';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter();
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 100,
});

@Otel({
  serviceName: 'test-service',
  traceExporter: spanExporter,
  metricReader,
  autoTrace: { services: true, controllers: true },
})
export class TestOtel extends OtelTracingPostProcessor {}
```

After making requests, flush spans (`BatchSpanProcessor` is lazy):

```typescript
import { trace } from '@opentelemetry/api';

const provider = trace.getTracerProvider() as any;
await provider.forceFlush?.();
const spans = spanExporter.getFinishedSpans();
```

For metrics, wait for periodic export then read from exporter:

```typescript
await metricReader.forceFlush();
const metrics = metricExporter.getMetrics();
```

### Verifying parent-child hierarchy

In OpenTelemetry SDK v2, use `parentSpanContext` (not `parentSpanId`):

```typescript
const httpSpan = spans.find(s => s.kind === SpanKind.SERVER);
const serviceSpan = spans.find(s => s.name.includes('UserService'));

// Same trace
expect(serviceSpan.spanContext().traceId).toBe(httpSpan.spanContext().traceId);

// Parent-child link (SDK v2)
expect(serviceSpan.parentSpanContext?.spanId).toBe(httpSpan.spanContext().spanId);
```

## License

MIT