<p width="%100" align="center">
  <img src="https://avatars.githubusercontent.com/u/179836938?s=200&v=4" width="150" align="center"/>
</p>

# @asenajs/asena-otel

[![Version](https://img.shields.io/npm/v/@asenajs/asena-otel.svg)](https://github.com/AsenaJs/asena-otel)
[![Bun Version](https://img.shields.io/badge/Bun-1.4%2B-blueviolet)](https://bun.sh)

OpenTelemetry integration for AsenaJS — automatic HTTP tracing, method-level auto-tracing, metrics, and distributed tracing.

**Requirements:** Bun 1.4+, `@asenajs/asena` 0.11+.

## Installation

```bash
bun add @asenajs/asena-otel @opentelemetry/api @opentelemetry/resources @opentelemetry/sdk-trace-base @opentelemetry/sdk-metrics @opentelemetry/semantic-conventions @opentelemetry/context-async-hooks
```

## Quick Start

```typescript
// src/otel/AppOtel.ts
import { Otel, OtelTracingPostProcessor } from '@asenajs/asena-otel';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';

@Otel({
  serviceName: 'my-app',
  traceExporter: new ConsoleSpanExporter(),
  autoTrace: { services: true, controllers: true },
})
export class AppOtel extends OtelTracingPostProcessor {}
```

```typescript
// src/middlewares/AppOtelMiddleware.ts
import { Middleware } from '@asenajs/asena/decorators';
import { OtelTracingMiddleware } from '@asenajs/asena-otel';

@Middleware()
export class AppOtelMiddleware extends OtelTracingMiddleware {}
```

```typescript
// src/config/AppConfig.ts
import { Config } from '@asenajs/asena/decorators';
import { ConfigService } from '@asenajs/ergenecore';
import { AppOtelMiddleware } from '../middlewares/AppOtelMiddleware';

@Config()
export class AppConfig extends ConfigService {
  public globalMiddlewares() {
    return [AppOtelMiddleware];
  }
}
```

Every request now produces a `SERVER` span with `@Controller` and `@Service` calls nested beneath it.

## Documentation

Full documentation: [asena.sh/docs/packages/opentelemetry](https://asena.sh/docs/packages/opentelemetry)

## License

MIT
