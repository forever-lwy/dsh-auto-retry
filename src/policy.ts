/**
 * Pure retry policy: which upstream failures are retried and how long to wait.
 * The Host plugin reads live settings and owns all side effects.
 */

/** Serializable failure facts as the agent loop hands them over (`LlmFailure`). */
export interface FailureFacts {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
}

export interface RetrySettings {
  /** Master switch; off leaves every failure to the built-in recovery chain. */
  enabled: boolean
  /** Retries after the first failed request, counted per agent step. */
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  /** Symmetric random spread around each local delay, 0..1. */
  jitterRatio: number
  /** Use the provider's Retry-After (capped at maxDelayMs) instead of local backoff. */
  respectRetryAfter: boolean
  /** HTTP statuses that are retried. */
  statusCodes: number[]
  /** Provider-neutral failure codes that are retried. */
  codes: string[]
  /** Case-insensitive regular expressions tested against the failure message. */
  messagePatterns: string[]
  /** Failure codes never retried, even when a rule above matches. */
  excludeCodes: string[]
  /** Provider ids this plugin handles; empty handles every provider. */
  providers: string[]
}

export const DEFAULT_SETTINGS: Readonly<RetrySettings> = Object.freeze({
  enabled: true,
  maxRetries: 5,
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  jitterRatio: 0.2,
  respectRetryAfter: true,
  // 52x are Cloudflare origin errors (524 = origin timeout), 529 = overloaded.
  statusCodes: [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529],
  // dsh-llm-deepseek / pi-ai use SERVER and TRANSPORT; dsh-google-native uses SERVER_ERROR and NETWORK.
  codes: ['RATE_LIMIT', 'SERVER', 'SERVER_ERROR', 'TIMEOUT', 'TRANSPORT', 'NETWORK', 'EMPTY_RESPONSE', 'OVERLOADED'],
  messagePatterns: [
    '\\b(?:408|429|50[0234]|52[0-9])\\b',
    '\\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\\b',
    'socket hang up|other side closed|fetch failed|premature close|network error|stream ended (?:before|without)',
    'overloaded|temporarily unavailable|try again later',
  ],
  excludeCodes: [
    'ABORTED', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'INVALID_CONFIG', 'INVALID_CREDENTIAL',
    'MISSING_CREDENTIAL', 'MODEL_NOT_FOUND', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED',
  ],
  providers: [],
})

export const LIMITS = Object.freeze({
  maxRetries: 100,
  maxDelayMs: 3_600_000,
  /** Messages beyond this length are tested by prefix, bounding custom-pattern cost. */
  messageLength: 4000,
})

export type Verdict =
  | { kind: 'retry'; reason: string }
  | { kind: 'excluded'; reason: string }
  | { kind: 'unmatched' }

/** Volatile Config fields arrive as Loader references; plain objects arrive in tests and older hosts. */
function live<T>(value: unknown): T | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T | undefined
}

function finite(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

function strings(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [...fallback]
}

/**
 * Read one consistent snapshot of the live configuration.
 * @param config - the plugin Config, with or without volatile references.
 * @returns settings with defaults and bounds applied.
 */
export function readSettings(config: Record<string, unknown> | undefined): RetrySettings {
  const raw = (key: keyof RetrySettings) => live<unknown>(config?.[key])
  const d = DEFAULT_SETTINGS
  const initialDelayMs = finite(raw('initialDelayMs'), 0, LIMITS.maxDelayMs, d.initialDelayMs)
  const statusCodes = Array.isArray(raw('statusCodes'))
    ? (raw('statusCodes') as unknown[]).filter((code): code is number => Number.isInteger(code) && (code as number) >= 100 && (code as number) <= 599)
    : [...d.statusCodes]
  return {
    enabled: typeof raw('enabled') === 'boolean' ? raw('enabled') as boolean : d.enabled,
    maxRetries: Math.floor(finite(raw('maxRetries'), 0, LIMITS.maxRetries, d.maxRetries)),
    initialDelayMs,
    maxDelayMs: Math.max(initialDelayMs, finite(raw('maxDelayMs'), 0, LIMITS.maxDelayMs, d.maxDelayMs)),
    jitterRatio: finite(raw('jitterRatio'), 0, 1, d.jitterRatio),
    respectRetryAfter: typeof raw('respectRetryAfter') === 'boolean' ? raw('respectRetryAfter') as boolean : d.respectRetryAfter,
    statusCodes,
    codes: strings(raw('codes'), d.codes),
    messagePatterns: strings(raw('messagePatterns'), d.messagePatterns),
    excludeCodes: strings(raw('excludeCodes'), d.excludeCodes),
    providers: strings(raw('providers'), d.providers),
  }
}

/**
 * Compile message patterns, skipping invalid ones.
 * @param patterns - regular expression sources.
 * @param onInvalid - called once per pattern that does not compile.
 * @returns compiled case-insensitive expressions.
 */
export function compilePatterns(patterns: readonly string[], onInvalid?: (pattern: string, error: unknown) => void): RegExp[] {
  return patterns.flatMap(pattern => {
    try { return [new RegExp(pattern, 'i')] } catch (error) { onInvalid?.(pattern, error); return [] }
  })
}

/**
 * Decide whether one failure belongs to this plugin's retry rules.
 * Exclusions win; then status, code and message rules match in that order.
 */
export function classify(failure: FailureFacts, settings: RetrySettings, patterns: readonly RegExp[]): Verdict {
  if (settings.excludeCodes.includes(failure.code)) return { kind: 'excluded', reason: `code ${failure.code}` }
  if (failure.status !== undefined && settings.statusCodes.includes(failure.status)) return { kind: 'retry', reason: `HTTP ${failure.status}` }
  if (settings.codes.includes(failure.code)) return { kind: 'retry', reason: `code ${failure.code}` }
  const message = typeof failure.message === 'string' ? failure.message.slice(0, LIMITS.messageLength) : ''
  for (const pattern of patterns) {
    if (pattern.test(message)) return { kind: 'retry', reason: `message /${pattern.source}/` }
  }
  return { kind: 'unmatched' }
}

/**
 * Delay before the given retry: provider Retry-After when allowed, else
 * exponential backoff with symmetric jitter, both capped at maxDelayMs.
 * @param retry - 1-based retry number.
 */
export function retryDelay(failure: FailureFacts, settings: RetrySettings, retry: number, random: () => number = Math.random): number {
  const providerDelay = failure.providerRetryAfterMs
  if (settings.respectRetryAfter && typeof providerDelay === 'number' && Number.isFinite(providerDelay) && providerDelay > 0) {
    return Math.min(providerDelay, settings.maxDelayMs)
  }
  const exponential = Math.min(settings.initialDelayMs * 2 ** Math.min(retry - 1, 30), settings.maxDelayMs)
  const jitter = 1 - settings.jitterRatio + 2 * settings.jitterRatio * random()
  return Math.round(Math.min(exponential * jitter, settings.maxDelayMs))
}
