/**
 * Integration tests for the host glue.
 *
 * These mount the real `apply()` against a stub DSH host and an in-memory Feishu transport, then
 * drive messages through the whole pipeline: allowlist, routing, prompt submission, assistant-stream
 * replies, attachments, permission prompts, and the tools.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, type Internals, type LarkTransport, type StreamHandle } from '../src/host.ts'
import type { LarkContext } from '../src/services.ts'
import { encodeWorkspaceDir, toInbound, type InboundMessage, type StreamOptions } from '@dsh-lark/core'

const OWNER = 'ou_owner'
const STRANGER = 'ou_stranger'
const APP = 'cli_app'

interface Sent {
  chatId: string
  text?: string
  format?: string
  file?: string
}

interface Harness {
  home: string
  workspace: string
  runtime: {
    ingest(message: InboundMessage): Promise<void>
    status(): Promise<{ rejectedSenders: string[]; stream: { running: boolean; ready: boolean }; connection: { appId?: string } }>
    setEnabled(enabled: boolean): Promise<void>
    bindings(): Promise<{ sessionId: string; conversationId: string }[]>
  }
  sent: Sent[]
  reactions: string[]
  prompts: { sessionId: string; mode: string; text: string }[]
  created: { sessionId?: string; workspaceId?: string; cwd?: string }[]
  presets: { sessionId: string; preset: string }[]
  listeners: Map<string, (...args: unknown[]) => unknown>
  tools: Map<string, { execute: (args: Record<string, unknown>, exec: { agent?: unknown }) => Promise<unknown> }>
  streams: StreamOptions[]
  dispose(): void
}

let storeClock = 1_700_000_000_000

async function seedStoredSession(home: string, workspace: string, id: string, title: string): Promise<void> {
  const folder = join(home, 'sessions', encodeWorkspaceDir(workspace), id)
  await mkdir(folder, { recursive: true })
  const transcript = join(folder, 'session.v4.jsonl.zstd')
  await writeFile(transcript, 'x')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(
    join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    JSON.stringify({ record: { identity: { cwd: workspace }, rows: { title: { val: title } } } }),
  )
  storeClock += 1_000
  await utimes(transcript, storeClock / 1_000, storeClock / 1_000)
}

async function storedExists(home: string, sessionId: string): Promise<boolean> {
  try {
    for (const folder of await readdir(join(home, 'sessions'))) {
      if ((await readdir(join(home, 'sessions', folder))).includes(sessionId)) return true
    }
  } catch {
    // No store yet.
  }
  return false
}

async function seedState(home: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(home, 'lark'), { recursive: true })
  await writeFile(
    join(home, 'lark', 'state.json'),
    JSON.stringify({ version: 1, connection: { appId: APP }, bindings: {}, settings, ...extra }),
  )
}

async function mount(home: string, options: { failMarkdown?: boolean; failSend?: boolean } = {}): Promise<Harness> {
  const workspace = join(home, 'dsh_lark')
  const sent: Sent[] = []
  const reactions: string[] = []
  const prompts: Harness['prompts'] = []
  const created: Harness['created'] = []
  const presets: Harness['presets'] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const tools: Harness['tools'] = new Map()
  const streams: StreamOptions[] = []
  let disposer: (() => void) | undefined
  let runtime: Harness['runtime'] | undefined

  const transport: LarkTransport = {
    sendText: async (to, text, format) => {
      if (options.failSend === true) throw new Error('network down')
      if (options.failMarkdown === true && format === 'markdown') {
        const { LarkCliError } = await import('@dsh-lark/core')
        throw new LarkCliError('post rejected', { kind: 'api' })
      }
      sent.push({ chatId: 'chatId' in to ? to.chatId : to.userId, text, format })
      return { messageId: `om_out_${String(sent.length)}` }
    },
    sendFile: async (to, path) => {
      sent.push({ chatId: 'chatId' in to ? to.chatId : to.userId, file: path })
      return { messageId: `om_out_${String(sent.length)}`, kind: /\.png$/.test(path) ? 'image' : 'file' }
    },
    addReaction: async (messageId, emoji) => {
      reactions.push(`+${emoji}@${messageId}`)
      return `r_${messageId}`
    },
    deleteReaction: async (messageId) => {
      reactions.push(`-@${messageId}`)
    },
    download: async ({ key, dir, prefix }) => {
      const path = join(dir, `${prefix}-${key}.png`)
      await writeFile(path, 'image-bytes')
      return path
    },
    fetchMessage: async (messageId) => ({ messageId, msgType: 'text', content: '这是被引用的话', senderType: 'app' }),
    authStatus: async () => ({ appId: APP, brand: 'feishu', botReady: true }),
  }

  const createStream = (streamOptions: StreamOptions): StreamHandle => {
    streams.push(streamOptions)
    let running = false
    return {
      start: () => {
        running = true
      },
      stop: async () => {
        running = false
      },
      get ready() {
        return running
      },
      get running() {
        return running
      },
      lastError: undefined,
    }
  }

  const workspaceObject = {
    id: 'workspace-lark',
    path: workspace,
    title: 'Ungrouped',
    async setTitle(title: string) {
      workspaceObject.title = title
    },
  }

  const ctx = {
    sessionController: {
      create: async (request: { sessionId?: string; workspaceId?: string; cwd?: string }) => {
        created.push(request)
        return { sessionId: request.sessionId ?? 'session-x' }
      },
      prompt: async (request: { sessionId: string; mode: string; content: readonly { text: string }[] }) => {
        // The real host writes a session to its store on first use.
        if (!(await storedExists(home, request.sessionId))) await seedStoredSession(home, workspace, request.sessionId, '')
        prompts.push({ sessionId: request.sessionId, mode: request.mode, text: request.content.map((c) => c.text).join('') })
        return { accepted: true as const }
      },
      list: async () => [],
      cancel: async () => ({}),
    },
    sessions: { get: (id: string) => ({ id }) },
    workspaceRegistry: {
      resolveByPath: async () => workspaceObject,
      create: async () => workspaceObject,
      get: () => workspaceObject,
      list: () => [workspaceObject],
    },
    tools: {
      register: (definition: { name: string; execute: (args: Record<string, unknown>, exec: { agent?: unknown }) => Promise<unknown> }) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(execute: () => void | (() => void)) {
      disposer = execute() ?? undefined
    },
    get(name: string) {
      if (name === 'homePaths') return { home }
      if (name === 'webServer') return { port: 0, register: () => () => {} }
      if (name === 'sessions') return { get: (id: string) => ({ id }) }
      if (name === 'permissionPresets') {
        return { set: (session: { id: string }, preset: string) => presets.push({ sessionId: session.id, preset }) }
      }
      return undefined
    },
    provide(name: string, value: unknown) {
      if (name === 'larkChannel') runtime = value as Harness['runtime']
    },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  } as unknown as LarkContext

  const internals: Internals = { transport, createStream }
  apply(ctx, {}, internals)
  assert.ok(runtime, 'the runtime must be provided')
  // Let the boot task (enabled? → start) settle.
  await new Promise((resolve) => setTimeout(resolve, 20))
  return {
    home,
    workspace,
    runtime,
    sent,
    reactions,
    prompts,
    created,
    presets,
    listeners,
    tools,
    streams,
    dispose: () => disposer?.(),
  }
}

let messageSeq = 0

function inbound(text: string, fields: Record<string, unknown> = {}): InboundMessage {
  messageSeq += 1
  const message = toInbound(APP, {
    message_id: `om_in_${String(messageSeq)}`,
    chat_id: 'oc_dm',
    chat_type: 'p2p',
    message_type: 'text',
    content: text,
    sender_id: OWNER,
    sender_type: 'user',
    ...fields,
  })
  assert.ok(message)
  return message
}

/** Emit the assistant stream for one session: some text, then the end frame. */
function stream(harness: Harness, sessionId: string, ...chunks: string[]): void {
  const listener = harness.listeners.get('agent/assistant-stream')
  assert.ok(listener)
  const agent = { session: { id: sessionId } }
  for (const text of chunks) listener({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } })
  listener({ agent, frame: { type: 'end' } })
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-lark-test-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

