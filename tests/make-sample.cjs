#!/usr/bin/env node
// Copies the start of a real Claude Code session into tests/sample-history.ts
// with everything personal taken out, for history.test.ts to read.
//
//   node tests/make-sample.cjs <session.jsonl> [number of prompts, default 2]
//
// Sessions are in ~/.claude/projects/<project folder>/. After a Claude Code
// update, make a new sample from a session started with it and run the tests:
// if Claude Code changed how it saves what the mod reads, they will say so.
// Pick a session where Claude ran tools and thought, or the tests can't check
// those; the script warns when the sample has none.
//
// What's kept: the order and kind of every row, its time and ids, and the
// numbers (tokens, thinking time). Every other text is replaced, and so is
// everything inside tool calls and their results. Rows that aren't messages
// keep only their kind and time.
'use strict'

const fs = require('fs')
const path = require('path')

const [file, promptsArg = '2'] = process.argv.slice(2)
const wanted = Number(promptsArg)
if (!file || !Number.isInteger(wanted) || wanted < 1) {
  console.error('usage: node tests/make-sample.cjs <session.jsonl> [prompts, a whole number from 1]')
  process.exit(1)
}

// Text kept on a row, in its message and in the message's blocks: what kind
// of thing it is, ids and times. Anything deeper is replaced whole.
const KEEP = new Set(['type', 'subtype', 'role', 'uuid', 'parentUuid', 'timestamp', 'id', 'tool_use_id', 'model', 'version', 'stop_reason'])
const MESSAGES = new Set(['user', 'assistant', 'system'])

// Strings become 'redacted'; objects keep their keys only where `keysSafe`,
// since elsewhere a key can be data (a file path, a setting's name).
function redact(value, keysSafe) {
  if (typeof value === 'string') return 'redacted'
  if (Array.isArray(value)) return value.map(v => redact(v, keysSafe))
  if (value && typeof value === 'object') {
    if (!keysSafe) return 'redacted'
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k === 'usage' || k === 'cache_creation')
    return out
  }
  return value
}

// One level of a row, message or block: kept text where it's named in KEEP.
const level = (obj, inner = {}) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, k in inner ? inner[k](v) : typeof v === 'string' && KEEP.has(k) ? v : redact(v, k === 'usage')]),
  )

const block = b =>
  b && typeof b === 'object'
    ? level(b, { input: () => 'redacted', content: () => 'redacted' })
    : redact(b, false)
const message = m =>
  m && typeof m === 'object'
    ? level(m, { content: c => (Array.isArray(c) ? c.map(block) : redact(c, false)) })
    : redact(m, false)
const clean = row => level(row, { message, toolUseResult: () => 'redacted' })

// A prompt you typed, as the mod counts one.
const isPrompt = row =>
  row.type === 'user' &&
  !row.isMeta &&
  !row.isCompactSummary &&
  (typeof row.message?.content === 'string' ||
    (Array.isArray(row.message?.content) &&
      row.message.content.some(b => b?.type === 'text') &&
      !row.message.content.some(b => b?.type === 'tool_result')))

const out = []
let prompts = 0
let reshaped = 0
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let row
  try {
    row = JSON.parse(line)
  } catch {
    continue // the last line of a session still in use can be half written
  }
  if (isPrompt(row) && ++prompts > wanted) break
  // The mod finds rows by looking for text like "type":"user" in each line,
  // so the sample must be written the way Claude Code writes them.
  if (JSON.stringify(row) !== line) reshaped++
  if (MESSAGES.has(row.type)) out.push(clean(row))
  else out.push({ type: row.type, subtype: row.subtype, uuid: row.uuid, timestamp: row.timestamp })
}

const has = test => out.some(r => Array.isArray(r.message?.content) && r.message.content.some(test))
if (reshaped > 0) console.warn(`warning: ${reshaped} lines are not written the way they used to be; the mod may not find them`)
if (!has(b => b?.type === 'tool_result')) console.warn('warning: no tool call in the sample; pick another session or more prompts')
if (!out.some(r => typeof r.thinkingDurationMs === 'number')) console.warn('warning: no thinking time in the sample; pick another session')

// Saved as code, since tests can only import code files: one string holding
// the rows as Claude Code writes them, one JSON object per line.
const target = path.join(__dirname, 'sample-history.ts')
const text = out.map(r => JSON.stringify(r)).join('\n') + '\n'
fs.writeFileSync(target, `// Made by make-sample.cjs from a real session, its text taken out.\nexport default ${JSON.stringify(text)}\n`)
console.log(`${out.length} rows, ${Math.min(prompts, wanted)} prompts -> ${target}`)
