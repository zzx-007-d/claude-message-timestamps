import { expect, test } from 'claude-code/testing'

import { firstNewline, HistoryReader, HistoryTail, readWindow, utf8Length } from '../hooks/transcript'
import sample from './sample-history'

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

// A real session, saved by Claude Code and stripped of its text by
// make-sample.cjs. The rows above are written by hand; this checks the mod
// still understands what Claude Code actually writes. After a Claude Code
// update, make a new sample (see make-sample.cjs) and run the tests again.
// What the mod should find is worked out here straight from the rows, a
// simpler way than the reader's, so the checks hold for any new sample too.
// The reader gets the file's text as is, the way the mod reads it.
function readSample() {
  const reader = new HistoryReader()
  reader.feed(sample)
  return reader.times()
}

type SampleRow = {
  type: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  thinkingDurationMs?: number
  message?: { id?: string; content?: unknown; usage?: { output_tokens?: number } }
}
type SampleBlock = { type?: string; id?: string; tool_use_id?: string }

const sampleRows = sample
  .trim()
  .split('\n')
  .map(l => JSON.parse(l) as SampleRow)
const blocksOf = (r: SampleRow) => (Array.isArray(r.message?.content) ? (r.message.content as SampleBlock[]) : [])
const isTypedPrompt = (r: SampleRow) =>
  r.type === 'user' &&
  !r.isMeta &&
  !r.isCompactSummary &&
  (typeof r.message?.content === 'string' ||
    (blocksOf(r).some(b => b.type === 'text') && !blocksOf(r).some(b => b.type === 'tool_result')))

test('a real saved session: every prompt and answer gets its time', () => {
  const out = readSample()
  const prompts = sampleRows.filter(isTypedPrompt)
  const answers = sampleRows.filter(r => r.type === 'assistant' && blocksOf(r).some(b => b.type === 'text'))
  expect(prompts.length).toBeGreaterThan(0)
  expect(answers.length).toBeGreaterThan(0)
  for (const r of [...prompts, ...answers]) expect(out.rows[r.uuid!]).toBe(shiftLocal(Date.parse(r.timestamp!)))
  // Each answer is also found by its message id, with the time of its first row.
  for (const r of answers) {
    const first = answers.find(a => a.message!.id === r.message!.id)!
    expect(out.rows[r.message!.id!]).toBe(shiftLocal(Date.parse(first.timestamp!)))
  }
})

test('a real saved session: each turn ends on its last answer, with how long it took, thought and wrote', () => {
  const out = readSample()
  // Each prompt's turn runs to the next prompt; its last text answer ends it.
  // Every row of one API message repeats its tokens, so they count once per id.
  type Turn = { start: number; last?: string; end?: number; thought: number; tokens: Map<string, number> }
  const turns: Turn[] = []
  for (const r of sampleRows) {
    const when = Date.parse(r.timestamp!)
    if (isTypedPrompt(r)) turns.push({ start: when, thought: 0, tokens: new Map() })
    const turn = turns.at(-1)
    if (!turn || r.type !== 'assistant') continue
    turn.thought += r.thinkingDurationMs ?? 0
    const written = r.message?.usage?.output_tokens
    if (r.message?.id && written !== undefined) turn.tokens.set(r.message.id, written)
    if (blocksOf(r).some(b => b.type === 'text')) {
      turn.last = r.message!.id
      turn.end = when
    }
  }
  const answered = turns.filter(t => t.last)
  expect(answered.length).toBeGreaterThan(0)
  expect(out.finals).toEqual(answered.map(t => t.last))
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
  expect(out.durations).toEqual(Object.fromEntries(answered.map(t => [t.last, t.end! - t.start])))
  // A turn that wrote no tokens or didn't think gets no figure.
  const figures = (of: (t: Turn) => number) =>
    Object.fromEntries(answered.filter(t => of(t) > 0).map(t => [t.last, of(t)]))
  expect(out.tokens).toEqual(figures(t => sum(t.tokens)))
  // make-sample.cjs warns when no turn thought: then a lost thinking time can't show.
  expect(answered.some(t => t.thought > 0)).toBe(true)
  expect(out.thinking).toEqual(figures(t => t.thought))
})

test('a real saved session: every finished tool call gets how long it took', () => {
  const out = readSample()
  const started = new Map<string, number>()
  const took: Record<string, number> = {}
  for (const r of sampleRows) {
    for (const b of blocksOf(r)) {
      if (r.type === 'assistant' && b.type === 'tool_use' && b.id) started.set(b.id, Date.parse(r.timestamp!))
      if (r.type === 'user' && b.type === 'tool_result' && b.tool_use_id && started.has(b.tool_use_id)) {
        const ms = Date.parse(r.timestamp!) - started.get(b.tool_use_id)!
        if (ms >= 0) took[b.tool_use_id] = ms
      }
    }
  }
  // make-sample.cjs warns when the sample has no tool call.
  expect(Object.keys(took).length).toBeGreaterThan(0)
  expect(out.tools).toEqual(took)
})

test('a real saved session: the cache countdown is found', () => {
  const cache = readSample().cache
  expect(cache).not.toBeNull()
  expect([5 * 60_000, 60 * 60_000]).toContain(cache!.ttlMs)
})

// The wall-clock time the mod stores, as in transcript.ts.
function shiftLocal(ms: number) {
  return ms - new Date(ms).getTimezoneOffset() * 60_000
}
