// End-to-end against the real rc.5 agent loop: a scripted upstream fails with
// 524 / dropped connections after a completed tool step, and the plugin must
// rerun only the failed step on the same history, with no extra user message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { LlmRuntime, LlmAdapter, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as BuiltinRetry from '@deepseek-ai/dsh-llm-retry'
import * as Plugin from '../lib/index.js'

const PROVIDER = 'scripted'

/** Each request consumes the next script entry: 'tool', 'text', or a failure. */
class ScriptedAdapter extends LlmAdapter {
  constructor(script, retryPolicy) {
    super()
    this.script = [...script]
    this.requests = []
    this.retryPolicy = retryPolicy
  }
  providerInfo(provider) { return { id: provider, name: 'Scripted' } }
  providerRetryPolicy() { return this.retryPolicy }
  async listModels(provider) { return [{ provider, id: 'model', name: 'Model' }] }
  async *stream(request) {
    this.requests.push(structuredClone(request.messages))
    const next = this.script.shift() ?? { text: 'done' }
    let index = 0
    if (next.reasoning) {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: next.reasoning }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: next.reasoning } }
      index++
    }
    if (next.partial) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: next.partial }
      index++
    }
    if (next.partialTool) {
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: 'call-cut', name: 'work', argumentsDelta: '{"job":"HALF' }
      index++
    }
    if (next.fail) throw new LlmError(next.fail.message, next.fail.code, next.fail.status === undefined ? undefined : { status: next.fail.status })
    if (next.tool) {
      const block = { type: 'tool-call', id: `call-${this.requests.length}`, name: 'work', arguments: JSON.stringify({ job: next.tool }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: 'work', argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: next.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const http524 = { fail: { message: 'Google API 请求失败（HTTP 524）', code: 'SERVER_ERROR', status: 524 } }
const dropped = { fail: { message: 'fetch failed: other side closed', code: 'UNKNOWN' } }
const auth = { fail: { message: 'HTTP 401 unauthorized', code: 'AUTH', status: 401 } }

async function harness({ script, config = {}, builtin = false, retryPolicy } = {}) {
  const ctx = new Context()
  for (const service of [SessionStore, AgentRegistry, SessionProjectionRegistry, LlmRuntime]) await ctx.plugin(service)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentLoop, {})
  const adapter = new ScriptedAdapter(script, retryPolicy)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const executions = []
  ctx.tools.register(defineTool({
    name: 'work',
    description: 'Do one unit of work.',
    parameters: { job: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ job }) { executions.push(job); return `finished ${job}` },
  }))
  if (builtin) await ctx.plugin(BuiltinRetry)
  await ctx.plugin(Plugin, { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0, ...config })
  const { agent } = await ctx.agents.create({ sessionId: SessionId(`s-${Math.random()}`), agentOptions: { provider: PROVIDER, model: 'model' } })
  return { ctx, agent, adapter, executions }
}

async function runTurn(agent, text = 'please do the task') {
  const errors = []
  agent.ctx?.on?.('agent/error', ({ error }) => errors.push(error))
  agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()
  return errors
}

const eventsOf = (agent, type) => agent.session.snapshotEvents().filter(event => event.type === type)
const userTexts = agent => eventsOf(agent, 'user/message').map(event => event.data.content.map(block => block.text).join(''))
const turnEnd = agent => eventsOf(agent, 'turn/end').at(-1)?.data.reason

test('with keepPartial off, 524 after a completed tool step reruns only the failed step on the same history', async () => {
  const { ctx, agent, adapter, executions } = await harness({
    config: { keepPartial: false },
    script: [{ tool: 'A' }, { ...http524, partial: 'half an ans' }, dropped, { text: 'all done' }],
  })
  try {
    await runTurn(agent)
    assert.deepEqual(executions, ['A'], 'the completed tool call is not repeated')
    assert.equal(adapter.requests.length, 4)
    // The retried requests are byte-identical to the failed one: same history, tool result included, no "continue" prompt.
    assert.deepEqual(adapter.requests[2], adapter.requests[1])
    assert.deepEqual(adapter.requests[3], adapter.requests[1])
    assert.ok(JSON.stringify(adapter.requests[3]).includes('finished A'))
    assert.deepEqual(userTexts(agent), ['please do the task'])
    const retries = eventsOf(agent, 'llm/retry')
    assert.deepEqual(retries.map(event => [event.data.retry, event.data.step, event.data.policyKey, event.data.failure.status]),
      [[1, 2, Plugin.POLICY_KEY, 524], [2, 2, Plugin.POLICY_KEY, undefined]])
    assert.equal(retries[0].data.retryId, retries[1].data.retryId, 'one chain per step, as the chat retry row expects')
    assert.equal(eventsOf(agent, 'llm/retry-started').length, 2)
    const finals = eventsOf(agent, 'assistant/message').map(event => event.data.message.content.map(block => block.text ?? '').join(''))
    assert.ok(!finals.some(text => text.includes('half an ans')), 'partial output of a failed attempt is never committed')
    assert.equal(finals.at(-1), 'all done')
    assert.equal(turnEnd(agent).kind, 'completed')
  } finally { await ctx.fiber.dispose() }
})

test('budget is per step and exhaustion ends the turn with the original error', async () => {
  const { ctx, agent, adapter } = await harness({
    config: { maxRetries: 2 },
    script: [http524, { tool: 'A' }, http524, http524, http524, { text: 'never' }],
  })
  try {
    await runTurn(agent)
    // Step 1: one retry, then success. Step 2: two retries, then the third failure is terminal.
    assert.equal(adapter.requests.length, 5)
    assert.deepEqual(eventsOf(agent, 'llm/retry').map(event => [event.data.step, event.data.retry]), [[1, 1], [2, 1], [2, 2]])
    assert.notEqual(turnEnd(agent).kind, 'completed')
  } finally { await ctx.fiber.dispose() }
})

test('excluded and unmatched failures are left to the rest of the chain', async () => {
  for (const [failure, config] of [[auth, {}], [http524, { enabled: false }], [http524, { providers: ['other'] }], [http524, { statusCodes: [], codes: [], messagePatterns: [] }]]) {
    const { ctx, agent, adapter } = await harness({ script: [failure, { text: 'unused' }], config })
    try {
      await runTurn(agent)
      assert.equal(adapter.requests.length, 1, JSON.stringify(config))
      assert.equal(eventsOf(agent, 'llm/retry').length, 0)
    } finally { await ctx.fiber.dispose() }
  }
})

test('runs before the built-in executor and keeps it for failures it does not own', async () => {
  // The built-in policy would retry SERVER_ERROR once more; this plugin owns it, so only its budget applies.
  const policy = { mode: 'normal', maxRetries: 3, retryableCodes: ['SERVER_ERROR', 'AUTH'], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
  const { ctx, agent, adapter } = await harness({ builtin: true, retryPolicy: policy, config: { maxRetries: 1 }, script: [http524, http524, { text: 'never' }] })
  try {
    await runTurn(agent)
    assert.equal(adapter.requests.length, 2)
    assert.deepEqual(eventsOf(agent, 'llm/retry').map(event => event.data.policyKey), [Plugin.POLICY_KEY])
  } finally { await ctx.fiber.dispose() }

  // AUTH is excluded here, so it falls through and the built-in policy retries it under its own key.
  const handoff = await harness({ builtin: true, retryPolicy: policy, script: [auth, { text: 'recovered' }] })
  try {
    await runTurn(handoff.agent)
    assert.equal(handoff.adapter.requests.length, 2)
    const keys = eventsOf(handoff.agent, 'llm/retry').map(event => event.data.policyKey)
    assert.equal(keys.length, 1)
    assert.notEqual(keys[0], Plugin.POLICY_KEY)
    assert.equal(turnEnd(handoff.agent).kind, 'completed')
  } finally { await handoff.ctx.fiber.dispose() }
})

test('cancelling during the wait stops the retry', async () => {
  const { ctx, agent, adapter } = await harness({ config: { initialDelayMs: 60000, maxDelayMs: 60000 }, script: [http524, { text: 'never' }] })
  try {
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), 'next-turn', true)
    while (eventsOf(agent, 'llm/retry').length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    agent.cancel()
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 1)
    assert.equal(eventsOf(agent, 'llm/retry-started').length, 0)
  } finally { await ctx.fiber.dispose() }
})

