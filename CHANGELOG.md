# @asenajs/asena-otel

## 1.0.1

### Patch Changes

- e8df87a: Fix unbounded metric cardinality growth (memory leak) caused by unmatched routes

  - Metric attributes now use `http.route` (route pattern, or `'unmatched'` as fallback) instead of `url.path`. Raw URLs no longer become metric labels, so bot/scanner traffic hitting unique 404 paths can no longer create unbounded time series in the OTel SDK metric registry.
  - Defense in depth: `http.server.*` instruments are now guarded by an attribute allow-list view (`createAllowListAttributesProcessor`) permitting only `http.request.method`, `http.response.status_code` and `http.route`.
  - Span attributes are unchanged: spans still record the full `url.path` for debugging, which is safe because spans are not aggregated.

  Verified with a realistic traffic simulation (scanner/attacker/normal personas, heap snapshot accumulator counts stay flat across waves) on both hono and ergenecore adapters.
