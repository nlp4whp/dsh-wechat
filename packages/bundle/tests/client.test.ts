/**
 * The settings page loads, registers under the right ids, and renders without throwing.
 *
 * `client.js` runs in the DSH web shell, so it is evaluated here against a minimal shell: a module
 * loader, a slot registry, and a React stand-in whose `createElement` records the tree.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

test('client.js registers dsh-lark-plugin with a settings section and renders its loading state', () => {
  let loaded: { id: string; factory: (require: (name: string) => unknown) => unknown } | undefined
  const tree: string[] = []
  const React = {
    createElement: (type: unknown, _props: unknown, ...children: unknown[]) => {
      tree.push(typeof type === 'string' ? type : 'component')
      return { type, children }
    },
    useState: (initial: unknown) => [initial, () => {}],
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => (loaded = entry) } },
    document: { getElementById: () => null, createElement: () => ({}), head: { append: () => {} } },
    navigator: {},
    setTimeout: () => 0,
    fetch: async () => ({ ok: true, text: async () => '{}' }),
  })
  vm.runInContext(source, context)
  assert.equal(loaded?.id, 'dsh-lark-plugin')

  const plugin = loaded.factory((name) => {
    assert.equal(name, 'react')
    return React
  }) as { name: string; inject: string[]; apply: (ctx: unknown) => void }
  assert.equal(plugin.name, 'dsh-lark-plugin')
  assert.deepEqual([...plugin.inject], ['slots'])

  let section: { meta: { id: string; label: () => string }; component: () => unknown } | undefined
  plugin.apply({
    effect: (run: () => unknown) => run(),
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (meta: { id: string; label: () => string }, component: () => unknown) => {
        section = { meta, component }
        return () => {}
      },
    },
  })
  assert.equal(section?.meta.id, 'lark')
  assert.equal(section?.meta.label(), '飞书')
  section?.component()
  assert.ok(tree.includes('p'), 'the loading state renders')
})
