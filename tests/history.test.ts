import { expect, test } from 'claude-code/testing'

import { firstNewline, HistoryReader, HistoryTail, readWindow, utf8Length } from '../hooks/transcript'

// Rows as Claude Code saves them, one JSON object per line.
const at = (s: string) => `2026-11-14T10:${s}Z`
const prompt = (uuid: string, time: string) => ({ type: 'user', uuid, timestamp: at(time), message: { content: 'hi' } })
const text = (uuid: string, id: string, time: string) => ({
  type: 'assistant',
  uuid,
  timestamp: at(time),
  message: { id, content: [{ type: 'text', text: 'ok' }] },
})
const tool = (uuid: string, id: string, time: string) => ({
  type: 'assistant',
  uuid,
  timestamp: at(time),
  message: { id, content: [{ type: 'tool_use' }] },
})
const toolResult = (uuid: string, time: string) => ({
  type: 'user',
  uuid,
  timestamp: at(time),
  message: { content: [{ type: 'tool_result' }] },
})

const lines = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

function read(rows: object[]) {
  const reader = new HistoryReader()
  reader.feed(lines(rows))
  return reader.times()
}

test('each turn ends on its last text, timed from its prompt', () => {
  const out = read([
    prompt('p1', '00:00'),
    text('a1', 'msg_1', '00:10'),
    prompt('p2', '01:00'),
    text('a2', 'msg_2', '01:05'),
    tool('a3', 'msg_3', '01:06'),
    toolResult('r1', '01:30'),
    text('a4', 'msg_4', '02:14'),
  ])
  expect(out.finals).toEqual(['msg_1', 'msg_4'])
  expect(out.durations).toEqual({ msg_1: 10_000, msg_4: 74_000 })
})

test('the end is the last text row, even when one message has several', () => {
  const out = read([prompt('p1', '00:00'), text('a1', 'msg_1', '00:10'), text('a2', 'msg_1', '00:40')])
  expect(out.durations).toEqual({ msg_1: 40_000 })
})

test('a message sent while Claude works does not restart the turn', () => {
  const out = read([
    prompt('p1', '00:00'),
    tool('a1', 'msg_1', '00:05'),
    { type: 'attachment', uuid: 'q1', timestamp: at('00:30'), attachment: { type: 'queued_command', prompt: 'also this' } },
    toolResult('r1', '00:40'),
    text('a2', 'msg_2', '01:00'),
  ])
  expect(out.durations).toEqual({ msg_2: 60_000 })
})

test('a turn with no text yet has no duration', () => {
  const out = read([prompt('p1', '00:00'), tool('a1', 'msg_1', '00:05')])
  expect(out.finals).toEqual([])
  expect(out.durations).toEqual({})
})

// When a chat is compacted, Claude Code saves a summary as a hidden user row,
// often stamped with an earlier time than the prompt before it. It isn't a
// message you sent: counting it made a pause look shorter and the next answer
// look slower.
test('the summary saved when a chat is compacted is not a message', () => {
  const out = read([
    prompt('p1', '00:00'),
    text('a1', 'msg_1', '00:10'),
    prompt('p2', '40:00'),
    {
      type: 'user',
      uuid: 'sum1',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      timestamp: at('20:00'),
      message: { content: 'This session is being continued' },
    },
    text('a2', 'msg_2', '41:00'),
  ])
  expect(out.rows.sum1).toBeUndefined()
  expect(out.durations).toEqual({ msg_1: 10_000, msg_2: 60_000 })
})

// Every row of one API message carries that message's full usage, and only
// its thinking row carries how long it thought.
const worked = (row: ReturnType<typeof tool>, outputTokens: number, thinkingMs?: number) => ({
  ...row,
  ...(thinkingMs === undefined ? {} : { thinkingDurationMs: thinkingMs }),
  message: { ...row.message, usage: { input_tokens: 5, output_tokens: outputTokens } },
})

