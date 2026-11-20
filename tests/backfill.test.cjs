'use strict'
// Tests for scripts/backfill.cjs, run with: node --test tests/
// Each test writes a small transcript into a temporary Claude folder and
// reads the script's output.

const { test } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill.cjs')
const ID = '0123abcd-0000-0000-0000-000000000000'

function run(rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-'))
  try {
    const dir = path.join(home, 'projects', 'some-project')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${ID}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    const out = execFileSync(process.execPath, [SCRIPT, ID], { env: { ...process.env, CLAUDE_CONFIG_DIR: home } })
    return JSON.parse(String(out))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const at = s => `2026-11-14T10:${s}Z`
const prompt = (uuid, time) => ({ type: 'user', uuid, timestamp: at(time), message: { content: 'hi' } })
const text = (uuid, id, time) => ({
  type: 'assistant',
  uuid,
  timestamp: at(time),
  message: { id, content: [{ type: 'text', text: 'ok' }] },
})
const tool = (uuid, id, time) => ({
  type: 'assistant',
  uuid,
  timestamp: at(time),
  message: { id, content: [{ type: 'tool_use' }] },
})
const toolResult = (uuid, time) => ({
  type: 'user',
  uuid,
  timestamp: at(time),
  message: { content: [{ type: 'tool_result' }] },
})

test('each turn ends on its last text, timed from its prompt', () => {
  const out = run([
    prompt('p1', '00:00'),
    text('a1', 'msg_1', '00:10'),
    prompt('p2', '01:00'),
    text('a2', 'msg_2', '01:05'),
    tool('a3', 'msg_3', '01:06'),
    toolResult('r1', '01:30'),
    text('a4', 'msg_4', '02:14'),
  ])
  assert.deepStrictEqual(out.finals, ['msg_1', 'msg_4'])
  assert.deepStrictEqual(out.durations, { msg_1: 10_000, msg_4: 74_000 })
})

test('the end is the last text row, even when one message has several', () => {
  const out = run([prompt('p1', '00:00'), text('a1', 'msg_1', '00:10'), text('a2', 'msg_1', '00:40')])
  assert.deepStrictEqual(out.durations, { msg_1: 40_000 })
})

test('a message sent while Claude works does not restart the turn', () => {
  const out = run([
    prompt('p1', '00:00'),
    tool('a1', 'msg_1', '00:05'),
    { type: 'attachment', uuid: 'q1', timestamp: at('00:30'), attachment: { type: 'queued_command', prompt: 'also this' } },
    toolResult('r1', '00:40'),
    text('a2', 'msg_2', '01:00'),
  ])
  assert.deepStrictEqual(out.durations, { msg_2: 60_000 })
})

test('a turn with no text yet has no duration', () => {
  const out = run([prompt('p1', '00:00'), tool('a1', 'msg_1', '00:05')])
  assert.deepStrictEqual(out.finals, [])
  assert.deepStrictEqual(out.durations, {})
})