// ---------------------------------------------------------------------------

test('a stranger is refused, told their open_id once, and never reaches a session', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('rm -rf ~', { sender_id: STRANGER }))
      await harness.runtime.ingest(inbound('again', { sender_id: STRANGER }))
      assert.equal(harness.prompts.length, 0)
      assert.equal(harness.created.length, 0)
      assert.equal(harness.sent.length, 1, 'the notice is rate-limited')
      assert.match(harness.sent[0].text ?? '', new RegExp(STRANGER))
      assert.deepEqual((await harness.runtime.status()).rejectedSenders, [STRANGER])
    } finally {
      harness.dispose()
    }
  })
})

test('an empty allowlist admits nobody, the owner included', async () => {
  await withHome(async (home) => {
    await seedState(home, {})
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('hello'))
      assert.equal(harness.prompts.length, 0)
      assert.match(harness.sent[0]?.text ?? '', /ou_owner/)
    } finally {
      harness.dispose()
    }
  })
})

test('an allowed message creates a session in the channel workspace and prompts it', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('帮我看下磁盘空间'))
      assert.equal(harness.created[0]?.workspaceId, 'workspace-lark')
      assert.deepEqual(harness.presets.map((p) => p.preset), ['danger-full-access'])
      // First message: the user's words alone (DSH names the session from it), then the note.
      assert.equal(harness.prompts[0]?.text, '帮我看下磁盘空间')
      assert.equal(harness.prompts[0]?.mode, 'steer')
      assert.match(harness.prompts[1]?.text ?? '', /^\[渠道：飞书\]/)
      // Second message carries the note inline.
      await harness.runtime.ingest(inbound('继续'))
      assert.match(harness.prompts.at(-1)?.text ?? '', /^继续\n\n\[渠道：飞书\]/)
      assert.equal(new Set(harness.prompts.map((p) => p.sessionId)).size, 1)
    } finally {
      harness.dispose()
    }
  })
})

