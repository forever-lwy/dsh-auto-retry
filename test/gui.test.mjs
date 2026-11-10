import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')
const { AutoRetrySettings } = await import('../lib/client/Settings.js')
const { zh } = await import('../lib/client/locales.js')

/** A ConfigForm double: accepts writes, folds them into the snapshot like the Host mirror. */
function fakeForm(initial) {
  let snapshot = { status: 'ready', value: {}, base: {}, user: {}, revision: 3, writable: true, ...initial }
  const listeners = new Set()
  const writes = []
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, revision) {
      writes.push({ ops, revision })
      const user = { ...snapshot.user }
      const value = { ...snapshot.value }
      for (const op of ops) {
        if (op.op === 'set') { user[op.path[0]] = op.value; value[op.path[0]] = op.value } else { delete user[op.path[0]]; delete value[op.path[0]] }
      }
      snapshot = { ...snapshot, user, value, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return true
    },
  }
}

async function render(form) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(React.createElement(AutoRetrySettings, { form, view: 'page' })))
  return { container, root }
}

function byLabel(container, text) {
  const label = [...container.querySelectorAll('label')].find(node => node.textContent.startsWith(text))
  assert.ok(label, `label ${text}`)
  return label.htmlFor ? container.querySelector(`#${CSS.escape(label.htmlFor)}`) : label.querySelector('input')
}
const CSS = { escape: value => value.replace(/:/g, '\\:') }

async function type(element, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set
  await act(async () => { setter.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })) })
}
const button = (container, text) => [...container.querySelectorAll('button')].find(node => node.textContent === text)
const click = async element => act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

test('shows live values, saves only changed fields with the read revision', async () => {
  const form = fakeForm({ value: { maxRetries: 3 }, user: { maxRetries: 3 } })
  const { container, root } = await render(form)
  try {
    assert.equal(byLabel(container, zh.maxRetries).value, '3')
    assert.equal(byLabel(container, zh.initialDelay).value, '2')
    assert.match(byLabel(container, zh.statusCodes).value, /\b524\b/)
    assert.ok(container.textContent.includes(zh.overridden))
    assert.equal(button(container, zh.save).disabled, true, 'nothing to save yet')

    await type(byLabel(container, zh.maxRetries), '8')
    await type(byLabel(container, zh.statusCodes), '429, 524')
    await type(byLabel(container, zh.patterns), 'my upstream glitch')
    await click(button(container, zh.save))
    assert.deepEqual(form.writes, [{ revision: 3, ops: [
      { op: 'set', path: ['maxRetries'], value: 8 },
      { op: 'set', path: ['statusCodes'], value: [429, 524] },
      { op: 'set', path: ['messagePatterns'], value: ['my upstream glitch'] },
    ] }])
    assert.ok(container.textContent.includes(zh.saved))
    assert.equal(byLabel(container, zh.maxRetries).value, '8')
  } finally { await act(async () => root.unmount()) }
})

test('blocks invalid input and resets every override', async () => {
  const form = fakeForm({ value: { maxRetries: 3, providers: ['x'] }, user: { maxRetries: 3, providers: ['x'] } })
  const { container, root } = await render(form)
  try {
    await type(byLabel(container, zh.patterns), '(unclosed')
    await type(byLabel(container, zh.maxDelay), '0.5')
    await click(button(container, zh.save))
    assert.equal(form.writes.length, 0)
    assert.ok(container.textContent.includes(zh.invalidPattern + '(unclosed'))
    assert.ok(container.textContent.includes(zh.delayOrder))

    await click(button(container, zh.discard))
    window.confirm = () => true
    await click(button(container, zh.resetAll))
    assert.deepEqual(form.writes.at(-1).ops, [{ op: 'unset', path: ['maxRetries'] }, { op: 'unset', path: ['providers'] }])
    assert.equal(byLabel(container, zh.maxRetries).value, '5')
  } finally { await act(async () => root.unmount()) }
})

test('unavailable and read-only states', async () => {
  const off = await render(fakeForm({ status: 'unavailable' }))
  assert.ok(off.container.textContent.includes(zh.unavailable))
  await act(async () => off.root.unmount())
  const readOnly = await render(fakeForm({ writable: false }))
  assert.ok(readOnly.container.textContent.includes(zh.readOnly))
  assert.equal(byLabel(readOnly.container, zh.maxRetries).disabled, true)
  await act(async () => readOnly.root.unmount())
})

test('client registers its page on this bundle while the auto-retry row is served', async () => {
  const Client = await import('../lib/client/index.js')
  const effects = []
  const registrations = []
  let served
  const form = fakeForm({})
  const ctx = {
    effect: (fn) => { effects.push(fn()) },
    locale: { register: () => () => {}, bind: () => key => key },
    configForms: {
      get: entry => { assert.equal(entry, 'auto-retry'); return form },
      whileServed: (namespaces, register) => { served = { namespaces, register }; return () => {} },
    },
    slots: {
      inject: (name, fn) => { assert.equal(name, 'plugins.bundle.config'); return fn() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  Client.apply(ctx)
  assert.deepEqual(served.namespaces, ['auto-retry'])
  assert.equal(registrations.length, 0, 'nothing until the Host serves the row')
  served.register(new Set(['auto-retry']))
  assert.equal(registrations[0].options.key, '@forever-lwy/dsh-auto-retry')
  assert.equal(registrations[0].options.inject().form, form)
  assert.equal(registrations[0].component, Client.AutoRetrySettings)
  assert.ok(document.querySelector('style[data-plugin="@forever-lwy/dsh-auto-retry"]'))
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
})

test('the keep-partial switch defaults on and saves an explicit off', async () => {
  const form = fakeForm()
  const { container, root } = await render(form)
  try {
    const box = byLabel(container, zh.keepPartial)
    assert.equal(box.checked, true)
    await click(box)
    await click(button(container, zh.save))
    assert.deepEqual(form.writes, [{ revision: 3, ops: [{ op: 'set', path: ['keepPartial'], value: false }] }])
    await click(byLabel(container, zh.keepPartial))
    await click(button(container, zh.save))
    assert.deepEqual(form.writes[1].ops, [{ op: 'unset', path: ['keepPartial'] }], 'back to the default follows future defaults')
  } finally { await act(async () => root.unmount()) }
})
