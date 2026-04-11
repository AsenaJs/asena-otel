import { ParentBasedSampler, TraceIdRatioBasedSampler, type Sampler } from '@opentelemetry/sdk-trace-base';

/**
 * Creates a production-ready ratio-based sampler.
 * Root spans are sampled at the given ratio; child spans respect the parent's decision.
 *
 * @param ratio - Fraction of traces to sample (0.0 to 1.0). Default 0.1 (10%).
 */
export function ratioBasedSampler(ratio = 0.1): Sampler {
  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(ratio),
  });
}