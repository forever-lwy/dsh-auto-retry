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
import { chunkHasVisibleText, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Block types DSH can still assemble while open; any other open block keeps the original error. */
const ASSEMBLABLE = new Set(['text', 'reasoning', 'tool-call'])

/** The closing text appended to a salvaged reply; the model sees it on the next turn too. */
export function salvageNotice(failure: LlmFailure): string {
  const reason = failure.message.trim().replace(/[。.]$/, '') || failure.code
  return `\n\n---\n⚠️ 输出未完成：${reason}。以上是连接断开前已生成的内容；回复“继续”可从断开处接着写。`
}

/**
 * Pass a provider stream through unchanged, except that an `error` finish after
 * visible answer text becomes a notice block plus a `max-tokens` finish.
 * Reasoning-only or blank attempts, cancellations (`aborted`) and every
 * successful finish are left as they are, so retries still apply to them.
 * @param stream - the chunk stream returned by the rest of the `llm/stream` chain.
 * @param onSalvage - called once with the original failure when an ending is rewritten.
 */
export async function* salvagePartial(
  stream: AsyncIterable<StreamChunk>, onSalvage?: (failure: LlmFailure) => void,
): AsyncGenerator<StreamChunk> {
  const open = new Map<number, string>()
  /** Text accumulated per open text or reasoning block, to close it before the notice. */
  const texts = new Map<number, string>()
  let nextIndex = 0
  let visible = false
  for await (const chunk of stream) {
    if ('index' in chunk && typeof chunk.index === 'number') nextIndex = Math.max(nextIndex, chunk.index + 1)
    if (chunk.type === 'block-start') {
      open.set(chunk.index, chunk.blockType)
      if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') texts.set(chunk.index, '')
    } else if (chunk.type === 'block-end') {
      open.delete(chunk.index)
      texts.delete(chunk.index)
    } else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && texts.has(chunk.index)) {
      texts.set(chunk.index, texts.get(chunk.index)! + chunk.text)
    }
    if (!visible && chunkHasVisibleText(chunk)) visible = true
    if (chunk.type === 'finish' && chunk.reason.kind === 'error' && visible
      && [...open.values()].every(type => ASSEMBLABLE.has(type))) {
      const failure = chunk.reason.failure
      const text = salvageNotice(failure)
      onSalvage?.(failure)
      // Close what was streaming; an unfinished tool call stays open and is dropped by DSH.
      for (const [index, partial] of texts) {
        const type = open.get(index) as 'text' | 'reasoning'
        yield { type: 'block-end', index, block: { type, text: partial } }
      }
      yield { type: 'block-start', index: nextIndex, blockType: 'text' }
      yield { type: 'text-delta', index: nextIndex, text }
      yield { type: 'block-end', index: nextIndex, block: { type: 'text', text } }
      // No replay state: the provider's native envelope for a cut response is
      // unavailable, so the next request replays these blocks as plain content.
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    yield chunk
  }
}
