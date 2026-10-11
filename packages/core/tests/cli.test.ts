/**
 * The lark-cli boundary, exercised against a fake executable.
 *
 * These spawn a real subprocess, so they check what unit tests cannot: that arguments reach lark-cli
 * in the shape it accepts (relative media paths, global `--profile` first), that the JSON envelope is
 * read from whichever stream carries it, and that the event stream's process contract holds — ready
 * marker, NDJSON parsing, de-duplication, graceful stop through stdin, and giving up on auth errors.
 */

import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EventStream,
  LarkCliError,
  addReaction,
  authStatus,
  downloadResource,
  fetchMessage,
  sendFile,
  sendText,
  type InboundMessage,
} from '../src/index.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lark-cli.mjs')
chmodSync(FAKE, 0o755)

interface Sandbox {
  dir: string
  log: string
  calls(): Promise<{ args: string[]; cwd: string }[]>
}

async function sandbox(env: Record<string, string> = {}): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-cli-'))
  const log = join(dir, 'calls.ndjson')
  process.env.FAKE_LARK_LOG = log
  for (const key of ['FAKE_LARK_EVENTS', 'FAKE_LARK_EXIT', 'FAKE_LARK_FAIL']) delete process.env[key]
  Object.assign(process.env, env)
  return {
    dir,
    log,
    calls: async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string }),
  }
}

const connection = { cliPath: FAKE, profile: 'work' }

