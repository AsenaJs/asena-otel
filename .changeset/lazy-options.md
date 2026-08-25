---
"@asenajs/asena-otel": minor
---

`@Otel` now also accepts a thunk returning the options: `@Otel(() => ({ serviceName: process.env.SERVICE_NAME!, ... }))`. The thunk runs when the post-processor initialises (`onInit`), not at decoration time, so per-service values can be read from the environment and the decorated `AppOtel` class can live in a shared package. It is called once per post-processor instance and the result is cached. The plain options-object form is unchanged.
