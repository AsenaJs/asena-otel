import { trace, metrics, propagation } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { mock } from 'bun:test';

export interface TestOtelSdk {
  spanExporter: InMemorySpanExporter;
  tracerProvider: BasicTracerProvider;
  metricExporter?: InMemoryMetricExporter;
  metricReader?: PeriodicExportingMetricReader;
  meterProvider?: MeterProvider;
}

export interface TestOtelSdkOptions {
  serviceName?: string;
  serviceVersion?: string;
  withMetrics?: boolean;
}

export function createTestOtelSdk(options: TestOtelSdkOptions = {}): TestOtelSdk {
  const { serviceName = 'test-service', serviceVersion = '1.0.0', withMetrics = false } = options;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });

  trace.setGlobalTracerProvider(tracerProvider);

  const result: TestOtelSdk = { spanExporter, tracerProvider };

  if (withMetrics) {
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 100,
    });
    const meterProvider = new MeterProvider({ resource, readers: [metricReader] });

    metrics.setGlobalMeterProvider(meterProvider);

    result.metricExporter = metricExporter;
    result.metricReader = metricReader;
    result.meterProvider = meterProvider;
  }

  return result;
}

export async function cleanupOtel(sdk?: TestOtelSdk): Promise<void> {
  if (sdk) {
    await sdk.tracerProvider.shutdown();

    if (sdk.meterProvider) {
      await sdk.meterProvider.shutdown();
    }
  }

  trace.disable();
  metrics.disable();
  propagation.disable();
}

export interface MockAsenaContextOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  routePattern?: string;
  responseStatus?: number;
}

export function createMockAsenaContext(options: MockAsenaContextOptions = {}) {
  const { method = 'GET', url = 'http://localhost/test', headers = {}, routePattern, responseStatus } = options;

  const mockRes: Record<string, any> = {};

  if (responseStatus !== undefined) {
    mockRes['status'] = responseStatus;
  }

  return {
    req: {
      method,
      url,
    },
    res: mockRes,
    routePattern,
    headers,
    getArrayBuffer: mock(() => Promise.resolve(new ArrayBuffer(0))),
    getParseBody: mock(() => Promise.resolve({})),
    getBlob: mock(() => Promise.resolve(new Blob())),
    getFormData: mock(() => Promise.resolve(new FormData())),
    getParam: mock((_s: string) => ''),
    getBody: mock(() => Promise.resolve({})),
    getQuery: mock((_q: string) => Promise.resolve('')),
    getQueryAll: mock((_q: string) => Promise.resolve([])),
    getAllQueries: mock(() => ({})),
    getCookie: mock((_name: string) => Promise.resolve('' as string | false)),
    setCookie: mock(() => Promise.resolve()),
    deleteCookie: mock(() => Promise.resolve()),
    getValue: mock((_key: string) => undefined),
    setValue: mock((_key: string, _value: any) => {}),
    setWebSocketValue: mock((_value: any) => {}),
    getWebSocketValue: mock(() => undefined),
    html: mock((_data: string) => new Response()),
    send: mock((_data: any) => new Response()),
    redirect: mock((_url: string) => {}),
  } as any;
}