test('the assistant stream becomes one Markdown reply in the same chat, and clears the working reaction', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      const message = inbound('hi')
      await harness.runtime.ingest(message)
      assert.deepEqual(harness.reactions, [`+Typing@${message.messageId}`])
      const sessionId = harness.prompts[0].sessionId
      stream(harness, sessionId, '# 结果\n', '磁盘还剩 ', '42GB')
      await settle()
      assert.deepEqual(harness.sent, [{ chatId: 'oc_dm', text: '# 结果\n磁盘还剩 42GB', format: 'markdown' }])
      assert.deepEqual(harness.reactions, [`+Typing@${message.messageId}`, `-@${message.messageId}`])
    } finally {
      harness.dispose()
    }
  })
})

test('a rejected Markdown post is retried as plain text', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home, { failMarkdown: true })
    try {
      await harness.runtime.ingest(inbound('/help'))
      assert.equal(harness.sent.length, 1)
      assert.equal(harness.sent[0].format, 'text')
      assert.match(harness.sent[0].text ?? '', /可用指令/)
    } finally {
      harness.dispose()
    }
  })
})

test('slash commands are answered locally and never reach the agent', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('/new 周报'))
      await harness.runtime.ingest(inbound('/current'))
      assert.equal(harness.prompts.length, 0)
      assert.match(harness.sent[0]?.text ?? '', /已新建对话「周报」/)
      assert.match(harness.sent[1]?.text ?? '', /当前对话「周报」/)
    } finally {
      harness.dispose()
    }
  })
})

test('group messages are ignored by default and handled, mention stripped, once allowed', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const off = await mount(home)
    try {
      await off.runtime.ingest(inbound('@_user_1 /help', { chat_type: 'group', chat_id: 'oc_group' }))
      assert.equal(off.sent.length, 0)
    } finally {
      off.dispose()
    }
  })
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER], allowGroups: true })
    const on = await mount(home)
    try {
      await on.runtime.ingest(
        inbound('@_user_1 /help', { chat_type: 'group', chat_id: 'oc_group', mentions: [{ key: '@_user_1', name: 'moss', id: 'ou_bot' }] }),
      )
      assert.equal(on.sent[0]?.chatId, 'oc_group')
      assert.match(on.sent[0]?.text ?? '', /可用指令/)
    } finally {
      on.dispose()
    }
  })
})

test('an image is downloaded into the workspace and folded into the next instruction', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('![Image](img_v3_abc)', { message_type: 'image' }))
      assert.equal(harness.prompts.length, 0, 'an attachment waits for its instruction')
      await harness.runtime.ingest(inbound('这张图里写了什么'))
      const prompt = harness.prompts[0]?.text ?? ''
      assert.match(prompt, /^这张图里写了什么/)
      assert.match(prompt, /\[图片\] .*dsh_lark\/媒体\/.*img_v3_abc\.png/)
      const stored = await readdir(join(harness.workspace, '媒体'))
      assert.equal(stored.length, 1)
    } finally {
      harness.dispose()
    }
  })
})

test('a quoted message is fetched and handed to the agent as context', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('展开说说', { reply_to: 'om_parent' }))
      assert.match(harness.prompts[0]?.text ?? '', /展开说说\n\n\[引用我此前发送的消息\]\n这是被引用的话/)
    } finally {
      harness.dispose()
    }
  })
})

test('a long reply goes out as a Markdown file, not truncated', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER], maxReplyChars: 20 })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('写长一点'))
      stream(harness, harness.prompts[0].sessionId, 'x'.repeat(50))
      await settle()
      assert.match(harness.sent[0]?.text ?? '', /已作为文件发送/)
      const file = harness.sent[1]?.file ?? ''
      assert.match(file, /\.md$/)
      assert.equal(await readFile(file, 'utf8'), 'x'.repeat(50))
    } finally {
      harness.dispose()
    }
  })
})

