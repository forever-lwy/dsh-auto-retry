/**
 * Keep answer text that streamed before a request failed.
 *
 * DSH records an attempt that ends with an `error` finish only as
 * `assistant/attempt`: none of its blocks reach the session history, so a long
 * answer cut by a gateway timeout disappears. This stream wrapper rewrites
 * such an ending, once visible answer text exists, into a `max-tokens` finish
 * with a closing notice. The agent loop then commits the reply to the session
 * (dropping any unfinished tool calls, which never run), ends the turn, and
 * the next user message — "继续" — continues from the kept text.
 */
import { type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm';
/** The closing text appended to a salvaged reply; the model sees it on the next turn too. */
export declare function salvageNotice(failure: LlmFailure): string;
/**
 * Pass a provider stream through unchanged, except that an `error` finish after
 * visible answer text becomes a notice block plus a `max-tokens` finish.
 * Reasoning-only or blank attempts, cancellations (`aborted`) and every
 * successful finish are left as they are, so retries still apply to them.
 * @param stream - the chunk stream returned by the rest of the `llm/stream` chain.
 * @param onSalvage - called once with the original failure when an ending is rewritten.
 */
export declare function salvagePartial(stream: AsyncIterable<StreamChunk>, onSalvage?: (failure: LlmFailure) => void): AsyncGenerator<StreamChunk>;
