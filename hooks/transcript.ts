// Reads the conversation history Claude Code saves (one JSON row per line) and
// works out the times the mod shows for messages it didn't see live: the send
// time of every prompt, answer and slash command output, each turn's last
// answer and how long and how hard it worked, each tool call's length, and
// when the prompt cache was last renewed.
//
// It's fed the file a piece at a time, only the lines added since the last
// read, and keeps what it needs to carry on from there.

import type { Stamps } from '../types'

export type HistoryTimes = {
  // Row uuid and API message id -> send time, local-shifted (see register.tsx).
  rows: Stamps
  // The API message id of each turn's last text answer, oldest first.
  finals: string[]
  // Those ids -> how long the turn took (prompt to last text), how long it
  // thought and how many tokens it wrote, tool calls included.
  durations: Stamps
  thinking: Stamps
  tokens: Stamps
  // Tool call id -> how long the call took, from its request to its result.
  tools: Stamps
  // The prompt cache as the last request left it: when that request was sent
  // (real ms since the epoch) and how long the cache holds it.
  cache: { at: number; ttlMs: number } | null
}

const FIVE_MINUTES = 5 * 60_000
const ONE_HOUR = 60 * 60_000

// A time as the wall clock read it then, so the UTC getters give local time.
const shift = (ms: number) => ms - new Date(ms).getTimezoneOffset() * 60_000

type Block = { type?: string; id?: string; tool_use_id?: string } | null
type Usage = {
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}
type Row = {
  type?: string
  subtype?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isSidechain?: boolean
  thinkingDurationMs?: number
  message?: { id?: string; content?: unknown; usage?: Usage }
}

const hasText = (blocks: Block[]) => blocks.some(b => b?.type === 'text')

// Rows the transcript draws as a prompt, an answer's text or a command's output.
function isShown(row: Row): boolean {
  const content = row.message?.content
  if (row.type === 'user') {
    // A compacted chat's summary is a hidden row, often stamped earlier than
    // the prompt before it: not a message you sent.
    if (row.isMeta || row.isCompactSummary) return false
    if (typeof content === 'string') return true
    return Array.isArray(content) && hasText(content) && !content.some((b: Block) => b?.type === 'tool_result')
  }
  if (row.type === 'assistant') return Array.isArray(content) && hasText(content)
  // A slash command's printed output (/reload-plugins, /cost, ...).
  return row.type === 'system' && row.subtype === 'local_command'
}

export class HistoryReader {
  private rows: Stamps = {}
  private finals: string[] = []
  private durations: Stamps = {}
  private thinking: Stamps = {}
  private tokens: Stamps = {}
  private tools: Stamps = {}
  private cache: HistoryTimes['cache'] = null
  // The turn still open: its prompt, its latest answer so far, and what it
  // has written and thought. Every row of one API message repeats that
  // message's usage, so tokens are kept per message and added up at the end.
  private promptTime: number | null = null
  private lastReply: string | null = null
  private lastTextTime: number | null = null
  private turnTokens = new Map<string, number>()
  private turnThinking = 0
  // Tool calls waiting for their result: id -> when the request was saved.
  private toolStarts = new Map<string, number>()
  // A request goes out right after the row before its answer (a prompt or a
  // tool result); each answer's first row says how it used the cache.
  private sentAt: number | null = null
  private cachedMsg: string | null = null
  // Reading only the end of the file, the first rows belong to a turn whose
  // start is missing: nothing is taken in until a prompt opens a whole turn.
  private isStarted: boolean

  constructor({ isWindow = false }: { isWindow?: boolean } = {}) {
    this.isStarted = !isWindow
  }

  // Reads whole lines, each ending in a newline.
  feed(text: string): void {
    for (const line of text.split('\n')) this.line(line)
  }

  // What's been read so far, the open turn counted as if it ended now.
  times(): HistoryTimes {
    const times: HistoryTimes = {
      rows: { ...this.rows },
      finals: [...this.finals],
      durations: { ...this.durations },
      thinking: { ...this.thinking },
      tokens: { ...this.tokens },
      tools: { ...this.tools },
      cache: this.cache,
    }
    this.closeTurn(times)
    return times
  }