test('a permission prompt for a bound session is asked in Feishu and answered by reply', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('删掉临时文件'))
      const sessionId = harness.prompts[0].sessionId
      const listener = harness.listeners.get('approval/request')
      assert.ok(listener)
      const outcome = listener(
        { agent: { session: { id: sessionId } }, toolName: 'bash', command: 'rm /tmp/x' },
        async () => 'cancelled',
      ) as Promise<string>
      await settle()
      assert.match(harness.sent.at(-1)?.text ?? '', /需要你确认：bash/)
      await harness.runtime.ingest(inbound('允许'))
      assert.equal(await outcome, 'allowed-once')
      // The answer was consumed, not sent to the agent as a new message.
      assert.equal(harness.prompts.filter((p) => p.text.startsWith('允许')).length, 0)
    } finally {
      harness.dispose()
    }
  })
})

test('a permission prompt for an unbound session is delegated to the desktop', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      const listener = harness.listeners.get('approval/request')
      assert.ok(listener)
      const outcome = await (listener({ agent: { session: { id: 'session-desktop' } }, toolName: 'bash' }, async () => 'desktop') as Promise<string>)
      assert.equal(outcome, 'desktop')
      assert.equal(harness.sent.length, 0)
    } finally {
      harness.dispose()
    }
  })
})

test('send_to_lark sends a file to the calling session\'s chat, and refuses an unbound caller', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('把截图发我'))
      const sessionId = harness.prompts[0].sessionId
      const shot = join(home, 'shot.png')
      await writeFile(shot, 'png')
      const tool = harness.tools.get('send_to_lark')
      assert.ok(tool)
      const result = (await tool.execute({ path: shot, caption: '截图如下' }, { agent: { session: { id: sessionId } } })) as { detail: string }
      assert.match(result.detail, /已发送 shot\.png/)
      assert.deepEqual(harness.sent.slice(-2).map((s) => s.text ?? s.file), ['截图如下', shot])
      await assert.rejects(tool.execute({ path: shot }, { agent: { session: { id: 'session-other' } } }), /没有绑定飞书对话/)
    } finally {
      harness.dispose()
    }
  })
})

test('notify_lark reaches the last-used chat from any session, and only the bound one when disabled', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      const tool = harness.tools.get('notify_lark')
      assert.ok(tool)
      await assert.rejects(tool.execute({ text: '完成' }, { agent: { session: { id: 'session-desktop' } } }), /还没有飞书对话/)
      await harness.runtime.ingest(inbound('hi'))
      const result = (await tool.execute({ text: '任务完成' }, { agent: { session: { id: 'session-desktop' } } })) as { detail: string }
      assert.equal(result.detail, '已通过飞书发送：消息')
      assert.deepEqual(harness.sent.at(-1), { chatId: 'oc_dm', text: '任务完成', format: 'markdown' })
    } finally {
      harness.dispose()
    }
  })
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER], allowCrossSessionNotify: false })
    const harness = await mount(home)
    try {
      await harness.runtime.ingest(inbound('hi'))
      const tool = harness.tools.get('notify_lark')
      assert.ok(tool)
      await assert.rejects(tool.execute({ text: 'x' }, { agent: { session: { id: 'session-desktop' } } }), /允许其他会话推送到飞书/)
    } finally {
      harness.dispose()
    }
  })
})

test('enabling the channel checks lark-cli, records the app id, and starts one stream', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home)
    try {
      assert.equal(harness.streams.length, 0, 'off until enabled')
      await harness.runtime.setEnabled(true)
      await harness.runtime.setEnabled(true)
      assert.equal(harness.streams.length, 1)
      assert.equal(harness.streams[0].accountId, APP)
      const status = await harness.runtime.status()
      assert.equal(status.stream.running, true)
      assert.equal(status.connection.appId, APP)
      await harness.runtime.setEnabled(false)
      assert.equal((await harness.runtime.status()).stream.running, false)
    } finally {
      harness.dispose()
    }
  })
})

test('a stored autoStart reconnects on boot', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] }, { autoStart: true })
    const harness = await mount(home)
    try {
      assert.equal(harness.streams.length, 1)
    } finally {
      harness.dispose()
    }
  })
})

test('a send failure is logged, and the user\'s words are not lost to the agent', async () => {
  await withHome(async (home) => {
    await seedState(home, { allowedUsers: [OWNER] })
    const harness = await mount(home, { failSend: true })
    try {
      await harness.runtime.ingest(inbound('正常任务'))
      assert.equal(harness.prompts[0]?.text, '正常任务')
      stream(harness, harness.prompts[0].sessionId, '回复')
      await settle()
      const log = await readFile(join(home, 'lark', 'boot.log'), 'utf8')
      assert.match(log, /发送失败: network down/)
    } finally {
      harness.dispose()
    }
  })
})
