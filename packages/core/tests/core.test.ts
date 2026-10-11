/**
 * Unit tests for `@dsh-lark/core`: content parsing, the lark-cli envelope, settings, routing.
 *
 * The router tests are carried over from the WeChat build unchanged in substance; only the
 * conversation ids changed shape.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  HELP_TEXT,
  SessionRouter,
  StateStore,
  chatOfConversation,
  conversationKey,
  extractEnvelope,
  globalArgs,
  isAllowed,
  mintSessionId,
  normalizeSettings,
  outboundKindOf,
  parseContent,
  resolveSettings,
  resolveTarget,
  shortId,
  splitCommand,
  stripLeadingMention,
  toInbound,
  type SessionBinding,
  type SessionGateway,
} from '../src/index.ts'

// ---------------------------------------------------------------------------
// Content parsing
// ---------------------------------------------------------------------------

test('plain text passes through untouched', () => {
  assert.deepEqual(parseContent('text', '你好，帮我看下日志'), { text: '你好，帮我看下日志', resources: [] })
})

test('an image placeholder becomes a resource and leaves no text behind', () => {
  const parsed = parseContent('image', '![Image](img_v3_02ab_xyz)')
  assert.equal(parsed.text, '')
  assert.deepEqual(parsed.resources, [{ key: 'img_v3_02ab_xyz', type: 'image', kind: 'image' }])
})

test('file, audio and video placeholders are read by attribute name', () => {
  const file = parseContent('file', '<file key="file_v3_abc" name="报告 v2.pdf"/>')
  assert.deepEqual(file.resources, [{ key: 'file_v3_abc', type: 'file', kind: 'file', name: '报告 v2.pdf' }])

  // Attribute order is not assumed.
  const audio = parseContent('audio', '<audio duration="3s" key="file_v3_aud"/>')
  assert.deepEqual(audio.resources, [{ key: 'file_v3_aud', type: 'file', kind: 'audio', duration: '3s' }])

  const video = parseContent('media', '<video key="file_v3_vid" name="clip.mp4">')
  assert.deepEqual(video.resources, [{ key: 'file_v3_vid', type: 'file', kind: 'video', name: 'clip.mp4' }])
})

test('a rich post keeps its text and collects every embedded image in order', () => {
  const parsed = parseContent('post', '看这两张\n![Image](img_a)\n和\n![Image](img_b)\n怎么样')
  assert.deepEqual(
    parsed.resources.map((r) => r.key),
    ['img_a', 'img_b'],
  )
  assert.equal(parsed.text, '看这两张\n\n和\n\n怎么样')
})

test('an unseen rendering of a media message still yields its key', () => {
  const parsed = parseContent('image', 'img_v3_unusualform123')
  assert.equal(parsed.resources[0]?.key, 'img_v3_unusualform123')
  assert.equal(parsed.resources[0]?.type, 'image')
})

test('mention placeholders become names, and a leading bot mention can be stripped', () => {
  const parsed = parseContent('text', '@_user_1 /list', [{ key: '@_user_1', name: 'moss', id: 'ou_bot' }])
  assert.equal(parsed.text, '@moss /list')
  assert.equal(stripLeadingMention(parsed.text, ['moss']), '/list')
  assert.equal(stripLeadingMention('@moss @moss 继续', ['moss']), '继续')
  assert.equal(stripLeadingMention('hello @moss', ['moss']), 'hello @moss')
})

test('a forwarded card is handed over as text, never parsed as resources', () => {
  const parsed = parseContent('interactive', '{"elements":[{"tag":"img","img_key":"img_x"}]}')
  assert.equal(parsed.resources.length, 0)
  assert.match(parsed.text, /^\[卡片消息\]/)
})

// ---------------------------------------------------------------------------
// Inbound envelope
// ---------------------------------------------------------------------------

const event = {
  type: 'im.message.receive_v1',
  message_id: 'om_1',
  chat_id: 'oc_chat1',
  chat_type: 'p2p',
  message_type: 'text',
  content: '你好',
  sender_id: 'ou_user1',
  sender_type: 'user',
}

test('toInbound keys the conversation by chat and keeps the message id', () => {
  const inbound = toInbound('cli_app', event)
  assert.ok(inbound)
  assert.equal(inbound.conversationId, 'cli_app:oc_chat1')
  assert.equal(inbound.peerId, 'ou_user1')
  assert.equal(inbound.messageId, 'om_1')
  assert.equal(chatOfConversation(inbound.conversationId), 'oc_chat1')
})

test('toInbound drops bot messages, so the channel cannot answer itself', () => {
  assert.equal(toInbound('cli_app', { ...event, sender_type: 'bot' }), undefined)
  assert.equal(toInbound('cli_app', { ...event, sender_type: 'app' }), undefined)
})

test('toInbound drops events missing an id, sender, chat, or any content', () => {
  assert.equal(toInbound('cli_app', { ...event, message_id: '' }), undefined)
  assert.equal(toInbound('cli_app', { ...event, sender_id: undefined }), undefined)
  assert.equal(toInbound('cli_app', { ...event, chat_id: undefined }), undefined)
  assert.equal(toInbound('cli_app', { ...event, content: '   ' }), undefined)
})

test('toInbound keeps the quoted message id for context', () => {
  assert.equal(toInbound('cli_app', { ...event, reply_to: 'om_parent' })?.replyTo, 'om_parent')
})

test('chatOfConversation refuses a key that names no chat', () => {
  assert.equal(chatOfConversation(conversationKey('cli_app', 'oc_x')), 'oc_x')
  assert.equal(chatOfConversation('cli_app:ou_user'), undefined)
})

// ---------------------------------------------------------------------------
// lark-cli plumbing
// ---------------------------------------------------------------------------

test('extractEnvelope finds pretty JSON after diagnostic lines', () => {
  const stderr = [
    '[event] consuming as cli_app (cli_app)',
    '[event] local bus not found; checking remote connections...',
    '{',
    '  "ok": false,',
    '  "error": { "type": "auth", "message": "missing token", "hint": "run auth login" }',
    '}',
  ].join('\n')
  const envelope = extractEnvelope(stderr)
  assert.equal(envelope?.ok, false)
  assert.equal(envelope?.error?.type, 'auth')
  assert.equal(envelope?.error?.hint, 'run auth login')
  assert.equal(extractEnvelope(''), undefined)
  assert.equal(extractEnvelope('no json here'), undefined)
})

test('globalArgs puts the profile first and omits it when blank', () => {
  assert.deepEqual(globalArgs({ profile: 'work' }), ['--profile', 'work'])
  assert.deepEqual(globalArgs({ profile: '  ' }), [])
  assert.deepEqual(globalArgs({}), [])
})

test('outboundKindOf sends pictures as images and everything else as files', () => {
  assert.equal(outboundKindOf('a.PNG'), 'image')
  assert.equal(outboundKindOf('photo.jpeg'), 'image')
  assert.equal(outboundKindOf('clip.mp4'), 'file')
  assert.equal(outboundKindOf('notes.md'), 'file')
})

// ---------------------------------------------------------------------------
// Settings and the allowlist
// ---------------------------------------------------------------------------

test('the allowlist is empty by default, which admits nobody', () => {
  const settings = resolveSettings({})
  assert.deepEqual(settings.allowedUsers, [])
  assert.equal(isAllowed(settings, 'ou_anyone'), false)
  assert.equal(settings.allowGroups, false)
})

test('normalizeSettings keeps only well-formed open_ids, deduplicated', () => {
  const patch = normalizeSettings({ allowedUsers: [' ou_abc ', 'ou_abc', 'user@x', 42, 'ou_def', ''] })
  assert.deepEqual(patch.allowedUsers, ['ou_abc', 'ou_def'])
  assert.equal(isAllowed(resolveSettings({ settings: patch }), 'ou_def'), true)
})

test('normalizeSettings drops values of the wrong type or out of range', () => {
  const patch = normalizeSettings({
    settleMs: '100',
    maxReplyChars: -1,
    mergeWindowMs: 5000.4,
    permissionPreset: 'root',
    workingEmoji: 'Typing; rm -rf',
    allowGroups: 'yes',
  })
  assert.deepEqual(patch, { mergeWindowMs: 5000 })
  assert.equal(normalizeSettings({ workingEmoji: 'OnIt' }).workingEmoji, 'OnIt')
  assert.equal(normalizeSettings({ workingEmoji: '' }).workingEmoji, '')
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** In-memory gateway that records every host call. */
class FakeGateway implements SessionGateway {
  readonly calls: string[] = []
  readonly prompts: { sessionId: string; text: string }[] = []
  sessions: { sessionId: string; title: string; updatedAt: number }[] = []
  /** Sessions belonging to other workspaces, which `listOwnSessions` must exclude. */
  readonly foreign: { sessionId: string; title: string; updatedAt: number }[] = []
  /**
   * Clock for seeded sessions, advanced a second per session.
   *
   * `Date.now()` gives two sessions created in the same millisecond the same timestamp, and the list
   * orders by it — so the order would be whatever the sort happened to do with the tie. Spacing the
   * values keeps the ordering a fact rather than a coincidence.
   */
  #clock = 1_700_000_000_000

