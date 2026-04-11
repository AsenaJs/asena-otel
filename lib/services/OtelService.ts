import { trace, metrics, context, propagation, type Tracer, type Meter, type Span } from '@opentelemetry/api';
import { Service } from '@asenajs/asena/decorators';
import { PostConstruct } from '@asenajs/asena/decorators/ioc';

const LIBRARY_NAME = '@asenajs/asena-otel';

@Service('OtelService')
export class OtelService {

  private _tracer!: Tracer;

  private _meter!: Meter;

  @PostConstruct()
  public onInit() {
    this._tracer = trace.getTracer(LIBRARY_NAME);
    this._meter = metrics.getMeter(LIBRARY_NAME);
  }

  public get tracer(): Tracer {
    return this._tracer;
  }

  public get meter(): Meter {
    return this._meter;
  }

  public async withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this._tracer.startActiveSpan(name, async (span) => {
      try {
        const result = await fn(span);

        span.setStatus({ code: 1 }); // SpanStatusCode.OK

        return result;
      } catch (error) {
        span.setStatus({ code: 2 }); // SpanStatusCode.ERROR
        span.recordException(error as Error);

        throw error;
      } finally {
        span.end();
      }
    });
  }

  public getActiveSpan(): Span | undefined {
    return trace.getSpan(context.active());
  }

  public injectTraceContext(headers: Record<string, string> = {}): Record<string, string> {
    propagation.inject(context.active(), headers);

    return headers;
  }

}