test('each turn adds up the tokens Claude wrote and how long it thought', () => {
  const out = read([
    prompt('p1', '00:00'),
    worked(tool('a1', 'msg_1', '00:05'), 300, 4_000),
    worked(tool('a2', 'msg_1', '00:06'), 300),
    toolResult('r1', '00:10'),
    worked(text('a3', 'msg_2', '00:20'), 1_200, 6_500),
    prompt('p2', '01:00'),
    worked(text('a4', 'msg_3', '01:05'), 40),
  ])
  expect(out.tokens).toEqual({ msg_2: 1_500, msg_3: 40 })
  expect(out.thinking).toEqual({ msg_2: 10_500 })
})

test('rows without usage, like older transcripts, add nothing', () => {
  const out = read([prompt('p1', '00:00'), text('a1', 'msg_1', '00:10')])
  expect(out.tokens).toEqual({})
  expect(out.thinking).toEqual({})
})

// A tool call is saved twice: Claude's request (a tool_use block with an id)
// and, once it ran, its result (a tool_result block naming that id).
const call = (uuid: string, id: string, toolId: string, time: string) => ({
  type: 'assistant',
  uuid,
  timestamp: at(time),
  message: { id, content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: {} }] },
})
const callResult = (uuid: string, toolId: string, time: string) => ({
  type: 'user',
  uuid,
  timestamp: at(time),
  message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'done' }] },
})

test('each tool call is timed from its request to its result', () => {
  const out = read([
    prompt('p1', '00:00'),
    call('a1', 'msg_1', 'toolu_1', '00:05'),
    callResult('r1', 'toolu_1', '00:47'),
    call('a2', 'msg_2', 'toolu_2', '01:00'),
    callResult('r2', 'toolu_2', '01:02'),
    call('a3', 'msg_3', 'toolu_3', '01:10'),
  ])
  // The last call has no result yet: it's still running.
  expect(out.tools).toEqual({ toolu_1: 42_000, toolu_2: 2_000 })
})

// Each answer's usage says how much of the conversation it wrote to the prompt
// cache, and for how long. The request went out right after the row before it.
const cached = (row: ReturnType<typeof tool>, { read: r = 0, fiveMin = 0, oneHour = 0 }) => ({
  ...row,
  message: {
    ...row.message,
    usage: {
      input_tokens: 2,
      output_tokens: 10,
      cache_read_input_tokens: r,
      cache_creation_input_tokens: fiveMin + oneHour,
      cache_creation: { ephemeral_5m_input_tokens: fiveMin, ephemeral_1h_input_tokens: oneHour },
    },
  },
})

test('the cache is counted from the last request, for as long as it was written', () => {
  const out = read([
    prompt('p1', '00:00'),
    cached(text('a1', 'msg_1', '00:20'), { oneHour: 900 }),
    prompt('p2', '05:00'),
    cached(text('a2', 'msg_2', '05:30'), { read: 900, oneHour: 50 }),
  ])
  expect(out.cache).toEqual({ at: Date.parse(at('05:00')), ttlMs: 60 * 60_000 })
})

test('a request that only read the cache keeps the lifetime written before', () => {
  const out = read([
    prompt('p1', '00:00'),
    cached(tool('a1', 'msg_1', '00:05'), { fiveMin: 900 }),
    toolResult('r1', '00:10'),
    cached(text('a2', 'msg_2', '00:30'), { read: 900 }),
  ])
  expect(out.cache).toEqual({ at: Date.parse(at('00:10')), ttlMs: 5 * 60_000 })
})

test('with no cache use there is no countdown', () => {
  expect(read([prompt('p1', '00:00'), text('a1', 'msg_1', '00:10')]).cache).toBeNull()
})

// Reading the file as it grows. The fake file holds bytes and answers ranges
// the way the mod's file reads do: a character cut at the end comes back as
// U+FFFD.
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? BASE64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? BASE64.charAt(n & 63) : '='
  }
  return out
}
function fakeFile(content: string) {
  const bytes = encoder.encode(content)
  return {
    size: bytes.length,
    read: async (offset: number, length: number) => decoder.decode(bytes.subarray(offset, offset + length)),
    readBytes: async (offset: number, length: number) => toBase64(bytes.subarray(offset, offset + length)),
  }
}