  /** Next timestamp for a seeded session, a second after the previous one. */
  nextStamp(): number {
    this.#clock += 1_000
    return this.#clock
  }

  async ensureSession(sessionId: string, title: string): Promise<void> {
    this.calls.push(`ensure:${sessionId}:${title}`)
    if (!this.sessions.some((s) => s.sessionId === sessionId)) {
      // Spaced rather than `Date.now()`, so the list's ordering is a fact and not a tie to break.
      this.sessions.push({ sessionId, title, updatedAt: this.nextStamp() })
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push({ sessionId, text })
  }

  async listSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    return [...this.sessions, ...this.foreign].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** What `/list` shows by default: this workspace only, newest first. */
  async listOwnSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push(`cancel:${sessionId}`)
  }
}

/** In-memory binding store. */
function memoryStore() {
  let data: Record<string, SessionBinding> = {}
  return {
    async load() {
      return data
    },
    async save(next: Record<string, SessionBinding>) {
      data = next
    },
    peek: () => data,
  }
}

const conversation = {
  conversationId: 'cli_app:oc_chat1',
  accountId: 'cli_app',
  peerId: 'ou_user1',
}

test('first message auto-binds a new session and returns a prompt decision', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const result = await router.route({ ...conversation, text: '帮我看看这个 bug' })
  assert.equal(result.kind, 'prompt')
  if (result.kind !== 'prompt') return
  assert.equal(result.decision.created, true)
  assert.equal(result.decision.prompt, '帮我看看这个 bug')
  assert.match(result.decision.sessionId, /^session-[0-9a-f]{8}-[0-9a-f-]{36}$/)
  // Binding creates the session but delivery belongs to the caller, which owns
  // typing indicators, reply correlation, and streaming.
  assert.deepEqual(gateway.prompts, [])
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${result.decision.sessionId}:`)))
})

test('a second message reuses the same session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'one' })
  const second = await router.route({ ...conversation, text: 'two' })
  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(first.decision.sessionId, second.decision.sessionId)
  assert.equal(second.decision.created, false)
  // The reused session is re-ensured so a host restart cannot strand it.
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${first.decision.sessionId}:`)))
})

