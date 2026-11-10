/**
 * Text-field drafts for the settings page and their conversion into
 * settings path operations. Kept free of React so tests can run it directly.
 */
import { type RetrySettings } from '../policy.js';
export declare const FIELDS: readonly ["enabled", "maxRetries", "initialDelayMs", "maxDelayMs", "respectRetryAfter", "statusCodes", "codes", "messagePatterns", "excludeCodes", "providers", "keepPartial"];
export type Field = typeof FIELDS[number];
export interface Draft {
    enabled: boolean;
    maxRetries: string;
    initialDelay: string;
    maxDelay: string;
    respectRetryAfter: boolean;
    statusCodes: string;
    codes: string;
    messagePatterns: string;
    excludeCodes: string;
    providers: string;
    keepPartial: boolean;
}
export type PathOp = {
    op: 'set';
    path: string[];
    value: unknown;
} | {
    op: 'unset';
    path: string[];
};
/** Resolve a section from the Host, falling back to defaults for absent fields. */
export declare function resolveSection(value: unknown): RetrySettings;
export declare function toDraft(settings: RetrySettings): Draft;
export type DraftErrors = Partial<Record<keyof Draft, {
    key: string;
    detail?: string;
}>>;
/**
 * Validate a draft.
 * @returns the settings it describes, or the per-field errors.
 */
export declare function parseDraft(draft: Draft, base: RetrySettings): {
    settings: RetrySettings;
    errors?: undefined;
} | {
    settings?: undefined;
    errors: DraftErrors;
};
/**
 * Field writes turning `current` into `next`. A field set back to its default
 * is unset, so it keeps following future default changes.
 */
export declare function diffOps(current: RetrySettings, next: RetrySettings): PathOp[];
/** Unset every field the user layer overrides. */
export declare function resetOps(user: unknown): PathOp[];
