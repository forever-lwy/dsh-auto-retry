/**
 * Text-field drafts for the settings page and their conversion into
 * settings path operations. Kept free of React so tests can run it directly.
 */
import { DEFAULT_SETTINGS, LIMITS } from '../policy.js';
export const FIELDS = ['enabled', 'maxRetries', 'initialDelayMs', 'maxDelayMs', 'respectRetryAfter',
    'statusCodes', 'codes', 'messagePatterns', 'excludeCodes', 'providers', 'keepPartial'];
/** Seconds shown without float noise, e.g. 2000 → "2", 1500 → "1.5". */
function seconds(ms) {
    return String(Math.round(ms) / 1000);
}
function list(values) {
    return values.join(', ');
}
/** Resolve a section from the Host, falling back to defaults for absent fields. */
export function resolveSection(value) {
    const section = (value && typeof value === 'object' ? value : {});
    const pick = (key) => section[key] === undefined ? structuredClone(DEFAULT_SETTINGS[key]) : section[key];
    return {
        enabled: pick('enabled'), maxRetries: pick('maxRetries'), initialDelayMs: pick('initialDelayMs'), maxDelayMs: pick('maxDelayMs'),
        jitterRatio: pick('jitterRatio'), respectRetryAfter: pick('respectRetryAfter'), statusCodes: pick('statusCodes'), codes: pick('codes'),
        messagePatterns: pick('messagePatterns'), excludeCodes: pick('excludeCodes'), providers: pick('providers'),
        keepPartial: pick('keepPartial'),
    };
}
export function toDraft(settings) {
    return {
        enabled: settings.enabled,
        maxRetries: String(settings.maxRetries),
        initialDelay: seconds(settings.initialDelayMs),
        maxDelay: seconds(settings.maxDelayMs),
        respectRetryAfter: settings.respectRetryAfter,
        statusCodes: list(settings.statusCodes),
        codes: list(settings.codes),
        messagePatterns: settings.messagePatterns.join('\n'),
        excludeCodes: list(settings.excludeCodes),
        providers: list(settings.providers),
        keepPartial: settings.keepPartial,
    };
}
function splitList(text) {
    return text.split(/[\s,，;；]+/).map(item => item.trim()).filter(Boolean);
}
function uniq(values) {
    return [...new Set(values)];
}
function parseSeconds(text) {
    const trimmed = text.trim();
    if (!/^\d+(?:\.\d{1,3})?$/.test(trimmed))
        return undefined;
    const ms = Math.round(Number(trimmed) * 1000);
    return ms <= LIMITS.maxDelayMs ? ms : undefined;
}
/**
 * Validate a draft.
 * @returns the settings it describes, or the per-field errors.
 */
export function parseDraft(draft, base) {
    const errors = {};
    const maxRetries = /^\d+$/.test(draft.maxRetries.trim()) ? Number(draft.maxRetries.trim()) : NaN;
    if (!(maxRetries >= 0 && maxRetries <= LIMITS.maxRetries))
        errors.maxRetries = { key: 'invalidNumber' };
    const initialDelayMs = parseSeconds(draft.initialDelay);
    if (initialDelayMs === undefined)
        errors.initialDelay = { key: 'invalidNumber' };
    const maxDelayMs = parseSeconds(draft.maxDelay);
    if (maxDelayMs === undefined)
        errors.maxDelay = { key: 'invalidNumber' };
    else if (initialDelayMs !== undefined && maxDelayMs < initialDelayMs)
        errors.maxDelay = { key: 'delayOrder' };
    const statusTokens = splitList(draft.statusCodes);
    const badStatus = statusTokens.filter(token => !/^\d{3}$/.test(token) || Number(token) < 100 || Number(token) > 599);
    if (badStatus.length > 0)
        errors.statusCodes = { key: 'invalidStatus', detail: badStatus.join(', ') };
    const messagePatterns = draft.messagePatterns.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const pattern of messagePatterns) {
        try {
            new RegExp(pattern, 'i');
        }
        catch {
            errors.messagePatterns = { key: 'invalidPattern', detail: pattern };
            break;
        }
    }
    if (Object.keys(errors).length > 0)
        return { errors };
    return {
        settings: {
            ...base,
            enabled: draft.enabled,
            maxRetries,
            initialDelayMs: initialDelayMs,
            maxDelayMs: maxDelayMs,
            respectRetryAfter: draft.respectRetryAfter,
            statusCodes: uniq(statusTokens.map(Number)),
            codes: uniq(splitList(draft.codes).map(code => code.toUpperCase())),
            messagePatterns: uniq(messagePatterns),
            excludeCodes: uniq(splitList(draft.excludeCodes).map(code => code.toUpperCase())),
            providers: uniq(splitList(draft.providers)),
            keepPartial: draft.keepPartial,
        },
    };
}
/**
 * Field writes turning `current` into `next`. A field set back to its default
 * is unset, so it keeps following future default changes.
 */
export function diffOps(current, next) {
    return FIELDS.flatMap((field) => {
        if (JSON.stringify(current[field]) === JSON.stringify(next[field]))
            return [];
        return JSON.stringify(next[field]) === JSON.stringify(DEFAULT_SETTINGS[field])
            ? [{ op: 'unset', path: [field] }]
            : [{ op: 'set', path: [field], value: next[field] }];
    });
}
/** Unset every field the user layer overrides. */
export function resetOps(user) {
    if (!user || typeof user !== 'object')
        return [];
    return Object.keys(user).filter(key => FIELDS.includes(key) || key === 'jitterRatio')
        .map(key => ({ op: 'unset', path: [key] }));
}
