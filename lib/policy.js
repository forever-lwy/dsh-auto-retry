/**
 * Pure retry policy: which upstream failures are retried and how long to wait.
 * The Host plugin reads live settings and owns all side effects.
 */
export const DEFAULT_SETTINGS = Object.freeze({
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
    keepPartial: true,
});
export const LIMITS = Object.freeze({
    maxRetries: 100,
    maxDelayMs: 3_600_000,
    /** Messages beyond this length are tested by prefix, bounding custom-pattern cost. */
    messageLength: 4000,
});
/** Volatile Config fields arrive as Loader references; plain objects arrive in tests and older hosts. */
function live(value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
function finite(value, min, max, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}
function strings(value, fallback) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [...fallback];
}
/**
 * Read one consistent snapshot of the live configuration.
 * @param config - the plugin Config, with or without volatile references.
 * @returns settings with defaults and bounds applied.
 */
export function readSettings(config) {
    const raw = (key) => live(config?.[key]);
    const d = DEFAULT_SETTINGS;
    const initialDelayMs = finite(raw('initialDelayMs'), 0, LIMITS.maxDelayMs, d.initialDelayMs);
    const statusCodes = Array.isArray(raw('statusCodes'))
        ? raw('statusCodes').filter((code) => Number.isInteger(code) && code >= 100 && code <= 599)
        : [...d.statusCodes];
    return {
        enabled: typeof raw('enabled') === 'boolean' ? raw('enabled') : d.enabled,
        maxRetries: Math.floor(finite(raw('maxRetries'), 0, LIMITS.maxRetries, d.maxRetries)),
        initialDelayMs,
        maxDelayMs: Math.max(initialDelayMs, finite(raw('maxDelayMs'), 0, LIMITS.maxDelayMs, d.maxDelayMs)),
        jitterRatio: finite(raw('jitterRatio'), 0, 1, d.jitterRatio),
        respectRetryAfter: typeof raw('respectRetryAfter') === 'boolean' ? raw('respectRetryAfter') : d.respectRetryAfter,
        statusCodes,
        codes: strings(raw('codes'), d.codes),
        messagePatterns: strings(raw('messagePatterns'), d.messagePatterns),
        excludeCodes: strings(raw('excludeCodes'), d.excludeCodes),
        providers: strings(raw('providers'), d.providers),
        keepPartial: typeof raw('keepPartial') === 'boolean' ? raw('keepPartial') : d.keepPartial,
    };
}
/**
 * Compile message patterns, skipping invalid ones.
 * @param patterns - regular expression sources.
 * @param onInvalid - called once per pattern that does not compile.
 * @returns compiled case-insensitive expressions.
 */
export function compilePatterns(patterns, onInvalid) {
    return patterns.flatMap(pattern => {
        try {
            return [new RegExp(pattern, 'i')];
        }
        catch (error) {
            onInvalid?.(pattern, error);
            return [];
        }
    });
}
/**
 * Decide whether one failure belongs to this plugin's retry rules.
 * Exclusions win; then status, code and message rules match in that order.
 */
export function classify(failure, settings, patterns) {
    if (settings.excludeCodes.includes(failure.code))
        return { kind: 'excluded', reason: `code ${failure.code}` };
    if (failure.status !== undefined && settings.statusCodes.includes(failure.status))
        return { kind: 'retry', reason: `HTTP ${failure.status}` };
    if (settings.codes.includes(failure.code))
        return { kind: 'retry', reason: `code ${failure.code}` };
    const message = typeof failure.message === 'string' ? failure.message.slice(0, LIMITS.messageLength) : '';
    for (const pattern of patterns) {
        if (pattern.test(message))
            return { kind: 'retry', reason: `message /${pattern.source}/` };
    }
    return { kind: 'unmatched' };
}
/**
 * Delay before the given retry: provider Retry-After when allowed, else
 * exponential backoff with symmetric jitter, both capped at maxDelayMs.
 * @param retry - 1-based retry number.
 */
export function retryDelay(failure, settings, retry, random = Math.random) {
    const providerDelay = failure.providerRetryAfterMs;
    if (settings.respectRetryAfter && typeof providerDelay === 'number' && Number.isFinite(providerDelay) && providerDelay > 0) {
        return Math.min(providerDelay, settings.maxDelayMs);
    }
    const exponential = Math.min(settings.initialDelayMs * 2 ** Math.min(retry - 1, 30), settings.maxDelayMs);
    const jitter = 1 - settings.jitterRatio + 2 * settings.jitterRatio * random();
    return Math.round(Math.min(exponential * jitter, settings.maxDelayMs));
}
