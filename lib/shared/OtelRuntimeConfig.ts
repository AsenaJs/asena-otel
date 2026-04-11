export const otelRuntimeConfig = {
  ignoreRoutes: [] as string[],
};

/**
 * Check if a route path should be excluded from tracing.
 * Supports exact match and wildcard suffix (e.g., `/admin/*`).
 */
export function isRouteIgnored(path: string): boolean {
  for (const route of otelRuntimeConfig.ignoreRoutes) {
    if (route.endsWith('*')) {
      if (path.startsWith(route.slice(0, -1))) return true;
    } else {
      if (path === route) return true;
    }
  }

  return false;
}