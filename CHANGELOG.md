# @asenajs/asena-otel

## 2.0.0

### Major Changes

- Shutdown runs from the lifecycle instead of a signal handler, and the core peer moves to `^0.10.0`

  `OtelTracingPostProcessor` registered its own `process.on('SIGTERM'|'SIGINT')` — the only signal
  handling in the framework, and there only because nothing else offered a shutdown hook. It had
  three problems: the handler was an `async` function handed straight to `process.on`, so a final
  flush against an unreachable collector rejected unheld and killed the process with exit 1; the
  listeners were never removed, so repeated boots in one process accumulated them; and
  `server.stop()` on its own flushed nothing, leaving the `BatchSpanProcessor` timer and any
  `PeriodicExportingMetricReader` interval running.

  `@OnStop` now drives `shutdown()`, and `shutdown()` runs its steps under `Promise.allSettled`,
  logging failures instead of raising them. A telemetry flush that cannot reach its collector can no
  longer take the application down.

  **Breaking:**

  - Requires `@asenajs/asena@^0.10.0`. A 0.9.x application cannot use this version.
  - The package no longer installs signal handlers. An application that relied on Ctrl+C flushing
    telemetry without calling `server.stop()` must call it — which the framework now does for you by
    default.

## 1.2.0

### Minor Changes

- Auto-trace picks the right component type, and no longer breaks on `#private` accessors

  **Component type is read own-only.** It was read off the prototype chain, and SERVICE is checked
  first, so a `@Controller` extending a `@Service` base resolved as a SERVICE — traced under the
  wrong `autoTrace` policy and given the wrong span name. A `@Controller` is now a controller
  whatever it extends, matching the container.

  **The tracing proxy no longer invokes accessors with itself as receiver.** `Reflect.get` was
  called with the proxy as `receiver`, and `Reflect.get` _invokes_ an accessor — so any getter
  reading a `#private` field threw `Cannot read private member … from an object whose class did
not declare it`, before the `typeof value !== 'function'` guard could skip it. It only surfaced
  with `autoTrace` enabled and real `#private` fields, which is why no fixture caught it.

  `OtelConstants.OptionsKey` is now a registered symbol (`Symbol.for`), so it survives a project
  resolving two copies of this package.

## 1.1.0

### Minor Changes

- db7d54b: ### Microservice messaging instrumentation

  New `otelMessaging(options?)` returns a `MessagingInterceptor` that traces Asena 0.8's microservice layer and propagates W3C trace context across service boundaries:

  ```typescript
  import { otelMessaging } from '@asenajs/asena-otel';

  @Config()
  export class AppConfig extends ConfigService {
    public transport() {
      return {
        microservice: myTransport,
        interceptors: [otelMessaging({ system: 'kafka' })],
      };
    }
  }
  ```

  - **Outgoing** `send` / `emit`: opens a `PRODUCER` span and injects `traceparent` / `tracestate` into the message headers. Because the interceptor _wraps_ the operation rather than firing before it, RPC spans carry the full round-trip duration and error state.
  - **Incoming** handlers: extracts the upstream context from the message headers and runs the handler inside a `CONSUMER` span, linking independent services into one distributed trace.
  - `options.system` sets `messaging.system` on the spans (default `'asena'`). The interceptor is transport-agnostic, so the broker name is declared here.

  Because propagation rides plain message headers, traces also continue across the framework boundary — a foreign producer's `traceparent` on a Kafka external topic is picked up automatically, and Asena's is readable by non-Asena consumers.

  Requires `@asenajs/asena` ≥ 0.8.0 (the `@asenajs/asena/microservice` subpath).

## 1.0.1

### Patch Changes

- e8df87a: Fix unbounded metric cardinality growth (memory leak) caused by unmatched routes

  - Metric attributes now use `http.route` (route pattern, or `'unmatched'` as fallback) instead of `url.path`. Raw URLs no longer become metric labels, so bot/scanner traffic hitting unique 404 paths can no longer create unbounded time series in the OTel SDK metric registry.
  - Defense in depth: `http.server.*` instruments are now guarded by an attribute allow-list view (`createAllowListAttributesProcessor`) permitting only `http.request.method`, `http.response.status_code` and `http.route`.
  - Span attributes are unchanged: spans still record the full `url.path` for debugging, which is safe because spans are not aggregated.

  Verified with a realistic traffic simulation (scanner/attacker/normal personas, heap snapshot accumulator counts stay flat across waves) on both hono and ergenecore adapters.
