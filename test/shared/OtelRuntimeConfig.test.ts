import { describe, expect, it, beforeEach } from 'bun:test';
import { isRouteIgnored, otelRuntimeConfig } from '../../lib/shared/OtelRuntimeConfig';

describe('OtelRuntimeConfig', () => {
  beforeEach(() => {
    otelRuntimeConfig.ignoreRoutes = [];
  });

  describe('isRouteIgnored', () => {
    it('should return false when ignoreRoutes is empty', () => {
      expect(isRouteIgnored('/api/users')).toBe(false);
    });

    it('should return true for exact match', () => {
      otelRuntimeConfig.ignoreRoutes = ['/health'];

      expect(isRouteIgnored('/health')).toBe(true);
    });

    it('should return false for non-matching path', () => {
      otelRuntimeConfig.ignoreRoutes = ['/health'];

      expect(isRouteIgnored('/api/users')).toBe(false);
    });

    it('should return true for wildcard prefix match', () => {
      otelRuntimeConfig.ignoreRoutes = ['/internal/*'];

      expect(isRouteIgnored('/internal/debug')).toBe(true);
      expect(isRouteIgnored('/internal/metrics')).toBe(true);
    });

    it('should return false for partial non-match with wildcard', () => {
      otelRuntimeConfig.ignoreRoutes = ['/internal/*'];

      expect(isRouteIgnored('/internals')).toBe(false);
    });

    it('should support multiple ignore rules', () => {
      otelRuntimeConfig.ignoreRoutes = ['/health', '/metrics', '/admin/*'];

      expect(isRouteIgnored('/health')).toBe(true);
      expect(isRouteIgnored('/metrics')).toBe(true);
      expect(isRouteIgnored('/admin/settings')).toBe(true);
      expect(isRouteIgnored('/api/users')).toBe(false);
    });

    it('should handle wildcard matching the prefix exactly', () => {
      otelRuntimeConfig.ignoreRoutes = ['/admin/*'];

      // '/admin/' starts with '/admin/' -> true
      expect(isRouteIgnored('/admin/')).toBe(true);
    });
  });
});
