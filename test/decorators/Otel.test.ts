import { describe, expect, test } from 'bun:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { Otel } from '../../lib/decorators/Otel';
import { OtelConstants } from '../../lib/constants/OtelConstants';
import { OtelTracingPostProcessor } from '../../lib/postprocessor/OtelTracingPostProcessor';
import { getOwnTypedMetadata } from '@asenajs/asena/utils';
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
});
