/**
 * Pure retry policy: which upstream failures are retried and how long to wait.
 * The Host plugin reads live settings and owns all side effects.
 */
/** Serializable failure facts as the agent loop hands them over (`LlmFailure`). */
export interface FailureFacts {
    readonly message: string;
    readonly code: string;
    readonly status?: number;
    readonly providerRetryAfterMs?: number;
}
export interface RetrySettings {
    /** Master switch; off leaves every failure to the built-in recovery chain. */
    enabled: boolean;
    /** Retries after the first failed request, counted per agent step. */
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    /** Symmetric random spread around each local delay, 0..1. */
    jitterRatio: number;
    /** Use the provider's Retry-After (capped at maxDelayMs) instead of local backoff. */
    respectRetryAfter: boolean;
    /** HTTP statuses that are retried. */
    statusCodes: number[];
    /** Provider-neutral failure codes that are retried. */
    codes: string[];
    /** Case-insensitive regular expressions tested against the failure message. */
    messagePatterns: string[];
    /** Failure codes never retried, even when a rule above matches. */
    excludeCodes: string[];
    /** Provider ids this plugin handles; empty handles every provider. */
    providers: string[];
    /** Keep answer text streamed before a failure as a truncated reply instead of discarding it. */
    keepPartial: boolean;
}
export declare const DEFAULT_SETTINGS: Readonly<RetrySettings>;
export declare const LIMITS: Readonly<{
    maxRetries: 100;
    maxDelayMs: 3600000;
    /** Messages beyond this length are tested by prefix, bounding custom-pattern cost. */
    messageLength: 4000;
}>;
export type Verdict = {
    kind: 'retry';
    reason: string;
} | {
    kind: 'excluded';
    reason: string;
} | {
    kind: 'unmatched';
};
/**
 * Read one consistent snapshot of the live configuration.
 * @param config - the plugin Config, with or without volatile references.
 * @returns settings with defaults and bounds applied.
 */
export declare function readSettings(config: Record<string, unknown> | undefined): RetrySettings;
/**
 * Compile message patterns, skipping invalid ones.
 * @param patterns - regular expression sources.
 * @param onInvalid - called once per pattern that does not compile.
 * @returns compiled case-insensitive expressions.
 */
export declare function compilePatterns(patterns: readonly string[], onInvalid?: (pattern: string, error: unknown) => void): RegExp[];
/**
 * Decide whether one failure belongs to this plugin's retry rules.
 * Exclusions win; then status, code and message rules match in that order.
 */
export declare function classify(failure: FailureFacts, settings: RetrySettings, patterns: readonly RegExp[]): Verdict;
/**
 * Delay before the given retry: provider Retry-After when allowed, else
 * exponential backoff with symmetric jitter, both capped at maxDelayMs.
 * @param retry - 1-based retry number.
 */
export declare function retryDelay(failure: FailureFacts, settings: RetrySettings, retry: number, random?: () => number): number;
