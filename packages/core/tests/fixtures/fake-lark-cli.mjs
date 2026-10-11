#!/usr/bin/env node
/**
 * A stand-in for `lark-cli`, for tests.
 *
 * Behaviour is chosen by environment variables so one script covers every case:
 *
 *   FAKE_LARK_LOG      file to append one JSON line per invocation (argv, cwd)
 *   FAKE_LARK_EVENTS   file of NDJSON events that `event consume` prints after its ready marker
 *   FAKE_LARK_EXIT     exit code for `event consume` once its events are printed (default: stay
 *                      alive until stdin closes, like the real one)
 *   FAKE_LARK_FAIL     substring; any one-shot command whose argv contains it fails with an envelope
 *
 * One-shot commands print the `{ ok, data }` envelope lark-cli prints.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const log = process.env.FAKE_LARK_LOG
if (log) appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd() })}\n`)

// Drop a leading `--profile <name>`.
const rest = args[0] === '--profile' ? args.slice(2) : args
const has = (flag) => rest.includes(flag)
const value = (flag) => rest[rest.indexOf(flag) + 1]

function ok(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, identity: 'bot', data }, null, 2)}\n`)
  process.exit(0)
}

function fail(type, message, code = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, identity: 'bot', error: { type, message, hint: 'fake hint' } }, null, 2)}\n`)
  process.exit(code)
}

if (rest[0] === 'event' && rest[1] === 'consume') {
  process.stderr.write(`[event] consuming as cli_fake (cli_fake)\n`)
  if (process.env.FAKE_LARK_EXIT === '3') fail('auth', 'missing scope im:message.p2p_msg:readonly', 3)
  process.stderr.write(`[event] ready event_key=${rest[2]}\n`)
  const file = process.env.FAKE_LARK_EVENTS
  if (file && existsSync(file)) process.stdout.write(readFileSync(file, 'utf8'))
  if (process.env.FAKE_LARK_EXIT !== undefined) process.exit(Number(process.env.FAKE_LARK_EXIT))
  // Like the real one: stdin EOF is the graceful shutdown.
  process.stdin.resume()
  process.stdin.on('end', () => {
    process.stderr.write('[event] exited — received 0 event(s) in 1s (reason: signal)\n')
    process.exit(0)
  })
} else {
  const failOn = process.env.FAKE_LARK_FAIL
  if (failOn && rest.some((arg) => arg.includes(failOn))) fail('api', `fake failure on ${failOn}`)

  if (rest[0] === 'auth' && rest[1] === 'status') {
    process.stdout.write(
      `${JSON.stringify({ appId: 'cli_fake', brand: 'feishu', identities: { bot: { status: 'ready', available: true, message: 'Bot identity: ready' } } }, null, 2)}\n`,
    )
    process.exit(0)
  }
  if (rest[0] === 'im' && rest[1] === '+messages-send') {
    for (const flag of ['--file', '--image']) {
      if (has(flag)) {
        const path = value(flag)
        if (path.startsWith('/') || path.includes('..')) fail('validation', `${flag} must be a relative path`, 2)
        if (!existsSync(join(process.cwd(), path))) fail('validation', `file not found: ${path}`, 2)
      }
    }
    ok({ message_id: `om_sent_${Date.now()}`, chat_id: value('--chat-id') })
  }
  if (rest[0] === 'im' && rest[1] === '+messages-resources-download') {
    const key = value('--file-key')
    const name = key.startsWith('img_') ? `${key}.png` : `报告.pdf`
    writeFileSync(join(process.cwd(), name), `bytes-of-${key}`)
    ok({ saved_path: name })
  }
  if (rest[0] === 'im' && rest[1] === 'reactions' && rest[2] === 'create') ok({ reaction_id: 'r_1' })
  if (rest[0] === 'im' && rest[1] === 'reactions' && rest[2] === 'delete') ok({})
  if (rest[0] === 'im' && rest[1] === '+messages-mget') {
    ok({ messages: [{ message_id: value('--message-ids'), msg_type: 'text', content: '被引用的原话', sender: { sender_type: 'app' } }] })
  }
  fail('validation', `fake lark-cli: unknown command ${rest.join(' ')}`, 2)
}