  private line(line: string): void {
    // Most rows are neither messages nor command output: skip them unparsed.
    if (!line.includes('"timestamp"')) return
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"subtype":"local_command"')) return
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      return
    }
    if (!this.isStarted) {
      if (row.type !== 'user' || !isShown(row)) return
      this.isStarted = true
    }
    const when = Date.parse(row.timestamp ?? '')
    const message = row.message
    const usage = row.type === 'assistant' ? message?.usage : undefined
    if (row.type === 'assistant' && message) {
      if (message.id && typeof usage?.output_tokens === 'number') this.turnTokens.set(message.id, usage.output_tokens)
      if (typeof row.thinkingDurationMs === 'number') this.turnThinking += row.thinkingDurationMs
    }
    if (!row.isSidechain) this.noteCache(row, when, usage)
    const blocks: Block[] = Array.isArray(message?.content) ? (message.content as Block[]) : []
    for (const b of blocks) {
      if (row.type === 'assistant' && b?.type === 'tool_use' && b.id) this.toolStarts.set(b.id, when)
      if (row.type === 'user' && b?.type === 'tool_result' && b.tool_use_id !== undefined) {
        const start = this.toolStarts.get(b.tool_use_id)
        if (start !== undefined && when - start >= 0) this.tools[b.tool_use_id] = when - start
      }
    }
    if (!isShown(row) || Number.isNaN(when)) return
    const local = shift(when)
    if (row.uuid) this.rows[row.uuid] = local
    const msgId = message?.id
    if (msgId && !(msgId in this.rows)) this.rows[msgId] = local
    if (row.type === 'user') {
      this.closeTurn({ finals: this.finals, durations: this.durations, thinking: this.thinking, tokens: this.tokens })
      this.lastReply = null
      this.lastTextTime = null
      this.turnTokens = new Map()
      this.turnThinking = 0
      this.promptTime = local
    } else if (row.type === 'assistant' && msgId) {
      this.lastReply = msgId
      this.lastTextTime = local
    }
  }

  // Each answer's usage says how much it wrote to the cache and for how long:
  // the shorter when both. One that only read it keeps the lifetime written
  // before; a write that named no lifetime is priced as five minutes.
  private noteCache(row: Row, when: number, usage: Usage | undefined): void {
    if (row.type === 'user') this.sentAt = when
    const id = row.message?.id
    if (!usage || !id || id === this.cachedMsg) return
    this.cachedMsg = id
    const life = usage.cache_creation ?? {}
    const written =
      (life.ephemeral_5m_input_tokens ?? 0) > 0 ? FIVE_MINUTES : (life.ephemeral_1h_input_tokens ?? 0) > 0 ? ONE_HOUR : null
    const wrote = (usage.cache_creation_input_tokens ?? 0) > 0
    if (written === null && !wrote && !((usage.cache_read_input_tokens ?? 0) > 0)) return
    const ttlMs = written ?? (wrote || this.cache === null ? FIVE_MINUTES : this.cache.ttlMs)
    this.cache = { at: this.sentAt ?? when, ttlMs }
  }

  // Records the open turn's last answer, and what the turn took, into `into`.
  private closeTurn(into: Pick<HistoryTimes, 'finals' | 'durations' | 'thinking' | 'tokens'>): void {
    const reply = this.lastReply
    if (reply === null) return
    into.finals.push(reply)
    if (this.promptTime !== null && this.lastTextTime !== null) into.durations[reply] = this.lastTextTime - this.promptTime
    if (this.turnThinking > 0) into.thinking[reply] = this.turnThinking
    let written = 0
    for (const n of this.turnTokens.values()) written += n
    if (written > 0) into.tokens[reply] = written
  }
}

// How to read a range of the history file: as text (a character cut at the
// range's end comes back as U+FFFD), or as base64-encoded bytes.
export type HistoryFile = {
  read: (offset: number, length: number) => Promise<string>
  readBytes: (offset: number, length: number) => Promise<string>
}

// The most one read returns.
export const PIECE = 4 * 1024 * 1024

// One history file, read as it grows: each read takes only the lines added
// since the one before. A line still being written waits for the next read.
export class HistoryTail {
  readonly path: string
  offset = 0
  readonly reader = new HistoryReader()
  private readonly piece: number

  constructor(path: string, piece = PIECE) {
    this.path = path
    this.piece = piece
  }

  async readTo(size: number, file: HistoryFile): Promise<void> {
    while (this.offset < size) {
      const length = Math.min(this.piece, size - this.offset)
      const text = await file.read(this.offset, length)
      const end = text.lastIndexOf('\n')
      if (end >= 0) {
        // Up to the last newline the text is whole: a cut character can only
        // be past it.
        const lines = text.slice(0, end + 1)
        this.reader.feed(lines)
        this.offset += utf8Length(lines)
      } else {
        // One line longer than a whole piece (a huge tool result) is skipped;
        // like any line, one still being written waits for the next read.
        const next = length === this.piece ? await this.endOfLine(this.offset + length, size, file) : -1
        if (next < 0) return
        this.offset = next
      }
    }
  }

  // Just past the newline that ends the line running through `offset`, or -1
  // when that line hasn't ended yet.
  private async endOfLine(offset: number, size: number, file: HistoryFile): Promise<number> {
    for (let at = offset; at < size; at += this.piece) {
      const newline = firstNewline(await file.readBytes(at, Math.min(this.piece, size - at)))
      if (newline >= 0) return at + newline + 1
    }
    return -1
  }
}

// The times found in the end of the file only, from `start` on: what a long
// history shows first, before it has been read whole. The line cut by `start`
// is left out, and so is the turn it belongs to.
export async function readWindow(start: number, size: number, file: HistoryFile): Promise<HistoryTimes> {
  const text = await file.read(start, size - start)
  const first = start === 0 ? -1 : text.indexOf('\n')
  const last = text.lastIndexOf('\n')
  const reader = new HistoryReader({ isWindow: start > 0 })
  if (last > first) reader.feed(text.slice(first + 1, last + 1))
  return reader.times()
}

// How many bytes `text` takes in UTF-8.
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Where the first newline byte is in base64-encoded bytes, or -1.
export function firstNewline(base64: string): number {
  let bits = 0
  let count = 0
  let index = 0
  for (const ch of base64) {
    const value = BASE64.indexOf(ch)
    if (value < 0) continue
    bits = ((bits << 6) | value) & 0xffff
    count += 6
    if (count >= 8) {
      count -= 8
      if (((bits >> count) & 0xff) === 10) return index
      index++
    }
  }
  return -1
}