test('sendText sends Markdown as the bot to a chat, with the profile first', async () => {
  const box = await sandbox()
  try {
    const sent = await sendText(connection, { to: { chatId: 'oc_1' }, text: '**hi** "$HOME"' })
    assert.match(sent.messageId ?? '', /^om_sent_/)
    const [call] = await box.calls()
    assert.deepEqual(call.args.slice(0, 2), ['--profile', 'work'])
    assert.deepEqual(call.args.slice(2), ['im', '+messages-send', '--as', 'bot', '--chat-id', 'oc_1', '--markdown', '**hi** "$HOME"'])
  } finally {
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('sendFile runs in the file\'s directory with a relative path, as lark-cli requires', async () => {
  const box = await sandbox()
  try {
    const folder = join(box.dir, 'a folder')
    await mkdir(folder)
    await writeFile(join(folder, 'shot 1.png'), 'png')
    await writeFile(join(folder, 'notes.md'), 'md')

    const image = await sendFile(connection, { to: { chatId: 'oc_1' }, path: join(folder, 'shot 1.png') })
    const file = await sendFile(connection, { to: { userId: 'ou_1' }, path: join(folder, 'notes.md') })
    assert.equal(image.kind, 'image')
    assert.equal(file.kind, 'file')

    const [first, second] = await box.calls()
    assert.equal(first.cwd.endsWith('a folder'), true)
    assert.deepEqual(first.args.slice(-2), ['--image', './shot 1.png'])
    assert.deepEqual(second.args.slice(-4), ['--user-id', 'ou_1', '--file', './notes.md'])
  } finally {
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('a failed command throws with lark-cli\'s own message and hint', async () => {
  const box = await sandbox({ FAKE_LARK_FAIL: '+messages-send' })
  try {
    await assert.rejects(
      sendText(connection, { to: { chatId: 'oc_1' }, text: 'x' }),
      (error: unknown) =>
        error instanceof LarkCliError && error.kind === 'api' && /fake failure/.test(error.message) && error.hint === 'fake hint',
    )
  } finally {
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('a missing executable is reported as such, with how to install it', async () => {
  await assert.rejects(
    sendText({ cliPath: '/nonexistent/lark-cli' }, { to: { chatId: 'oc_1' }, text: 'x' }),
    (error: unknown) => error instanceof LarkCliError && error.kind === 'spawn' && /npm i -g @larksuite\/cli/.test(error.message),
  )
})

test('downloadResource keeps the server-side name under a unique prefix and cleans up', async () => {
  const box = await sandbox()
  try {
    const media = join(box.dir, 'media')
    await mkdir(media)
    const path = await downloadResource(connection, { messageId: 'om_1', key: 'file_v3_x', type: 'file', dir: media, prefix: 'p1' })
    assert.equal(path, join(media, 'p1-报告.pdf'))
    assert.equal(await readFile(path, 'utf8'), 'bytes-of-file_v3_x')
    // The scratch directory is gone; only the stored file remains.
    assert.deepEqual(await readdir(media), ['p1-报告.pdf'])
  } finally {
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('authStatus reads the bare JSON auth status prints', async () => {
  const box = await sandbox()
  try {
    const status = await authStatus(connection)
    assert.deepEqual(status, { appId: 'cli_fake', brand: 'feishu', botReady: true, message: 'Bot identity: ready' })
  } finally {
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('reactions and message lookup read their ids', async () => {
  const box = await sandbox()
  try {
    assert.equal(await addReaction(connection, 'om_1', 'Typing'), 'r_1')
    const fetched = await fetchMessage(connection, 'om_parent')
    assert.deepEqual(fetched, { messageId: 'om_parent', msgType: 'text', content: '被引用的原话', senderType: 'app' })
    const [create] = await box.calls()
    assert.ok(create.args.includes(JSON.stringify({ reaction_type: { emoji_type: 'Typing' } })))
  } finally {
    await rm(box.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'im.message.receive_v1',
    chat_type: 'p2p',
    chat_id: 'oc_1',
    sender_id: 'ou_1',
    sender_type: 'user',
    message_type: 'text',
    ...fields,
  })
}

function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (check()) resolve()
      else if (Date.now() - started > ms) reject(new Error('timed out waiting'))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

test('the stream reports ready, parses events, drops duplicates and bot echoes, and stops via stdin', async () => {
  const events = join(tmpdir(), `events-${Date.now()}.ndjson`)
  await writeFile(
    events,
    [
      line({ message_id: 'om_1', content: '第一条' }),
      line({ message_id: 'om_1', content: '第一条（重投）' }),
      line({ message_id: 'om_2', content: '我自己', sender_type: 'bot' }),
      'plain diagnostic text is ignored',
      '{not json',
      line({ message_id: 'om_3', message_type: 'image', content: '![Image](img_k)' }),
      '',
    ].join('\n'),
  )
  const box = await sandbox({ FAKE_LARK_EVENTS: events })
  const received: InboundMessage[] = []
  const errors: string[] = []
  let ready = 0
  const stream = new EventStream({
    connection,
    accountId: 'cli_fake',
    onMessage: async (message) => {
      received.push(message)
    },
    onReady: () => {
      ready += 1
    },
    onError: (error) => errors.push(error.message),
  })
  try {
    stream.start()
    await waitFor(() => received.length === 2)
    assert.equal(ready, 1)
    assert.equal(stream.ready, true)
    assert.deepEqual(
      received.map((m) => [m.messageId, m.text, m.resources.map((r) => r.key)]),
      [
        ['om_1', '第一条', []],
        ['om_3', '', ['img_k']],
      ],
    )
    assert.ok(errors.some((message) => message.includes('无法解析事件')))

    await stream.stop()
    assert.equal(stream.running, false)
    const [call] = await box.calls()
    assert.deepEqual(call.args, ['--profile', 'work', 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'])
  } finally {
    await stream.stop()
    await rm(events, { force: true })
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('an auth failure stops the stream for good instead of retrying', async () => {
  const box = await sandbox({ FAKE_LARK_EXIT: '3' })
  let fatal: string | undefined
  const stream = new EventStream({
    connection,
    accountId: 'cli_fake',
    onMessage: async () => {},
    onFatal: (reason) => {
      fatal = reason
    },
  })
  try {
    stream.start()
    await waitFor(() => fatal !== undefined)
    assert.match(fatal ?? '', /exit 3: missing scope/)
    assert.match(fatal ?? '', /fake hint/)
    assert.equal(stream.running, false)
    assert.equal((await box.calls()).length, 1)
  } finally {
    await stream.stop()
    await rm(box.dir, { recursive: true, force: true })
  }
})

test('an unexpected exit restarts the stream', async () => {
  const box = await sandbox({ FAKE_LARK_EXIT: '5' })
  const delays: number[] = []
  const stream = new EventStream({
    connection,
    accountId: 'cli_fake',
    onMessage: async () => {},
    sleep: async (ms) => {
      delays.push(ms)
    },
  })
  try {
    stream.start()
    await waitFor(() => delays.length >= 2)
    await stream.stop()
    assert.deepEqual(delays.slice(0, 2), [2_000, 5_000])
    assert.ok((await box.calls()).length >= 2)
  } finally {
    await stream.stop()
    await rm(box.dir, { recursive: true, force: true })
  }
})
