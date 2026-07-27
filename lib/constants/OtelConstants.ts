/**
 * Metadata constants for OTel decorators.
 * Uses Symbols to prevent naming collisions.
 */
export class OtelConstants {
  /**
   * @Otel() decorator metadata key.
   * Stores AsenaOtelOptions on the PostProcessor subclass.
   */
  public static readonly OptionsKey = Symbol.for('asena:otel:options');
}
