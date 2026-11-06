import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(new URL('../../companion/package.json', import.meta.url))
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { transformSync } = require('esbuild')
const jsx = await readFile(new URL('../../companion/src/discord-setup.jsx', import.meta.url), 'utf8')
const source = jsx.slice(jsx.indexOf('function setupFailureMessage'), jsx.indexOf('const root ='))
const { code } = transformSync(source, { loader: 'jsx', target: 'es2022' })
function fixture(verified) {
  let index = 0
  const messages = [], requests = []
  const Setup = vm.runInNewContext(code + ';Setup', { React, challenge: 'fixture-challenge',
    useState: initial => { const state = index++; return [state === 2 ? verified : initial, value => { if (state === 0) messages.push(value) }] },
    usePrivy: () => ({ ready: true, authenticated: true, user: { discord: {} }, getAccessToken: async () => 'fixture-token' }),
    useLinkAccount: () => ({}), sessionStorage: { removeItem() {} },
    fetch: async path => { requests.push(path); return { ok: true, json: async () => ({ verified: true }) } } })
  return { Setup, messages, requests }
}
function findButton(element, label) {
  if (!React.isValidElement(element)) return null
  if (element.type === 'button' && element.props.children === label) return element
  return React.Children.toArray(element.props.children).map(child => findButton(child, label)).find(Boolean)
}
for (const available of [true, undefined]) {
  const { Setup, requests } = fixture(true)
  const markup = renderToStaticMarkup(React.createElement(Setup, { walletSetupAvailable: available }))
  assert.match(markup, /Create or view my managed test wallet/)
  assert.equal(requests.length, 0)
}
const disabled = fixture(true)
const markup = renderToStaticMarkup(React.createElement(disabled.Setup, { walletSetupAvailable: false }))
assert(!markup.includes('Create or view my managed test wallet'))
assert.match(markup, /Wallet setup is unavailable in this session/)
assert.equal(disabled.requests.length, 0)
const finishing = fixture(false)
await findButton(finishing.Setup({ walletSetupAvailable: false }), 'Finish Discord setup').props.onClick()
assert.deepEqual(finishing.requests, ['/api/discord/complete'])
assert.match(finishing.messages.at(-1), /\/join to approve your Minecraft connection/)
assert.match(finishing.messages.at(-1), /Wallet setup is unavailable/)
console.log('PASS setup UI hides unavailable wallet actions, directs identity-only users to join approval and preserves normal defaults; only injected HTTP fixtures used')
