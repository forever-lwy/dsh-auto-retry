import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, classify, compilePatterns, readSettings, retryDelay } from '../lib/index.js'
import { diffOps, parseDraft, resetOps, resolveSection, toDraft } from '../lib/client/draft.js'

const defaults = readSettings({})
const patterns = compilePatterns(defaults.messagePatterns)
const verdict = failure => classify({ message: '', code: 'UNKNOWN', ...failure }, defaults, patterns)

test('default rules cover 524, 429, timeouts and dropped connections across adapters', () => {
  // dsh-google-native
  assert.equal(verdict({ code: 'SERVER_ERROR', status: 524 }).kind, 'retry')
  assert.equal(verdict({ code: 'RATE_LIMIT', status: 429 }).kind, 'retry')
  assert.equal(verdict({ code: 'NETWORK', message: 'Google API 请求失败' }).kind, 'retry')
  // pi-ai only puts the status in its message
  assert.equal(verdict({ code: 'PI_AI_ERROR', message: 'Error: 524 A timeout occurred' }).kind, 'retry')
  assert.equal(verdict({ code: 'PI_AI_ERROR', message: 'read ECONNRESET' }).kind, 'retry')
  assert.equal(verdict({ code: 'UNKNOWN', message: 'TypeError: fetch failed: other side closed' }).kind, 'retry')
  assert.equal(verdict({ code: 'TRANSPORT' }).kind, 'retry')
  assert.equal(verdict({ code: 'TIMEOUT', status: 504 }).reason, 'HTTP 504')
})

test('exclusions win and unrelated failures are not retried', () => {
  assert.deepEqual(verdict({ code: 'QUOTA', status: 429, message: '429 insufficient balance' }), { kind: 'excluded', reason: 'code QUOTA' })
  assert.equal(verdict({ code: 'AUTH', status: 401 }).kind, 'excluded')
  assert.equal(verdict({ code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 }).kind, 'excluded')
  assert.equal(verdict({ code: 'INVALID_REQUEST', status: 400, message: 'bad schema' }).kind, 'excluded')
  assert.equal(verdict({ code: 'SOMETHING', status: 418, message: 'teapot' }).kind, 'unmatched')
  // "1524 tokens" must not look like an HTTP 524.
  assert.equal(verdict({ code: 'SOMETHING', message: 'used 1524 tokens' }).kind, 'unmatched')
})

test('custom rules, invalid patterns and live references', () => {
  const invalid = []
  const custom = readSettings({
    statusCodes: { get: () => [418] }, codes: { get: () => ['MY_CODE'] }, messagePatterns: { get: () => ['quota (soft|later)', '('] },
    excludeCodes: { get: () => [] }, maxRetries: { get: () => 999 }, initialDelayMs: { get: () => 5000 }, maxDelayMs: { get: () => 10 },
  })
  assert.equal(custom.maxRetries, 100, 'bounded')
  assert.equal(custom.maxDelayMs, 5000, 'never below the first wait')
  const compiled = compilePatterns(custom.messagePatterns, pattern => invalid.push(pattern))
  assert.deepEqual(invalid, ['('])
  assert.equal(classify({ code: 'X', status: 418, message: '' }, custom, compiled).kind, 'retry')
  assert.equal(classify({ code: 'MY_CODE', message: '' }, custom, compiled).kind, 'retry')
  assert.equal(classify({ code: 'QUOTA', message: 'Quota Soft limit' }, custom, compiled).kind, 'retry')
  assert.equal(classify({ code: 'X', status: 524, message: '' }, custom, compiled).kind, 'unmatched')
})

test('backoff doubles with jitter, honors Retry-After, and is capped', () => {
  const s = { ...defaults, initialDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0.2 }
  const mid = () => 0.5
  assert.deepEqual([1, 2, 3, 4, 5].map(retry => retryDelay({}, s, retry, mid)), [1000, 2000, 4000, 8000, 8000])
  assert.equal(retryDelay({}, s, 1, () => 0), 800)
  assert.equal(retryDelay({}, s, 1, () => 1), 1200)
  assert.equal(retryDelay({ providerRetryAfterMs: 3000 }, s, 1, mid), 3000)
  assert.equal(retryDelay({ providerRetryAfterMs: 90000 }, s, 1, mid), 8000)
  assert.equal(retryDelay({ providerRetryAfterMs: 3000 }, { ...s, respectRetryAfter: false }, 1, mid), 1000)
})

test('settings page drafts round-trip, validate, and write minimal operations', () => {
  const current = resolveSection({ maxRetries: 3 })
  assert.equal(current.initialDelayMs, DEFAULT_SETTINGS.initialDelayMs)
  const draft = toDraft(current)
  assert.equal(draft.initialDelay, '2')
  assert.deepEqual(parseDraft(draft, current).settings, current)
  assert.deepEqual(diffOps(current, parseDraft(draft, current).settings), [])

  const edited = { ...draft, maxRetries: '5', initialDelay: '1.5', statusCodes: '429，524 524', codes: 'timeout, my_code', providers: 'google-ai-studio' }
  const { settings } = parseDraft(edited, current)
  assert.deepEqual(settings.statusCodes, [429, 524])
  assert.deepEqual(settings.codes, ['TIMEOUT', 'MY_CODE'])
  assert.deepEqual(diffOps(current, settings), [
    { op: 'unset', path: ['maxRetries'] }, // back to the default 5
    { op: 'set', path: ['initialDelayMs'], value: 1500 },
    { op: 'set', path: ['statusCodes'], value: [429, 524] },
    { op: 'set', path: ['codes'], value: ['TIMEOUT', 'MY_CODE'] },
    { op: 'set', path: ['providers'], value: ['google-ai-studio'] },
  ])

  const bad = parseDraft({ ...draft, maxRetries: '-1', initialDelay: '10', maxDelay: '5', statusCodes: '524, 99, abc', messagePatterns: 'ok\n(' }, current)
  assert.deepEqual(Object.keys(bad.errors).sort(), ['maxDelay', 'maxRetries', 'messagePatterns', 'statusCodes'])
  assert.equal(bad.errors.maxDelay.key, 'delayOrder')
  assert.equal(bad.errors.statusCodes.detail, '99, abc')

  assert.deepEqual(resetOps({ maxRetries: 3, jitterRatio: 0.5, foreign: 1 }), [{ op: 'unset', path: ['maxRetries'] }, { op: 'unset', path: ['jitterRatio'] }])
})
