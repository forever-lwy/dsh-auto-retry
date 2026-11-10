/**
 * Retry failed model requests in place.
 *
 * The agent loop hands every failed request attempt to the
 * `agent/request-error` waterfall before it ends the turn. Answering
 * `{ kind: 'retry' }` reruns the same step on the same durable history: every
 * earlier step, tool call and tool result stays as it is, and no extra user
 * message is written. The failed attempt's partial output is never committed.
 *
 * Retries are recorded as the native `llm/retry` / `llm/retry-started` events
 * before and after each wait, so the chat shows them with its built-in retry
 * row and cancellation leaves a consistent log.
 *
 * Separately, an agent-loop request that fails after answer text has already
 * streamed is kept instead (see `salvage.ts`): the text is committed to the
 * session as a truncated reply and the user can ask the model to continue.
 * That request is not retried, because a retry would discard the text.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest, type GenerateOptions, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { DEFAULT_SETTINGS, LIMITS, classify, compilePatterns, readSettings, retryDelay, type RetrySettings } from './policy.js'
import { salvagePartial } from './salvage.js'

export * from './policy.js'
export * from './salvage.js'

export const name = 'dsh-auto-retry'
export const inject = ['agents', 'sessionProjections']

/** Marks this plugin's `llm/retry` events; the built-in executor keys its own chains apart. */
export const POLICY_KEY = 'dsh-auto-retry/v1'
const PROJECTION_KEY = 'dshAutoRetry'

const d = DEFAULT_SETTINGS
/** Every field is volatile: edits from the settings page apply to the next failure without a remount. */
export const Config = z.object({
  enabled: z.boolean().default(d.enabled).volatile().description('启用自动重试'),
  maxRetries: z.natural().max(LIMITS.maxRetries).default(d.maxRetries).volatile().description('每个步骤最多重试次数'),
  initialDelayMs: z.natural().max(LIMITS.maxDelayMs).default(d.initialDelayMs).volatile().description('首次重试等待（毫秒）'),
  maxDelayMs: z.natural().max(LIMITS.maxDelayMs).default(d.maxDelayMs).volatile().description('单次等待上限（毫秒）'),
  jitterRatio: z.number().min(0).max(1).default(d.jitterRatio).volatile().description('等待时间随机浮动比例'),
  respectRetryAfter: z.boolean().default(d.respectRetryAfter).volatile().description('遵循上游 Retry-After'),
  statusCodes: z.array(z.natural().min(100).max(599)).default([...d.statusCodes]).volatile().description('重试的 HTTP 状态码'),
  codes: z.array(z.string()).default([...d.codes]).volatile().description('重试的错误代码'),
  messagePatterns: z.array(z.string()).default([...d.messagePatterns]).volatile().description('匹配错误信息的正则表达式（不区分大小写）'),
  excludeCodes: z.array(z.string()).default([...d.excludeCodes]).volatile().description('始终不重试的错误代码'),
  providers: z.array(z.string()).default([...d.providers]).volatile().description('仅对这些提供方生效；留空表示全部'),
  keepPartial: z.boolean().default(d.keepPartial).volatile().description('出错时保留已生成内容'),
})

interface RetryChain {
  /** Retries already scheduled in the current step. */
  retry: number
  retryId: string
}

const chainSchema = zod.object({ retry: zod.number().int().nonnegative(), retryId: zod.string() })
const EMPTY_CHAIN: RetryChain = Object.freeze({ retry: 0, retryId: '' })

interface RequestErrorPayload {
  agent: Agent
  turn: number
  step: number
  provider: string
  failure: LlmFailure
  signal: AbortSignal
}
type RequestErrorAction = { kind: 'retry' } | undefined