const assistantTexts = agent => eventsOf(agent, 'assistant/message').map(event => event.data.message.content.map(block => block.text ?? '').join(''))
/** Text of every message one request sent, by role. */
const sent = request => request.map(message => [message.role, message.content.map(block => block.text ?? (block.type === 'tool-result' ? '[result]' : `[${block.type}]`)).join('')])

test('answer text cut by a gateway is kept in the session and "继续" continues from it', async () => {
  const { ctx, agent, adapter } = await harness({
    script: [{ ...http524, reasoning: 'planning', partial: 'Chapter one, half' }, { text: 'Chapter one, second half' }],
  })
  try {
    await runTurn(agent, 'write the report')
    assert.equal(adapter.requests.length, 1, 'a cut answer is not retried')
    assert.equal(eventsOf(agent, 'llm/retry').length, 0)
    assert.equal(turnEnd(agent).kind, 'max-tokens')
    const kept = eventsOf(agent, 'assistant/message').at(-1).data.message
    assert.deepEqual(kept.content.map(block => block.type), ['reasoning', 'text', 'text'])
    assert.equal(kept.content[1].text, 'Chapter one, half')
    assert.match(kept.content[2].text, /⚠️ 输出未完成：Google API 请求失败（HTTP 524）。以上是连接断开前已生成的内容；回复“继续”可从断开处接着写。/)

    await runTurn(agent, '继续')
    const history = sent(adapter.requests[1]).filter(([role]) => role !== 'system')
    const assistant = history.findIndex(([role, text]) => role === 'assistant' && text.includes('Chapter one, half'))
    assert.ok(assistant >= 0, 'the kept text is part of the next request')
    assert.match(history[assistant][1], /输出未完成/)
    assert.ok(history.slice(assistant + 1).some(([role, text]) => role === 'user' && text.includes('继续')))
    assert.equal(assistantTexts(agent).at(-1), 'Chapter one, second half')
    assert.equal(turnEnd(agent).kind, 'completed')
  } finally { await ctx.fiber.dispose() }
})

