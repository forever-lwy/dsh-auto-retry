import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as Plugin from '../lib/index.js'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patchFile = new URL('../cordis.patch.yml', import.meta.url).pathname

test('package declares an installable ungated bundle with a browser build', async () => {
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.engines.dsh, '*', 'never gate on the dsh version')
  assert.equal(packageJson.exports['./client'], './lib/client.js')
  assert.ok(packageJson.files.includes('lib') && packageJson.files.includes('cordis.patch.yml'))
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{id:"@forever-lwy\/dsh-auto-retry"/)
  // Only Host-provided modules may be required by the browser half.
  assert.deepEqual([...new Set(client.match(/require\("[^"]+"\)/g))].sort(), ['require("react")', 'require("react/jsx-runtime")'])
})

test('every Config field is volatile, so the settings page can edit it live', () => {
  const fields = Object.entries(Plugin.Config.dict)
  assert.equal(fields.length, 11)
  for (const [key, node] of fields) assert.equal(node.meta.volatile, true, key)
})

test('the bundle row loads beside native services and applies edits without a remount', async () => {
  const rows = composeEntries([loadOverlayPatches('auto-retry-test', patchFile)])
  assert.deepEqual(rows.map(row => [row.id, row.name]), [['auto-retry', '@forever-lwy/dsh-auto-retry']])
  const ctx = new Context()
  try {
    for (const service of [SessionStore, AgentRegistry, SessionProjectionRegistry]) await ctx.plugin(service)
    const loader = new Loader(ctx, { baseUrl: new URL('../package.json', import.meta.url).href })
    await new Promise(resolve => setImmediate(resolve))
    const originalImport = loader.import.bind(loader)
    // cordis 4.1 keeps raw input on fiber.config; observe the config object the plugin itself receives.
    let config
    const observed = { ...Plugin, apply(pluginCtx, received, ...rest) { config = received; return Plugin.apply(pluginCtx, received, ...rest) } }
    loader.import = (name, ...args) => name === '@forever-lwy/dsh-auto-retry' ? observed : originalImport(name, ...args)
    await loader.root.update(rows)
    await loader.await()
    const entry = loader.resolve('auto-retry')
    assert.equal(entry.fiber.state, 2)
    const fiber = entry.fiber
    assert.equal(typeof config.maxRetries.get, 'function')
    assert.deepEqual(Plugin.readSettings(config), Plugin.readSettings({}))

    await loader.update('auto-retry', { config: { maxRetries: 2, statusCodes: [524], messagePatterns: ['custom'] } })
    await loader.await()
    assert.equal(loader.resolve('auto-retry').fiber, fiber, 'volatile edit keeps the running fiber')
    const live = Plugin.readSettings(config)
    assert.equal(live.maxRetries, 2)
    assert.deepEqual(live.statusCodes, [524])
    assert.deepEqual(live.messagePatterns, ['custom'])
    assert.deepEqual(live.codes, Plugin.DEFAULT_SETTINGS.codes)
  } finally { await ctx.fiber.dispose() }
})