// Long rows with characters of 2, 3 and 4 bytes, so pieces cut through them.
const wide = (row: object, n: number) => ({ ...row, note: 'é€\u{1f600}'.repeat(n) })
const ROWS = [
  wide(prompt('p1', '00:00'), 3),
  wide(text('a1', 'msg_1', '00:10'), 40),
  wide(prompt('p2', '01:00'), 7),
  wide(text('a2', 'msg_2', '01:30'), 11),
]

test('read in small pieces as the file grows, it finds what one read finds', async () => {
  const whole = read(ROWS)
  const file = fakeFile(lines(ROWS))
  // Pieces a little longer than the longest line, the file growing in steps
  // that end mid-line and mid-character.
  const tail = new HistoryTail('history.jsonl', 700)
  for (let size = 50; size < file.size; size += 61) await tail.readTo(size, file)
  await tail.readTo(file.size, file)
  expect(tail.offset).toBe(file.size)
  expect(tail.reader.times()).toEqual(whole)
})

test('a line still being written waits for the next read', async () => {
  const done = lines(ROWS.slice(0, 2))
  const file = fakeFile(done + JSON.stringify(ROWS[2]).slice(0, 30))
  const tail = new HistoryTail('history.jsonl')
  await tail.readTo(file.size, file)
  expect(tail.offset).toBe(utf8Length(done))
  expect(tail.reader.times().rows.p2).toBeUndefined()
})

test('a line longer than a whole piece is skipped, and the lines after it are read', async () => {
  const huge = { ...prompt('p_huge', '00:30'), note: 'x'.repeat(500) }
  const file = fakeFile(lines([prompt('p1', '00:00'), huge, text('a1', 'msg_1', '00:10')]))
  const tail = new HistoryTail('history.jsonl', 200)
  await tail.readTo(file.size, file)
  expect(tail.offset).toBe(file.size)
  expect(Object.keys(tail.reader.times().rows)).toEqual(['p1', 'a1', 'msg_1'])
})

test('a line longer than a whole piece and still being written waits too', async () => {
  const start = lines([prompt('p1', '00:00')])
  const file = fakeFile(start + JSON.stringify({ ...prompt('p_huge', '00:30'), note: '€'.repeat(300) }).slice(0, 400))
  const tail = new HistoryTail('history.jsonl', 200)
  await tail.readTo(file.size, file)
  expect(tail.offset).toBe(utf8Length(start))
})

test('bytes are counted as UTF-8 does', () => {
  for (const s of ['a', 'é', '€', '\u{1f600}', 'aé€\u{1f600}\n']) {
    expect(utf8Length(s)).toBe(encoder.encode(s).length)
  }
})

test('the first newline is found in base64-encoded bytes', () => {
  expect(firstNewline(toBase64(encoder.encode('ab\ncd')))).toBe(2)
  expect(firstNewline(toBase64(encoder.encode('€\u{1f600}\n')))).toBe(7)
  expect(firstNewline(toBase64(encoder.encode('no newline')))).toBe(-1)
})

test('read from a point in its middle, the history leaves out the turn cut there', async () => {
  const rows = [
    prompt('p1', '00:00'),
    worked(tool('a1', 'msg_1', '00:05'), 300, 4_000),
    worked(text('a2', 'msg_2', '00:20'), 1_200, 6_500),
    prompt('p2', '01:00'),
    worked(text('a3', 'msg_3', '01:05'), 40),
  ]
  const all = lines(rows)
  const file = fakeFile(all)
  // Start inside the first answer's row: its turn has no prompt in view.
  const start = utf8Length(lines(rows.slice(0, 2))) - 20
  const out = await readWindow(start, file.size, file)
  expect(out.finals).toEqual(['msg_3'])
  expect(Object.keys(out.rows)).toEqual(['p2', 'a3', 'msg_3'])
  expect(out.tokens).toEqual({ msg_3: 40 })
  expect(out.durations).toEqual({ msg_3: 5_000 })
})

test('read from the start, the window is the whole history', async () => {
  const file = fakeFile(lines(ROWS))
  expect(await readWindow(0, file.size, file)).toEqual(read(ROWS))
})
