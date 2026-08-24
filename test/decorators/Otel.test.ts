import { afterEach, describe, expect, test } from 'bun:test';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { Otel } from '../../lib/decorators/Otel';
import { OtelConstants } from '../../lib/constants/OtelConstants';
import { OtelTracingPostProcessor } from '../../lib/postprocessor/OtelTracingPostProcessor';
import { getOwnTypedMetadata } from '@asenajs/asena/utils';
import { cleanupOtel } from '../utils/otelTestUtils';
import type { AsenaOtelOptions } from '../../lib/OtelConfig';

describe('@Otel Decorator', () => {
  test('should store AsenaOtelOptions in metadata', () => {
    const exporter = new InMemorySpanExporter();

    @Otel({
      serviceName: 'test-app',
      traceExporter: exporter,
      autoTrace: { services: true },
    })
    class TestOtel extends OtelTracingPostProcessor {}

    const meta = getOwnTypedMetadata<AsenaOtelOptions>(OtelConstants.OptionsKey, TestOtel);

    expect(meta).toBeDefined();
    expect(meta!.serviceName).toBe('test-app');
    expect(meta!.traceExporter).toBe(exporter);
    expect(meta!.autoTrace).toEqual({ services: true });
  });

  test('should not set metadata on non-decorated class', () => {
    class PlainOtel extends OtelTracingPostProcessor {}

    const meta = getOwnTypedMetadata<AsenaOtelOptions>(OtelConstants.OptionsKey, PlainOtel);

    expect(meta).toBeUndefined();
  });

  test('should preserve class name', () => {
    const exporter = new InMemorySpanExporter();

    @Otel({ serviceName: 'test', traceExporter: exporter })
    class AppOtel extends OtelTracingPostProcessor {}

    expect(AppOtel.name).toBe('AppOtel');
  });

  test('should apply PostProcessor metadata', () => {
    const exporter = new InMemorySpanExporter();

    @Otel({ serviceName: 'test', traceExporter: exporter })
    class DecoratedOtel extends OtelTracingPostProcessor {}

    // PostProcessor decorator sets POST_PROCESSOR metadata
    const isPostProcessor = getOwnTypedMetadata<boolean>('POST_PROCESSOR' as any, DecoratedOtel);

    expect(isPostProcessor).toBe(true);
  });

  test('should store optional serviceVersion', () => {
    const exporter = new InMemorySpanExporter();

    @Otel({
      serviceName: 'versioned-app',
      serviceVersion: '2.0.0',
      traceExporter: exporter,
    })
    class VersionedOtel extends OtelTracingPostProcessor {}

    const meta = getOwnTypedMetadata<AsenaOtelOptions>(OtelConstants.OptionsKey, VersionedOtel);

    expect(meta!.serviceVersion).toBe('2.0.0');
  });

  test('should store a thunk as-is without invoking it', () => {
    let calls = 0;

    const thunk = (): AsenaOtelOptions => {
      calls++;

      return { serviceName: 'lazy-app', traceExporter: new InMemorySpanExporter() };
    };

    @Otel(thunk)
    class LazyOtel extends OtelTracingPostProcessor {}

    const meta = getOwnTypedMetadata<() => AsenaOtelOptions>(OtelConstants.OptionsKey, LazyOtel);

    expect(meta).toBe(thunk);
    expect(calls).toBe(0);
  });

  test('should resolve a thunk exactly once across onInit and postProcess', async () => {
    let calls = 0;

    // The OTel global registry refuses to overwrite an installed manager, so drop any previous
    // one first - otherwise onInit() silently keeps it.
    context.disable();

    const exporter = new InMemorySpanExporter();

    @Otel(() => {
      calls++;

      return {
        serviceName: 'lazy-service',
        traceExporter: exporter,
        autoTrace: { services: true },
      };
    })
    class LazyOtel extends OtelTracingPostProcessor {}

    const processor = new LazyOtel();

    processor.onInit();

    class MyService {
      doWork() {
        return 'result';
      }
    }

    processor.postProcess(new MyService(), MyService);
    processor.postProcess(new MyService(), MyService);
    processor.postProcess(new MyService(), MyService);

    expect(calls).toBe(1);

    const span = trace.getTracer('lazy-options-test').startSpan('probe');

    span.end();
    await processor.forceFlush();

    const spans = exporter.getFinishedSpans();

    expect(spans.length).toBe(1);
    expect(spans[0].resource.attributes[ATTR_SERVICE_NAME]).toBe('lazy-service');

    await processor.shutdown();
    await cleanupOtel();
  });

  afterEach(async () => {
    await cleanupOtel();
  });
});
