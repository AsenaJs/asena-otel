import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemoryTransport, composeOnReceive, composeOnSend } from '@asenajs/asena/microservice';
import type { MessageContext, OutboundContext } from '@asenajs/asena/microservice';
import { otelMessaging } from '../lib/messaging/OtelMessagingInterceptor';
import { cleanupOtel, createTestOtelSdk, type TestOtelSdk } from './utils/otelTestUtils';

describe('otelMessaging interceptor', () => {
  let sdk: TestOtelSdk;

  beforeEach(() => {
    sdk = createTestOtelSdk({ serviceName: 'messaging-test' });
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterEach(async () => {
    await cleanupOtel(sdk);
  });

  /**
   * Simulates the full framework flow: Ulak composes onSend around the transport
   * call, PrepareMicroserviceService composes onReceive around the handler.
   */
  async function roundTrip(handlerBehavior?: () => any) {
    const interceptor = otelMessaging({ system: 'in-memory' });
    const transport = new InMemoryTransport();

    const rawHandler = async () => (handlerBehavior ? handlerBehavior() : 'reply');

    transport.registerMessageHandler('order.create', (data, context: MessageContext) =>
      composeOnReceive([interceptor], context, () => Promise.resolve(rawHandler())),
    );

    const ctx: OutboundContext = { pattern: 'order.create', kind: 'send', headers: {}, data: {} };

    const result = await composeOnSend([interceptor], ctx, () =>
      transport.send('order.create', {}, { headers: ctx.headers }),
    );

    return { result, headers: ctx.headers };
  }

  test('should link producer and consumer spans into one trace', async () => {
    const { result, headers } = await roundTrip();

    expect(result).toBe('reply');

    // traceparent was injected into outgoing headers
    expect(headers['traceparent']).toBeDefined();

    const spans = sdk.spanExporter.getFinishedSpans();

    expect(spans).toHaveLength(2);

    const consumer = spans.find((span) => span.kind === SpanKind.CONSUMER);
    const producer = spans.find((span) => span.kind === SpanKind.PRODUCER);

    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();

    // Same trace, consumer is a child of the producer span
    expect(consumer.spanContext().traceId).toBe(producer.spanContext().traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);
  });

  test('should name spans and set messaging attributes', async () => {
    await roundTrip();

    const spans = sdk.spanExporter.getFinishedSpans();
    const producer = spans.find((span) => span.kind === SpanKind.PRODUCER);
    const consumer = spans.find((span) => span.kind === SpanKind.CONSUMER);

    expect(producer.name).toBe('send order.create');
    expect(producer.attributes['messaging.system']).toBe('in-memory');
    expect(producer.attributes['messaging.destination.name']).toBe('order.create');
    expect(producer.attributes['messaging.operation.type']).toBe('send');

    expect(consumer.name).toBe('process order.create');
    expect(consumer.attributes['messaging.operation.type']).toBe('process');
    expect(consumer.attributes['messaging.message.id']).toBeDefined();
  });

  test('should record errors on both spans when the handler throws', async () => {
    try {
      await roundTrip(() => {
        throw new Error('handler exploded');
      });
      expect.unreachable();
    } catch {
      // expected
    }

    const spans = sdk.spanExporter.getFinishedSpans();
    const producer = spans.find((span) => span.kind === SpanKind.PRODUCER);
    const consumer = spans.find((span) => span.kind === SpanKind.CONSUMER);

    expect(consumer.status.code).toBe(SpanStatusCode.ERROR);
    expect(producer.status.code).toBe(SpanStatusCode.ERROR);

    const consumerEvents = consumer.events.map((event) => event.name);

    expect(consumerEvents).toContain('exception');
  });

  test('should use publish operation name for emits', async () => {
    const interceptor = otelMessaging();
    const transport = new InMemoryTransport();

    transport.registerEventHandler('order.created', async () => {});

    const ctx: OutboundContext = { pattern: 'order.created', kind: 'emit', headers: {}, data: {} };

    await composeOnSend([interceptor], ctx, () => transport.emit('order.created', {}, { headers: ctx.headers }));

    const spans = sdk.spanExporter.getFinishedSpans();
    const producer = spans.find((span) => span.kind === SpanKind.PRODUCER);

    expect(producer.name).toBe('publish order.created');
    expect(producer.attributes['messaging.operation.type']).toBe('publish');
    expect(producer.attributes['messaging.system']).toBe('asena');
  });

  test('should mark redeliveries on the consumer span', async () => {
    const interceptor = otelMessaging();

    const context: MessageContext = {
      pattern: 'payment.completed',
      messageId: 'msg-1',
      headers: {},
      timestamp: Date.now(),
      attempt: 3,
    };

    await composeOnReceive([interceptor], context, () => Promise.resolve('ok'));

    const spans = sdk.spanExporter.getFinishedSpans();

    expect(spans[0].attributes['messaging.redelivery_count']).toBe(2);
  });
});
