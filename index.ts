// Decorator
export { Otel } from './lib/decorators';

// Constants
export { OtelConstants } from './lib/constants/OtelConstants';

// PostProcessor
export { OtelTracingPostProcessor } from './lib/postprocessor/OtelTracingPostProcessor';

// Service
export { OtelService } from './lib/services/OtelService';

// Middleware
export { OtelTracingMiddleware } from './lib/middleware/OtelTracingMiddleware';

// Samplers
export { ratioBasedSampler } from './lib/samplers';

// Runtime config utilities
export { isRouteIgnored } from './lib/shared/OtelRuntimeConfig';

// Microservice messaging instrumentation
export { otelMessaging } from './lib/messaging/OtelMessagingInterceptor';
export type { OtelMessagingOptions } from './lib/messaging/OtelMessagingInterceptor';

// Types
export type { AsenaOtelOptions, AutoTraceConfig } from './lib/types';
export type { Sampler } from '@opentelemetry/sdk-trace-base';