test('/new creates a distinct session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'hello' })
  const created = await router.route({ ...conversation, text: '/new 重构任务' })
  const after = await router.route({ ...conversation, text: '继续' })

  assert.equal(created.kind, 'reply')
  if (created.kind === 'reply') assert.match(created.text, /重构任务/)
  assert.equal(first.kind, 'prompt')
  assert.equal(after.kind, 'prompt')
  if (first.kind !== 'prompt' || after.kind !== 'prompt') return
  assert.notEqual(first.decision.sessionId, after.decision.sessionId)
})

test('/list marks the current session and /switch moves between them', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'first session' })
  const created = await router.route({ ...conversation, text: '/new 第二个' })
  assert.equal(first.kind, 'prompt')
  assert.equal(created.kind, 'reply')
  if (first.kind !== 'prompt') return

  // The marker sits on the session we just created.
  const listed = await router.route({ ...conversation, text: '/list' })
  assert.equal(listed.kind, 'reply')
  if (listed.kind !== 'reply') return
  const markedLine = listed.text.split('\n').find((line) => line.includes('← 当前'))
  assert.ok(markedLine, 'expected a current-session marker')
  assert.match(markedLine, /第二个/)

  // Switch to the *first* session by its short id, which is unambiguous.
  const switched = await router.route({
    ...conversation,
    text: `/switch ${first.decision.sessionId}`,
  })
  assert.equal(switched.kind, 'reply')
  if (switched.kind === 'reply') assert.match(switched.text, /已切换/)

  const after = await router.route({ ...conversation, text: '/current' })
  if (after.kind !== 'reply') return
  assert.match(after.text, new RegExp(shortId(first.decision.sessionId)))
  assert.doesNotMatch(after.text, /第二个/)
})