export interface Internals {
  random?: () => number
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true) }, delayMs)
    function onAbort() { clearTimeout(timer); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function apply(ctx: Context, config: Record<string, unknown> = {}, internals: Internals = {}): void {
  const random = internals.random ?? Math.random

  // The chain lives in the session log: it resets when the next step or turn
  // starts, and survives a reload of this plugin mid-step.
  // Host-only unit: 0.2.2 registration is asynchronous and the awaited handle
  // is the supported reader (the registry-level stateOf is deprecated).
  const chainHandle: Promise<ProjectionHandle<RetryChain>> = ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: chainSchema,
    init: () => EMPTY_CHAIN,
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return state.retry === 0 ? state : EMPTY_CHAIN
      if (event.type !== 'llm/retry' || event.data.policyKey !== POLICY_KEY) return state
      return { retry: event.data.retry, retryId: event.data.retryId }
    },
  })
  chainHandle.catch(error => {
    ctx.logger.warn('auto-retry: projection registration failed: %s', error instanceof Error ? error.message : String(error))
  })

  let compiled: { key: string; patterns: RegExp[] } | undefined
  const patternsOf = (settings: RetrySettings) => {
    const key = JSON.stringify(settings.messagePatterns)
    if (compiled?.key !== key) {
      compiled = { key, patterns: compilePatterns(settings.messagePatterns, (pattern, error) => {
        ctx.logger.warn('auto-retry: ignoring invalid message pattern %s: %s', JSON.stringify(pattern), error instanceof Error ? error.message : String(error))
      }) }
    }
    return compiled.patterns
  }

  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function recover(payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const { agent, turn, step, provider, failure, signal } = payload
    const settings = readSettings(config)
    if (!settings.enabled) return next()
    if (settings.providers.length > 0 && !settings.providers.includes(provider)) return next()
    const verdict = classify(failure, settings, patternsOf(settings))
    if (verdict.kind !== 'retry') return next()

    // A matched failure belongs to this plugin: once its budget is spent the
    // step fails, rather than letting another policy add retries on top.
    const chain = (await chainHandle).stateOf(agent.session) ?? EMPTY_CHAIN
    if (chain.retry >= settings.maxRetries) {
      ctx.logger.info('auto-retry: %s failed (%s) after %d retries; giving up', provider, verdict.reason, chain.retry)
      return undefined
    }
    const retry = chain.retry + 1
    const retryId = chain.retryId || randomUUID()
    const delayMs = retryDelay(failure, settings, retry, random)
    const fused = AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined

    // Durable before waiting: a crash or cancellation never hides a pending retry.
    agent.session.append('llm/retry', {
      retryId: retryId as never,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: POLICY_KEY,
      retry,
      maxRetries: settings.maxRetries,
      delayMs,
      failure,
    })
    ctx.logger.info('auto-retry: %s failed (%s); retry %d/%d in %dms', provider, verdict.reason, retry, settings.maxRetries, delayMs)
    if (!await cancellableDelay(delayMs, fused)) return undefined
    agent.session.append('llm/retry-started', { retryId: retryId as never, turn, step, retry })
    return { kind: 'retry' }
  }

  // Prepended so matched failures are handled before the built-in executor;
  // everything else passes through to the rest of the recovery chain.
  const dispose = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return next()
    return track(recover(payload as RequestErrorPayload, next as () => Promise<RequestErrorAction>))
  }, true)

  // Wraps every provider's stream. Only agent-loop requests are touched:
  // titles, summaries and other internal calls keep their plain errors.
  const disposeSalvage = ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (lifetime.signal.aborted || !isAgentLoopRequest(options)) return next()
    const settings = readSettings(config)
    if (!settings.keepPartial) return next()
    if (settings.providers.length > 0 && !settings.providers.includes(options.provider)) return next()
    return salvagePartial(next(), failure => {
      ctx.logger.info('auto-retry: %s failed after answer text (%s); keeping the partial reply', options.provider, failure.code)
    })
  }, true)

  ctx.effect(() => async () => {
    disposeSalvage()
    dispose()
    lifetime.abort(new Error('dsh-auto-retry disposed'))
    await Promise.allSettled([...active])
  }, 'auto-retry: abort and drain pending retries')
}
