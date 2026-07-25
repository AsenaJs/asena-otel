---
'@asenajs/asena-otel': minor
---

### Microservice messaging instrumentation

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

- **Outgoing** `send` / `emit`: opens a `PRODUCER` span and injects `traceparent` / `tracestate` into the message headers. Because the interceptor *wraps* the operation rather than firing before it, RPC spans carry the full round-trip duration and error state.
- **Incoming** handlers: extracts the upstream context from the message headers and runs the handler inside a `CONSUMER` span, linking independent services into one distributed trace.
- `options.system` sets `messaging.system` on the spans (default `'asena'`). The interceptor is transport-agnostic, so the broker name is declared here.

Because propagation rides plain message headers, traces also continue across the framework boundary — a foreign producer's `traceparent` on a Kafka external topic is picked up automatically, and Asena's is readable by non-Asena consumers.

Requires `@asenajs/asena` ≥ 0.8.0 (the `@asenajs/asena/microservice` subpath).