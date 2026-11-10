import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export * from './policy.js';
export * from './salvage.js';
export declare const name = "dsh-auto-retry";
export declare const inject: string[];
/** Marks this plugin's `llm/retry` events; the built-in executor keys its own chains apart. */
export declare const POLICY_KEY = "dsh-auto-retry/v1";
/** Every field is volatile: edits from the settings page apply to the next failure without a remount. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    maxRetries: z<number, number, "volatile-defined">;
    initialDelayMs: z<number, number, "volatile-defined">;
    maxDelayMs: z<number, number, "volatile-defined">;
    jitterRatio: z<number, number, "volatile-defined">;
    respectRetryAfter: z<boolean, boolean, "volatile-defined">;
    statusCodes: z<NoInfer<number[]>, NoInfer<number[]>, "volatile-defined">;
    codes: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    messagePatterns: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    excludeCodes: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    providers: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    keepPartial: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    maxRetries: z<number, number, "volatile-defined">;
    initialDelayMs: z<number, number, "volatile-defined">;
    maxDelayMs: z<number, number, "volatile-defined">;
    jitterRatio: z<number, number, "volatile-defined">;
    respectRetryAfter: z<boolean, boolean, "volatile-defined">;
    statusCodes: z<NoInfer<number[]>, NoInfer<number[]>, "volatile-defined">;
    codes: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    messagePatterns: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    excludeCodes: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    providers: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    keepPartial: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
export interface Internals {
    random?: () => number;
}
export declare function apply(ctx: Context, config?: Record<string, unknown>, internals?: Internals): void;
