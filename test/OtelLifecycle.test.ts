import { afterEach, describe, expect, it } from 'bun:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { context } from '@opentelemetry/api';
import { Container } from '@asenajs/asena/container';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';
import { OtelTracingPostProcessor } from '../lib/postprocessor/OtelTracingPostProcessor';
import { Otel } from '../lib/decorators/Otel';
import { cleanupOtel } from './utils/otelTestUtils';
import type { ServerLogger } from '@asenajs/asena/logger';

function createLogger(): { logger: ServerLogger; errors: string[] } {
  const errors: string[] = [];

  return {
    errors,
    logger: {
      info: () => {},
      warn: () => {},
      error: (message: string) => errors.push(message),
      profile: () => {},
    },
  };
}

async function registerProcessor(serviceName: string): Promise<{
  container: Container;
  processor: OtelTracingPostProcessor;
  logger: ServerLogger;
  errors: string[];
}> {
  const { logger, errors } = createLogger();

  // Same order the real boot uses: the logger is a core service registered in phase 2, long
  // before the post-processors are constructed in phase A.
  const container = new Container();

  await container.registerInstance(ICoreServiceNames.SERVER_LOGGER, logger);

  @Otel({ serviceName, traceExporter: new InMemorySpanExporter() })
  class AppOtel extends OtelTracingPostProcessor {}

  await container.register('AppOtel', AppOtel, true);

  const processor = (await container.resolve<OtelTracingPostProcessor>('AppOtel')) as OtelTracingPostProcessor;

  return { container, processor, logger, errors };
}

/**
 * The processor's teardown is only reachable if the container agrees to drive it, so these go
 * through the real Container rather than calling the methods directly: the injected logger has to
 * resolve, the class has to be tracked as a started singleton, and `shutdown` has to show up in
 * the stop-hook list. A metadata assertion alone would still pass if any of that broke.
 */
describe('OtelTracingPostProcessor lifecycle wiring', () => {
  afterEach(async () => {
    await cleanupOtel();
    context.disable();
  });

  it('should receive the server logger from the container', async () => {
    const { processor, logger } = await registerProcessor('lifecycle-logger');

    expect((processor as any)['serverLogger']).toBe(logger);

    await processor.shutdown();
  });

  it('should be tracked as an already-started singleton', async () => {
    const { container, processor } = await registerProcessor('lifecycle-tracked');
    const tracked = container.lifecycle.find((component) => component.key === 'AppOtel');

    expect(tracked).toBeDefined();
    // Immediate mode: the start hook ran inside register(), which is what makes the component
    // eligible for its stop hooks the moment server.stop() walks the list.
    expect(tracked!.started).toBe(true);
    expect(tracked!.instance).toBe(processor);

    await processor.shutdown();
  });

  it('should release both providers when the container runs its stop hooks', async () => {
    const { container, processor } = await registerProcessor('lifecycle-stop');
    const stopHooks = container.getStopHooks((processor as any).constructor);

    expect(stopHooks).toContain('shutdown');
    expect((processor as any)['tracerProvider']).not.toBeNull();

    for (const hook of stopHooks) {
      await (processor as any)[hook]();
    }

    expect((processor as any)['tracerProvider']).toBeNull();
    expect((processor as any)['meterProvider']).toBeNull();
  });

  it('should report a failing provider through the injected logger instead of throwing', async () => {
    const { container, processor, errors } = await registerProcessor('lifecycle-failure');
    const tracerProvider = (processor as any)['tracerProvider'];
    const realShutdown = tracerProvider.shutdown.bind(tracerProvider);

    tracerProvider.shutdown = () => Promise.reject(new Error('collector unreachable'));

    for (const hook of container.getStopHooks((processor as any).constructor)) {
      await expect((processor as any)[hook]()).resolves.toBeUndefined();
    }

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('collector unreachable');

    await realShutdown();
  });
});
