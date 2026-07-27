import { describe, expect, test } from 'bun:test';
import { Controller, Service } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { OtelTracingPostProcessor } from '../lib/postprocessor/OtelTracingPostProcessor';

/**
 * Two things this package got wrong around inheritance, neither of which any fixture could
 * expose because every traced class in the existing suite is flat:
 *
 * 1. `getComponentType` read the component-type marker off the prototype chain, so a
 *    @Controller extending a @Service base answered SERVICE (checked first) and was traced
 *    under the wrong autoTrace policy with the wrong span name.
 * 2. The tracing Proxy called `Reflect.get(target, prop, receiver)` with the *proxy* as
 *    receiver. `Reflect.get` invokes accessors, so any getter reading a `#private` field threw
 *    before the `typeof value !== 'function'` guard could skip it.
 */

@Service()
class AuditServiceBase {
  public audit(): string {
    return 'audited';
  }
}

@Controller('/reports')
class ReportController extends AuditServiceBase {
  @Get('/list')
  public list(): string {
    return 'listed';
  }
}

const postProcessorFor = (autoTrace: Record<string, boolean>) => {
  const processor = new OtelTracingPostProcessor();

  // The SDK is not booted here - only the component-type decision and the proxy matter.
  (processor as any).autoTraceConfig = autoTrace;
  (processor as any).tracer = {
    startSpan: () => ({
      setStatus: () => {},
      recordException: () => {},
      setAttribute: () => {},
      end: () => {},
    }),
  };

  return processor;
};

describe('component type resolution', () => {
  test('a @Controller extending a @Service base is a CONTROLLER, not a SERVICE', () => {
    const processor: any = postProcessorFor({});

    expect(processor.getComponentType(ReportController)).toBe('CONTROLLER');
  });

  test('the base class is still a SERVICE in its own right', () => {
    const processor: any = postProcessorFor({});

    expect(processor.getComponentType(AuditServiceBase)).toBe('SERVICE');
  });

  test('autoTrace policy follows the concrete class, not the base', () => {
    // services off, controllers on -> the controller must be wrapped even though its base is a
    // @Service. Under the old chained read it resolved as SERVICE and was skipped entirely.
    const processor: any = postProcessorFor({ services: false, controllers: true });
    const instance = new ReportController();
    const traced = processor.postProcess(instance, ReportController);

    expect(traced).not.toBe(instance);
    expect(traced.list()).toBe('listed');
  });
});

describe('proxy accessor handling', () => {
  test('a getter reading a #private field does not throw under autoTrace', () => {
    @Service()
    class PricingService {
      readonly #rates = new Map<string, number>([['usd', 1]]);

      public get rates(): Map<string, number> {
        return this.#rates;
      }

      public lookup(code: string): number | undefined {
        return this.#rates.get(code);
      }
    }

    const processor: any = postProcessorFor({ services: true });
    const traced = processor.postProcess(new PricingService(), PricingService);

    // Reading the accessor used to throw:
    // "Cannot read private member #rates from an object whose class did not declare it"
    expect(() => traced.rates).not.toThrow();
    expect(traced.rates.get('usd')).toBe(1);
    expect(traced.lookup('usd')).toBe(1);
  });

  test('inherited methods are still traced', () => {
    const processor: any = postProcessorFor({ controllers: true });
    const traced = processor.postProcess(new ReportController(), ReportController);

    // `audit` lives on the base class - the proxy is a lazy get trap, so it is reached through
    // the prototype chain rather than an own-property scan.
    expect(traced.audit()).toBe('audited');
  });
});