test('a cut after completed tool steps keeps the steps, the text, and never runs the unfinished tool call', async () => {
  const { ctx, agent, adapter, executions } = await harness({ script: [{ tool: 'A' }, { ...dropped, partial: 'A is done; next I will', partialTool: true }] })
  try {
    await runTurn(agent)
    assert.deepEqual(executions, ['A'])
    assert.equal(adapter.requests.length, 2)
    assert.equal(turnEnd(agent).kind, 'max-tokens')
    const kept = eventsOf(agent, 'assistant/message').at(-1).data.message
    assert.deepEqual(kept.content.map(block => block.type), ['text', 'text'])
    assert.equal(kept.content[0].text, 'A is done; next I will')
    assert.match(kept.content[1].text, /输出未完成：fetch failed: other side closed/)
    assert.equal(eventsOf(agent, 'tool/call').length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('reasoning-only or blank attempts still retry, and keepPartial does not depend on the retry switch', async () => {
  const thinking = await harness({ script: [{ ...http524, reasoning: 'thinking only' }, { ...http524, partial: '   ' }, { text: 'recovered' }] })
  try {
    await runTurn(thinking.agent)
    assert.equal(thinking.adapter.requests.length, 3)
    assert.equal(eventsOf(thinking.agent, 'llm/retry').length, 2)
    assert.equal(turnEnd(thinking.agent).kind, 'completed')
  } finally { await thinking.ctx.fiber.dispose() }

  const retryOff = await harness({ config: { enabled: false }, script: [{ ...auth, partial: 'kept anyway' }] })
  try {
    await runTurn(retryOff.agent)
    assert.equal(turnEnd(retryOff.agent).kind, 'max-tokens')
    assert.equal(eventsOf(retryOff.agent, 'assistant/message').at(-1).data.message.content[0].text, 'kept anyway')
  } finally { await retryOff.ctx.fiber.dispose() }
})

test('keepPartial off or another provider leaves the failure untouched', async () => {
  for (const config of [{ keepPartial: false, enabled: false }, { providers: ['other'] }]) {
    const { ctx, agent } = await harness({ config, script: [{ ...auth, partial: 'lost' }] })
    try {
      await runTurn(agent)
      assert.equal(turnEnd(agent).kind, 'error', JSON.stringify(config))
      assert.ok(!assistantTexts(agent).some(text => text.includes('lost')))
    } finally { await ctx.fiber.dispose() }
  }
})

test('requests outside the agent loop keep their plain error finish', async () => {
  const { ctx } = await harness({ script: [{ ...http524, partial: 'title draft' }] })
  try {
    const chunks = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'model', messages: [createUserMessage({ content: [{ type: 'text', text: 'name this' }], source: { kind: 'user' } })] })) chunks.push(chunk)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.ok(!chunks.some(chunk => chunk.type === 'text-delta' && /输出未完成/.test(chunk.text)))
  } finally { await ctx.fiber.dispose() }
})