test('/list shows this workspace and mentions the rest, and /list all shows everything', async () => {
  /*
   * The typed and spoken routes have to agree. Before this, `/list` printed every session on the
   * machine — sixty-six of them here, ten of which belonged to this workspace — while a spoken
   * request showed only the ten and said how many others existed. The same question giving two
   * different answers is what makes a command feel broken.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  await router.route({ ...conversation, text: 'one' })
  const mine = await gateway.listSessions()
  // A session belonging to another project, which the gateway reports separately.
  gateway.foreign.push({ sessionId: 'session-ffff9999-ffff9999-x', title: '别处的工作', updatedAt: gateway.nextStamp() })

  const own = await router.route({ ...conversation, text: '/list' })
  assert.equal(own.kind, 'reply')
  if (own.kind !== 'reply') return
  // The count includes the held sessions, so the user knows the size of what they are not seeing.
  assert.match(own.text, new RegExp(`共 ${String(mine.length + 1)} 个对话`))
  assert.doesNotMatch(own.text, /别处的工作/, 'the default list is this workspace only')
  assert.match(own.text, /另有 1 个对话在其它工作区/)
  // And how to reach them, or the hint is useless.
  assert.match(own.text, /\/list all/)

  const all = await router.route({ ...conversation, text: '/list all' })
  assert.equal(all.kind, 'reply')
  if (all.kind !== 'reply') return
  assert.match(all.text, /别处的工作/, 'the wider list shows it')
  assert.doesNotMatch(all.text, /另有/, 'nothing is being held back now')
})

test('a binding moves on, and switching back points at that session again', async () => {
  /*
   * This replaced a test of the session-owner map, which was removed.
   *
   * The map existed to answer "which conversation does this session belong to?" for sessions a
   * conversation had left, because `bindings` only records where it is now. That turned out to be
   * unnecessary — and actively harmful: a session the conversation had moved away from stayed an
   * owner forever, and ownership was being read as permission to send messages. A conversation that
   * switched away left its former session able to speak for it indefinitely.
   *
   * What actually has to hold is the pair below: the binding moves, and switching back restores it.
   */
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const first = await router.route({ ...conversation, text: 'one' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  await router.route({ ...conversation, text: '/new 修复登录' })

  // The binding moved: the old session is no longer the one this conversation points at.
  assert.equal(
    Object.values(store.peek()).some((entry) => entry.sessionId === first.decision.sessionId),
    false,
    'the binding really did move on',
  )

  // And switching back by short id restores it, so tools called from it resolve again — which is the
  // case the owner map was built for, now handled by the binding itself.
  const back = await router.route({ ...conversation, text: `/switch ${shortId(first.decision.sessionId)}` })
  assert.equal(back.kind, 'reply')
  if (back.kind !== 'reply') return
  assert.match(back.text, /已切换/)
  assert.equal(
    Object.values(store.peek())[0]?.sessionId,
    first.decision.sessionId,
    'switching back makes it the bound session again',
  )
})

test('routing state survives a new router instance', async () => {
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })
  const first = await router.route({ ...conversation, text: 'one' })

  const reborn = new SessionRouter({ gateway, store })
  const second = await reborn.route({ ...conversation, text: 'two' })

  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(first.decision.sessionId, second.decision.sessionId)
})

test('/cancel and /current are answered locally', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  // With no binding yet, both commands answer with guidance instead of calling out.
  const noSession = await router.route({ ...conversation, text: '/cancel' })
  assert.equal(noSession.kind, 'reply')
  if (noSession.kind === 'reply') assert.match(noSession.text, /没有对话/)
  assert.equal(gateway.calls.length, 0)

  const bound = await router.route({ ...conversation, text: 'work' })
  assert.equal(bound.kind, 'prompt')

  const current = await router.route({ ...conversation, text: '/current' })
  assert.equal(current.kind, 'reply')
  if (current.kind === 'reply') assert.match(current.text, /当前对话/)

  const cancelled = await router.route({ ...conversation, text: '/cancel' })
  assert.equal(cancelled.kind, 'reply')
  if (cancelled.kind === 'reply') assert.match(cancelled.text, /已请求中断/)
  assert.ok(gateway.calls.some((call) => call.startsWith('cancel:')))
})

test('an unknown command explains itself instead of reaching the agent', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const result = await router.route({ ...conversation, text: '/nope' })
  assert.equal(result.kind, 'reply')
  if (result.kind === 'reply') assert.match(result.text, /未知指令/)
  assert.equal(gateway.prompts.length, 0)
})

