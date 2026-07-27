import { context as otelContext, propagation, SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import type { MessageContext, MessagingInterceptor, OutboundContext } from '@asenajs/asena/microservice';

const LIBRARY_NAME = '@asenajs/asena-otel';

/**
 * Options for the messaging instrumentation
 */
export interface OtelMessagingOptions {
  /**
   * Value reported as `messaging.system` on spans (e.g. 'redis', 'nats').
   * The interceptor is transport-agnostic, so the system name is declared here.
   * @default 'asena'
   */
  system?: string;
}

/**
 * @description Creates a MessagingInterceptor that instruments Asena microservice
 * messaging with OpenTelemetry spans and W3C trace context propagation.
 *
 * - Outgoing send/emit: opens a PRODUCER span and injects `traceparent`/`tracestate`
 *   into the message headers. Because the interceptor wraps the operation, RPC spans
 *   carry the full round-trip duration and error state.
 * - Incoming handler: extracts the upstream context from the message headers and runs
 *   the handler inside a CONSUMER span - linking services into one distributed trace.
 *
 * @example
 * // In your @Config class
 * transport() {
 *   return {
 *     microservice: new RedisMicroserviceTransport({ url, serviceName: 'order-service' }),
 *     interceptors: [otelMessaging({ system: 'redis' })],
 *   };
 * }
 */
export function otelMessaging(options: OtelMessagingOptions = {}): MessagingInterceptor {
  return new OtelMessagingInterceptor(options.system ?? 'asena');
}

class OtelMessagingInterceptor implements MessagingInterceptor {
  private readonly tracer: Tracer;

  public constructor(private readonly system: string) {
    this.tracer = trace.getTracer(LIBRARY_NAME);
  }

  public async onSend(ctx: OutboundContext, next: () => Promise<any>): Promise<any> {
    const operation = ctx.kind === 'send' ? 'send' : 'publish';

    return this.tracer.startActiveSpan(
      `${operation} ${ctx.pattern}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': this.system,
          'messaging.destination.name': ctx.pattern,
          'messaging.operation.type': operation,
        },
      },
      async (span) => {
        // Inject with the span set on the context explicitly - a registered
        // context manager cannot be assumed, and without one context.active()
        // would not carry the producer span
        propagation.inject(trace.setSpan(otelContext.active(), span), ctx.headers);

        try {
          const result = await next();

          span.setStatus({ code: SpanStatusCode.OK });

          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  public async onReceive(ctx: MessageContext, next: () => Promise<any>): Promise<any> {
    const parentContext = propagation.extract(otelContext.active(), ctx.headers);

    const attributes: Record<string, string | number> = {
      'messaging.system': this.system,
      'messaging.destination.name': ctx.pattern,
      'messaging.operation.type': 'process',
      'messaging.message.id': ctx.messageId,
    };

    if (ctx.attempt > 1) {
      attributes['messaging.redelivery_count'] = ctx.attempt - 1;
    }

    return this.tracer.startActiveSpan(
      `process ${ctx.pattern}`,
      { kind: SpanKind.CONSUMER, attributes },
      parentContext,
      async (span) => {
        try {
          const result = await next();

          span.setStatus({ code: SpanStatusCode.OK });

          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