test('/help returns the command list and never prompts', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const result = await router.route({ ...conversation, text: '/help' })
  assert.equal(result.kind, 'reply')
  if (result.kind === 'reply') assert.equal(result.text, HELP_TEXT)
  assert.equal(gateway.prompts.length, 0)
})

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

test('a store seeds from an existing file without losing its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-state-'))
  try {
    const file = join(dir, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        connection: { profile: 'work', appId: 'cli_app' },
        bindings: {},
        autoStart: true,
        settings: { allowedUsers: ['ou_owner'] },
      }),
      'utf8',
    )
    const store = new StateStore(file)
    // Concurrent reads must all observe the file, not a fallback empty state.
    const [first, second] = await Promise.all([store.read(), store.read()])
    for (const state of [first, second]) {
      assert.equal(state.connection.profile, 'work')
      assert.equal(state.autoStart, true)
    }
    const store2 = new StateStore(file)
    const read = store2.read()
    const update = store2.update((state) => {
      state.autoStart = false
    })
    await Promise.all([read, update])
    const after = JSON.parse(await readFile(file, 'utf8')) as { connection: { appId: string }; autoStart: boolean }
    assert.equal(after.connection.appId, 'cli_app', 'concurrent write must not discard the connection')
    assert.equal(after.autoStart, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('splitCommand tolerates a missing separator, as typed on a phone', () => {
  assert.deepEqual(splitCommand('/list'), { command: '/list', args: '' })
  assert.deepEqual(splitCommand('/NEW  我的 任务 '), { command: '/new', args: '我的 任务' })
  // The common phone-keyboard case: the space never got typed. A numeric argument
  // is unambiguous, and CJK text is too.
  assert.deepEqual(splitCommand('/switch1'), { command: '/switch', args: '1' })
  assert.deepEqual(splitCommand('/new我的任务'), { command: '/new', args: '我的任务' })
  // A colon works in place of the space.
  assert.deepEqual(splitCommand('/switch:2'), { command: '/switch', args: '2' })
  // A command-looking prefix followed by an ASCII letter is a different word, not a
  // glued argument: otherwise `/news` would silently create a session. A short id
  // that starts with a letter therefore needs its separator.
  assert.deepEqual(splitCommand('/news'), { command: '/news', args: '' })
  assert.deepEqual(splitCommand('/switchabc123'), { command: '/switchabc123', args: '' })
  assert.deepEqual(splitCommand('/switch abc123'), { command: '/switch', args: 'abc123' })
})

test('a missing separator still switches the session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const first = await router.route({ ...conversation, text: 'one' })
  await router.route({ ...conversation, text: '/new 第二个' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return

  /*
   * The position is read from the list rather than assumed to be 1.
   *
   * Both sessions used to be stamped in the same millisecond, so which one sorted first was a tie
   * the sort happened to break — and the test only ever passed because the tie broke the way it
   * needed. With the timestamps spaced, the newer session sorts first and the older one is second.
   */
  const listed = await router.route({ ...conversation, text: '/list' })
  if (listed.kind !== 'reply') return
  const position = listed.text
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .findIndex((line) => line.includes(shortId(first.decision.sessionId)))
  assert.ok(position >= 0, `the first session is missing from the list: ${listed.text}`)

  // Switch by list position with no space, the way it gets typed on a phone.
  const switched = await router.route({ ...conversation, text: `/switch${String(position + 1)}` })
  assert.equal(switched.kind, 'reply')
  if (switched.kind === 'reply') assert.match(switched.text, /已切换/)

  const current = await router.route({ ...conversation, text: '/current' })
  if (current.kind !== 'reply') return
  assert.match(current.text, new RegExp(shortId(first.decision.sessionId)))
})

test('resolveTarget accepts an index, a full id, the short id, and a title', () => {
  // Realistically shaped ids, minted the same way the router mints them.
  const first = mintSessionId(() => 'aaaa1111-2222-3333-4444-555566667777')
  const second = mintSessionId(() => 'bbbb1111-2222-3333-4444-555566667777')
  const sessions = [
    { sessionId: first, title: '甲', updatedAt: 2 },
    { sessionId: second, title: '乙', updatedAt: 1 },
  ]
  assert.equal(resolveTarget('1', sessions)?.title, '甲')
  assert.equal(resolveTarget('2', sessions)?.title, '乙')
  assert.equal(resolveTarget(second, sessions)?.title, '乙')
  // The short id `/list` prints is exactly what `/switch` accepts.
  assert.equal(resolveTarget(shortId(second), sessions)?.title, '乙')
  assert.equal(resolveTarget('甲', sessions)?.title, '甲')
  assert.equal(resolveTarget('', sessions), undefined)
  assert.equal(resolveTarget('9', sessions), undefined)
  // A suffix shared by several sessions is ambiguous and must not guess.
  assert.equal(resolveTarget('4444-555566667777', sessions), undefined)
  assert.equal(resolveTarget('session-', sessions), undefined)
})

test('a number answers from the shown list while a name may reach any workspace', () => {
  /*
   * The two pools are not the same, and conflating them is what made a listed conversation
   * unselectable: a session from another workspace shows up in `/list all`, but a number refers to a
   * row of that listing while a title has to be findable wherever it lives.
   */
  const mine = [
    { sessionId: 'session-aaaa1111-aaaa1111-x', title: '我的', updatedAt: 2 },
  ]
  const foreign = { sessionId: 'session-bbbb2222-bbbb2222-x', title: '别处的', updatedAt: 1 }
  const every = [mine[0]!, foreign]

  // A number counts the rows the user saw, so with only one own session, 2 is not a shown row.
  assert.equal(resolveTarget('1', every, mine)?.title, '我的')
  assert.equal(resolveTarget('2', every, mine), undefined)
  // With everything shown, 2 is the foreign session.
  assert.equal(resolveTarget('2', every, every)?.title, '别处的')
  // A name is searched across everything, however few rows were displayed.
  assert.equal(resolveTarget('别处的', every, mine)?.title, '别处的')
  // A short id likewise, which is the form `/list` prints beside each row.
  assert.equal(resolveTarget('bbbb2222', every, mine)?.title, '别处的')
  // Omitting the third argument keeps the old behaviour: one pool for both.
  assert.equal(resolveTarget('2', every)?.title, '别处的')
})

test('a title is matched loosely, but never ambiguously', () => {
  /*
   * Real request that failed: 「切换回北京今天天气如何**会话**」 against a session titled
   * 「北京今天天气如何」. Exact matching alone loses to two characters the user added from habit.
   */
  const sessions = [
    { sessionId: 'session-1111aaaa-1111aaaa-x', title: '北京今天天气如何', updatedAt: 3 },
    { sessionId: 'session-2222bbbb-2222bbbb-x', title: '解题辅导会话', updatedAt: 2 },
    { sessionId: 'session-3333cccc-3333cccc-x', title: '写周报', updatedAt: 1 },
  ]

  // The user's own wording, with a word appended.
  assert.equal(resolveTarget('北京今天天气如何会话', sessions)?.title, '北京今天天气如何')
  // A fragment they remember.
  assert.equal(resolveTarget('北京', sessions)?.title, '北京今天天气如何')
  assert.equal(resolveTarget('周报', sessions)?.title, '写周报')
  // Exact still wins.
  assert.equal(resolveTarget('写周报', sessions)?.title, '写周报')

  /*
   * Ambiguity must fail rather than pick one. Both titles here contain 「会话」, so asking for it
   * cannot say which was meant — and a wrong guess moves the conversation somewhere the user did not
   * ask for, which is worse than the failure.
   */
  const ambiguous = [
    { sessionId: 'session-5555eeee-5555eeee-x', title: '解题辅导会话', updatedAt: 2 },
    { sessionId: 'session-6666ffff-6666ffff-x', title: '写周报会话', updatedAt: 1 },
  ]
  assert.equal(resolveTarget('会话', ambiguous), undefined)
  // Nothing matches, so nothing moves.
  assert.equal(resolveTarget('不存在的会话', sessions), undefined)
  // An untitled session must not be selected by every argument that contains nothing — a title of ''
  // is a substring of everything.
  assert.equal(
    resolveTarget('随便什么', [{ sessionId: 'session-4444dddd-4444dddd-x', title: '', updatedAt: 0 }]),
    undefined,
  )
})

test('shortId stays readable and round-trips through resolveTarget', () => {
  const id = mintSessionId(() => '1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(id, 'session-1a2b3c4d-1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(shortId(id), '1a2b3c4d')
  const sessions = [{ sessionId: id, title: 'x', updatedAt: 0 }]
  assert.equal(resolveTarget(shortId(id), sessions)?.sessionId, id)
  // A foreign id still yields something printable rather than throwing.
  assert.equal(shortId('not-a-session-id'), 'not-a-se')
})

