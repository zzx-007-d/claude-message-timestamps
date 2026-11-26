import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Stamps } from '../types'
import { HistoryReader, HistoryTail, readWindow } from './transcript'
import type { HistoryTimes } from './transcript'

// Times are kept "local-shifted": UTC ms minus the zone offset, so the UTC
// getters below read local wall-clock time without needing the zone here.
const stamps = atom({ plugin: 'message-timestamps', key: 'stamps' } as const, {} as Stamps, {
  // 2: times read before compacted chats' summaries were left out may hold a
  // summary's misleading time, and a reread only adds; drop them to reread.
  shape: 'stamps-2',
})
const finals = atom({ plugin: 'message-timestamps', key: 'finals' } as const, [] as string[], {
  shape: 'finals-1',
})
const tzOffset = atom({ plugin: 'message-timestamps', key: 'tzOffset' } as const, null as number | null)
// When Claude last wrote reply text, recorded live as it's stored: the time of
// the newest reply before the transcript file has caught up.
const latestAt = atom({ plugin: 'message-timestamps', key: 'latestAt' } as const, null as number | null)
// How long each saved turn took, in ms, keyed like `finals`: from your prompt
// to the last text Claude wrote in that turn.
const durations = atom({ plugin: 'message-timestamps', key: 'durations' } as const, {} as Stamps, {
  shape: 'durations-1',
})
// When the newest turn started, recorded live: the start of the turn still
// running or not yet in the transcript file. A message you send while Claude
// works joins the running turn and doesn't move it.
const promptAt = atom({ plugin: 'message-timestamps', key: 'promptAt' } as const, null as number | null)
// How long each saved turn thought, in ms, and how many tokens it wrote,
// keyed like `durations`.
const thinking = atom({ plugin: 'message-timestamps', key: 'thinking' } as const, {} as Stamps, {
  shape: 'thinking-1',
})
const tokens = atom({ plugin: 'message-timestamps', key: 'tokens' } as const, {} as Stamps, {
  shape: 'tokens-1',
})
// How much of the context is left before auto-compaction (of the whole window
// when auto-compaction is off), as a whole percentage, measured after each
// turn; null until the first reading.
const contextLeft = atom({ plugin: 'message-timestamps', key: 'contextLeft' } as const, null as number | null)
// The main conversation's prompt cache: when its last request was sent (real
// ms, not local-shifted) and how long the cache holds it. Each request renews
// it; once it lapses, the next message sends the whole conversation uncached.
const cache = atom({ plugin: 'message-timestamps', key: 'cache' } as const, null as { at: number; ttlMs: number } | null)
// How long each tool call took, in ms, keyed by its tool_use id: timed live
// from when it starts running, or read from the transcript for older calls.
const toolTimes = atom({ plugin: 'message-timestamps', key: 'toolTimes' } as const, {} as Stamps, {
  shape: 'tools-1',
})

const pad = (n: number) => String(n).padStart(2, '0')

// The "Language" setting: how a date and a 12-hour time are written.
type Language = 'English' | 'Italiano' | '中文'
type DateStyle = {
  // A time on the 12-hour clock, from the hour (1-12), minutes and AM/PM.
  twelveHour: (hour: number, minutes: string, isAm: boolean) => string
  // A date this year ("2 Oct"), or with its year ("2 Oct 2025"), before a time.
  withTime: (day: number, month: number, year: number | null, time: string) => string
  // A day separator's name for a day before yesterday ("Thu 2 Oct"), weekday 0 = Sunday.
  dayName: (weekday: number, day: number, month: number, year: number | null) => string
  today: string
  yesterday: string
}
const monthsStyle = (
  months: readonly string[],
  weekdays: readonly string[],
  today: string,
  yesterday: string,
): DateStyle => ({
  twelveHour: (h, m, isAm) => `${h}:${m} ${isAm ? 'AM' : 'PM'}`,
  withTime: (day, month, year, time) => `${day} ${months[month]}${year === null ? '' : ` ${year}`}, ${time}`,
  dayName: (weekday, day, month, year) => `${weekdays[weekday]} ${day} ${months[month]}${year === null ? '' : ` ${year}`}`,
  today,
  yesterday,
})
const DATE_STYLES: Record<Language, DateStyle> = {
  English: monthsStyle(
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    'Today',
    'Yesterday',
  ),
  Italiano: monthsStyle(
    ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
    ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
    'Oggi',
    'Ieri',
  ),
  中文: {
    twelveHour: (h, m, isAm) => `${isAm ? '上午' : '下午'}${h}:${m}`,
    withTime: (day, month, year, time) => `${year === null ? '' : `${year}年`}${month + 1}月${day}日 ${time}`,
    dayName: (weekday, day, month, year) =>
      `${year === null ? '' : `${year}年`}${month + 1}月${day}日 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday]}`,
    today: '今天',
    yesterday: '昨天',
  },
}

// The words for how hard Claude worked, per language: "thought 40s · 12k tokens".
type WorkWords = {
  thought: string
  // A token count already shortened ("12k"), with its word; `count` is the exact number.
  tokens: (amount: string, count: number) => string
  // The decimal separator in "1.5k".
  decimal: string
}
const WORK_WORDS: Record<Language, WorkWords> = {
  English: { thought: 'thought', tokens: (amount, count) => `${amount} ${count === 1 ? 'token' : 'tokens'}`, decimal: '.' },
  Italiano: { thought: 'pensato', tokens: amount => `${amount} token`, decimal: ',' },
  中文: { thought: '思考', tokens: amount => `${amount} token`, decimal: '.' },
}

// A token count kept short: 850, 1.5k, 12k, 2.3M.
export function formatTokens(count: number, decimal: string): string {
  const short = (n: number, unit: string) => `${n.toFixed(1).replace(/\.0$/, '').replace('.', decimal)}${unit}`
  if (count < 1000) return String(count)
  if (count < 9_950) return short(count / 1000, 'k')
  if (count < 999_500) return `${Math.round(count / 1000)}k`
  return short(count / 1_000_000, 'M')
}

// A local-shifted time's day, as a whole number of days: two times are on the
// same day when these match, and yesterday is one less.
const dayNumber = (local: number) => Math.floor(local / 86_400_000)

// The day separator's words for the day a message was sent.
export function formatDay(local: number, localNow: number): string {
  const days = dayNumber(localNow) - dayNumber(local)
  if (days === 0) return dateStyle.today
  if (days === 1) return dateStyle.yesterday
  const d = new Date(local)
  const year = d.getUTCFullYear() === new Date(localNow).getUTCFullYear() ? null : d.getUTCFullYear()
  return dateStyle.dayName(d.getUTCDay(), d.getUTCDate(), d.getUTCMonth(), year)
}

// Every known send time in order, rebuilt only when the stamps change: the
// stamps map is replaced, never edited, on each update.
let sortedFor: Stamps | undefined
let sortedTimes: number[] = []
function timesInOrder(map: Stamps): number[] {
  if (map !== sortedFor) {
    sortedFor = map
    sortedTimes = Object.values(map).sort((a, b) => a - b)
  }
  return sortedTimes
}

// How long the conversation must have paused before a message for it to get a
// line saying so.
const PAUSE_MS = 60 * 60_000

// How long the prompt cache holds a request, as the API reports it.
const FIVE_MINUTES = 5 * 60_000
const ONE_HOUR = 60 * 60_000

// The words for the prompt cache's countdown: "cache 42m", "cache expired".
const CACHE_WORDS: Record<Language, { cache: string; expired: string }> = {
  English: { cache: 'cache', expired: 'cache expired' },
  Italiano: { cache: 'cache', expired: 'cache scaduta' },
  中文: { cache: '缓存', expired: '缓存已过期' },
}

// The words for a pause, in whole hours: "3 hours later".
const PAUSE_WORDS: Record<Language, (hours: number) => string> = {
  English: hours => (hours === 1 ? '1 hour later' : `${hours} hours later`),
  Italiano: hours => (hours === 1 ? '1 ora dopo' : `${hours} ore dopo`),
  中文: hours => `${hours} 小时后`,
}

// What's left of `limit` once `used` tokens are taken, as a whole percentage
// from 0 to 100.
export function percentLeft(used: number, limit: number): number {
  return Math.min(100, Math.max(0, Math.round(100 * (1 - used / limit))))
}

// The send time of the message just before the one sent at `at`, if any.
function previousTime(map: Stamps, at: number): number | undefined {
  const times = timesInOrder(map)
  // Binary search for the first time not before `at`; the one before it is
  // the previous message's.
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] ?? Infinity) < at) lo = mid + 1
    else hi = mid
  }
  return times[lo - 1]
}

// When a time shows its date: `auto`, unless it's today; `omit`, never, as the
// day is already said above it; `force`, always.
type DateRule = 'auto' | 'omit' | 'force'

// Whether this surface draws separators: they go above your messages, in the
// desktop app and the terminal. Elsewhere times keep their dates.
function hasSeparators(surface: string): boolean {
  return isSeparatorOn && (surface === 'terminal' || surface === 'desktop')
}

// Where separators are drawn, whether the day of a time at `at` (a command's
// output) is already said above it: an earlier message was sent that day, and
// the first message of each day has a separator or a date of its own.
function isDayShownAbove(map: Stamps, at: number): boolean {
  const previous = previousTime(map, at)
  return previous !== undefined && dayNumber(previous) === dayNumber(at)
}

// Where separators are drawn, the date rule for a reply whose turn took
// `duration`. Its turn's prompt has its day said above it, so a reply that
// finished the same day leaves out its date. One that ran past midnight shows
// it, even today: separators only go above your messages, and the reply's own
// earlier text blocks, though stored, show no time. Without the turn's length,
// the time just before it decides.
function replyDateRule(map: Stamps, at: number, duration: number | undefined): DateRule {
  if (duration !== undefined && duration >= 0) return dayNumber(at - duration) === dayNumber(at) ? 'omit' : 'force'
  return isDayShownAbove(map, at) ? 'omit' : 'auto'
}

// The separator's words above the message sent at `at`, or undefined for
// none. The first message of a day gets the day's name ("Yesterday"), unless
// it's the first of the conversation and sent today: the whole conversation is
// today so far. A message sent an hour or more after the one before it, on
// the same day, gets how long the pause was, to the nearest hour.
function separatorText(map: Stamps, at: number, now: number): string | undefined {
  const previous = previousTime(map, at)
  if (previous === undefined) return dayNumber(at) !== dayNumber(now) ? formatDay(at, now) : undefined
  if (dayNumber(previous) !== dayNumber(at)) return formatDay(at, now)
  const pause = at - previous
  return pause >= PAUSE_MS ? pauseWords(Math.round(pause / PAUSE_MS)) : undefined
}

// Settings, read once in `register`.
// "Language": how dates and 12-hour times are written, and the words for how
// hard Claude worked and for a pause.
let dateStyle = DATE_STYLES.English
let workWords = WORK_WORDS.English
let pauseWords = PAUSE_WORDS.English
let cacheWords = CACHE_WORDS.English
// "Clock": 24-hour (23:21) or 12-hour (11:21 PM).
let isTwelveHour = false
// "Where Claude's time goes": bottom right of the answer, or on its own line
// under it.
let isReplyTimeBelow = false
// "How long Claude took": the turn's length after its time.
let isDurationOn = true
// "Thinking and tokens": how long the turn thought and how much it wrote.
let isWorkOn = false
// "Day and pause separators": a line naming the day above its first message,
// or saying how long a pause was. With them on, times leave out the date when
// the day is already said above them.
let isSeparatorOn = true
// "Where the time on your messages goes" (desktop): on hover beside the app's
// toolbar, or always, on its own line above the message.
let isPromptTimeAbove = false

// How long a turn took, kept short: 45s, 2m 14s, 1m, 1h 5m, 2h.
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const [big, small, bigUnit, smallUnit] =
    s < 3600 ? [Math.floor(s / 60), s % 60, 'm', 's'] : [Math.floor(s / 3600), Math.floor((s % 3600) / 60), 'h', 'm']
  return small === 0 ? `${big}${bigUnit}` : `${big}${bigUnit} ${small}${smallUnit}`
}

// "08:05 · 2m 14s", or just the time when the duration isn't known or the
// setting is off.
function timeLabel(at: number, duration: number | null | undefined, now: number, rule: DateRule): string {
  const time = formatStamp(at, now, rule)
  if (!isDurationOn || duration == null || duration < 0) return time
  return `${time} · ${formatDuration(duration)}`
}

// "thought 40s · 12k tokens", each part left out when it isn't known; empty
// when neither is or the setting is off.
function workLabel(thought: number | undefined, written: number | undefined): string {
  if (!isWorkOn) return ''
  const parts: string[] = []
  // Under half a second would read "0s".
  if (thought !== undefined && thought >= 500) parts.push(`${workWords.thought} ${formatDuration(thought)}`)
  if (written !== undefined && written > 0) {
    parts.push(workWords.tokens(formatTokens(written, workWords.decimal), written))
  }
  return parts.join(' · ')
}

// "23:21" today, or with the date another day ("2 Oct, 08:05") unless
// `rule` says otherwise.
export function formatStamp(local: number, localNow: number, rule: DateRule = 'auto'): string {
  const d = new Date(local)
  const now = new Date(localNow)
  const hours = d.getUTCHours()
  const time = isTwelveHour
    ? dateStyle.twelveHour(hours % 12 || 12, pad(d.getUTCMinutes()), hours < 12)
    : `${pad(hours)}:${pad(d.getUTCMinutes())}`
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  if (rule === 'omit' || (rule === 'auto' && sameDay)) return time
  const year = d.getUTCFullYear() === now.getUTCFullYear() ? null : d.getUTCFullYear()
  return dateStyle.withTime(d.getUTCDate(), d.getUTCMonth(), year, time)
}

type Block = { type: string }

// Rows the transcript draws as a prompt or a reply's text: not tool results,
// not hidden reminders, not thinking- or tool-only assistant blocks.
function isShownRow(message: { type: string; name?: string; isMeta?: true; content: readonly Block[] }): boolean {
  // A slash command's printed output (/reload-plugins, /cost, ...).
  if (message.type === 'system') return message.name === 'local_command'
  const hasText = message.content.some(b => b.type === 'text')
  if (message.type === 'user') {
    return !message.isMeta && hasText && !message.content.some(b => b.type === 'tool_result')
  }
  return message.type === 'assistant' && hasText
}

async function zoneOffset($: EngineInterface): Promise<number> {
  return (await read($, tzOffset)) ?? new Date().getTimezoneOffset()
}

async function localNow($: EngineInterface): Promise<number> {
  return (await $.clock.now()) - (await zoneOffset($)) * 60000
}

// The conversation history Claude Code saves, read only where it grew since
// the read before. Another conversation (after /clear), or a file that got
// shorter, starts over.
let history: HistoryTail | undefined

// How much of a long history's end is read first, when it's opened.
const RECENT = 512 * 1024

async function readHistory($: EngineInterface): Promise<HistoryReader | undefined> {
  const { transcriptPath: path } = await $.session.info()
  if (path === '' || !(await $.fs.exists(path))) return undefined
  const { size } = await $.fs.stat(path)
  const file = {
    read: (offset: number, length: number) => $.fs.read(path, { offset, length }),
    readBytes: async (offset: number, length: number) => (await $.fs.read(path, { as: 'bytes', offset, length })).base64,
  }
  if (history === undefined || history.path !== path || size < history.offset) {
    history = new HistoryTail(path)
    // Opening a long history with nothing kept yet, its end is read first: the
    // messages on screen get their times at once, the older ones once it's
    // been read whole. (After a reload the times are still kept: the end
    // alone would only take the older ones away for a moment.)
    if (size > RECENT && (await read($, finals)).length === 0) {
      await keepTimes($, await readWindow(size - RECENT, size, file))
    }
  }
  await history.readTo(size, file)
  return history.reader
}

// Whether two kept values hold the same things.
function isSame(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(k => isSame((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// Brings the times read from the history into what the mod keeps.
async function backfill($: EngineInterface): Promise<void> {
  const reader = await readHistory($)
  if (reader !== undefined) await keepTimes($, reader.times())
}

async function keepTimes($: EngineInterface, out: HistoryTimes): Promise<void> {
  // Each value is written only when it changed: a write redraws whatever
  // reads it, every message on screen included.
  const zone = new Date().getTimezoneOffset()
  if ((await read($, tzOffset)) !== zone) await update($, tzOffset, () => zone)
  // A live timing leaves out any wait for your permission, so it wins.
  const timed = await read($, toolTimes)
  if (!isSame(timed, { ...out.tools, ...timed })) await update($, toolTimes, current => ({ ...out.tools, ...current }))
  // A reopened conversation has no live reading yet; the newer one wins.
  const saved = out.cache
  const held = await read($, cache)
  if (saved !== null && (held === null || held.at < saved.at)) {
    await update($, cache, current => (current !== null && current.at >= saved.at ? current : saved))
  }
  const sent = await read($, stamps)
  if (!isSame(sent, { ...sent, ...out.rows })) await update($, stamps, current => ({ ...current, ...out.rows }))
  if (!isSame(await read($, finals), out.finals)) await update($, finals, () => out.finals)
  if (!isSame(await read($, durations), out.durations)) await update($, durations, () => out.durations)
  if (!isSame(await read($, thinking), out.thinking)) await update($, thinking, () => out.thinking)
  if (!isSame(await read($, tokens), out.tokens)) await update($, tokens, () => out.tokens)
}

// Reads how full the context is and keeps what's left. The token count is the
// last answer's, as the status line has it; the auto-compaction point comes
// from a local estimate (no request is sent). Right after a compaction there's
// no answer yet to count, so the estimate's total stands in.
async function measureContext($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  const used = context.tokens ?? breakdown?.totalTokens
  if (used === undefined) return
  const threshold = breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined
  const limit = threshold ?? context.window
  if (!(limit > 0)) return
  const left = percentLeft(used, limit)
  if ((await read($, contextLeft)) !== left) await update($, contextLeft, () => left)
}

function remeasure($: EngineInterface): void {
  measureContext($).catch(err => $.ui.log(`message-timestamps: context: ${String(err)}`, { to: 'debug' }))
}

let pending: Promise<void> | undefined

// One backfill at a time; a call while one runs shares it.
function refresh($: EngineInterface): Promise<void> {
  pending ??= backfill($)
    .catch(err => $.ui.log(`message-timestamps: ${String(err)}`, { to: 'debug' }))
    .finally(() => {
      pending = undefined
    })
  return pending
}

export const register: Register = (on, options) => {
  isTwelveHour = options.clock === '12-hour'
  dateStyle = DATE_STYLES[options.language as Language] ?? DATE_STYLES.English
  workWords = WORK_WORDS[options.language as Language] ?? WORK_WORDS.English
  pauseWords = PAUSE_WORDS[options.language as Language] ?? PAUSE_WORDS.English
  cacheWords = CACHE_WORDS[options.language as Language] ?? CACHE_WORDS.English
  isReplyTimeBelow = options.reply_time === 'below'
  isDurationOn = options.reply_duration !== false
  isWorkOn = options.reply_details === true
  isSeparatorOn = options.day_separators !== false
  isPromptTimeAbove = options.prompt_time === 'above'
  const isHoverTimeOn = options.hover_time !== false
  const isContextOn = options.context_left !== false
  const isToolTimeOn = options.tool_time !== false
  const isCacheTimerOn = options.cache_timer !== false

  // Each request of the main conversation renews its prompt cache, counted
  // from when the request was sent. The response says for how long it wrote
  // the cache (1 hour or 5 minutes, the shorter when both); one that only read
  // it keeps the lifetime written before. Nothing here may throw: a failure
  // mid-stream would leave the request where it stood.
  on('turn.step', async function* ($, e, next) {
    const isTimed = isCacheTimerOn && e.agentId === undefined
    const at = isTimed ? await $.clock.now().catch(() => undefined) : undefined
    const result = yield* next(e)
    if (at !== undefined && result.usage !== null) {
      try {
        const u = result.usage
        const written =
          (u.ephemeral_5m_input_tokens ?? 0) > 0 ? FIVE_MINUTES : (u.ephemeral_1h_input_tokens ?? 0) > 0 ? ONE_HOUR : undefined
        if (written !== undefined || u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0) {
          // A write that named no lifetime is priced as five minutes.
          await update($, cache, current => ({
            at,
            ttlMs: written ?? (u.cache_creation_input_tokens > 0 ? FIVE_MINUTES : current?.ttlMs ?? FIVE_MINUTES),
          }))
        }
      } catch (err) {
        $.ui.log(`message-timestamps: cache: ${String(err)}`, { to: 'debug' })
      }
    }
    return result
  })

  // Times each tool call from when it starts running, once allowed: a wait
  // for your permission isn't counted.
  // Nothing here may throw: a failed timing must never get in the call's way,
  // and retrying the hook would run the call twice.
  on('tool.run', async ($, e, next) => {
    const id = e.tool_use_id
    const start = isToolTimeOn && id !== undefined ? await $.clock.now().catch(() => undefined) : undefined
    const result = await next(e)
    if (start !== undefined && id !== undefined) {
      try {
        const took = (await $.clock.now()) - start
        await update($, toolTimes, current => ({ ...current, [id]: took }))
      } catch (err) {
        $.ui.log(`message-timestamps: tool time: ${String(err)}`, { to: 'debug' })
      }
    }
    return result
  })

  // A tool call's row: how long it took, at its right edge, once it's done.
  // Calls under a second get nothing, so quick reads and edits stay clean.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isToolTimeOn || e.props.isRunning) return next(e)
    const took = (await read($, toolTimes))[e.props.tool_use_id]
    return withToolTime($.ui.resolve(e), await next(e), took)
  })

  // A folded run of calls ("Read 3 files"): their times added up.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!isToolTimeOn || e.props.isActive || e.props.isExpanded) return next(e)
    const times = await read($, toolTimes)
    let total = 0
    for (const c of e.props.calls) total += (c.tool_use_id === undefined ? undefined : times[c.tool_use_id]) ?? 0
    return withToolTime($.ui.resolve(e), await next(e), total)
  })

  // The start of each turn of the main loop that has a prompt (yours, or a
  // notification's), not a continuation and not a subagent's.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined && e.text !== '') {
      const at = await localNow($)
      await update($, promptAt, () => at)
    }
    return started
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    ensurePoller($)
    if (isContextOn) remeasure($)
    return started
  })

  // Catches what this turn wrote, and once more shortly after in case the
  // closing text reached the transcript file after the turn ended.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    ensurePoller($)
    void refresh($)
    isWanted = true
    if (isContextOn) remeasure($)
    return done
  })

  // A compaction of the main conversation frees the context: measure again.
  // Not one computed ahead and kept for later, nor one that was called off.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (isContextOn && e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      await measureContext($).catch(err => $.ui.log(`message-timestamps: context: ${String(err)}`, { to: 'debug' }))
    }
    return done
  }).catch(($, e, next) => next(e))

  // Live record: the moment each prompt or reply block is stored. Not a
  // compacted chat's summary, which comes in as a user row but is no message
  // of yours (the history reader leaves it out too).
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && e.door !== 'compaction' && stored.deny === undefined && isShownRow(stored.message)) {
      ensurePoller($)
      const at = await localNow($)
      await update($, stamps, current => ({ ...current, [stored.uuid]: at }))
      if (stored.message.type === 'assistant') {
        await update($, latestAt, () => at)
        isWanted = true
      }
    }
    return stored
  }).catch(($, e, next) => next(e))

  // Your prompt. Terminal: a time on its own line under it. Desktop, as in
  // Codex: shown only while you hover the message, on the line of the app's
  // own hover toolbar (Just now, copy, rewind), just left of it.
  // Above it, when it's the first message of a new day, a separator naming
  // the day ("── Yesterday ──"), or after a pause of an hour or more, one
  // saying how long ("── 3 hours later ──").
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const isHoverShown = e.surface === 'terminal' || isHoverTimeOn
    if (!isHoverShown && !isSeparatorOn) return next(e)
    const map = await read($, stamps)
    const at = lookup(map, e.requestId)
    const row = await next(e)
    if (at === undefined) {
      retryLater()
      return row
    }
    const { Box, Text } = $.ui.resolve(e)
    const now = await localNow($)
    const words = isSeparatorOn ? separatorText(map, at, now) : undefined
    const separator =
      words === undefined ? null : (
        <Box justifyContent="center" marginY="xs">
          <Text dimColor size="caption">{`── ${words} ──`}</Text>
        </Box>
      )
    // With the separators on, your message's day is always said above it: by
    // its own separator when it's the first of its day, by an earlier one
    // otherwise.
    const stamp = <Text dimColor size="caption">{formatStamp(at, now, isSeparatorOn ? 'omit' : 'auto')}</Text>
    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column">
          {separator}
          {row}
          {stamp}
        </Box>
      )
    }
    if (!isHoverShown) {
      if (separator === null) return row
      return (
        <Box flexDirection="column">
          {separator}
          {row}
        </Box>
      )
    }
    // "Above": always shown, on a line of its own over the message, at its
    // right edge like a chat's header. It doesn't depend on how wide the
    // app's hover toolbar under the message is, so app updates can't move it.
    if (isPromptTimeAbove) {
      return (
        <Box flexDirection="column">
          {separator}
          <Box key="prompt-time" justifyContent="flex-end" marginBottom="xs">
            {stamp}
          </Box>
          {row}
        </Box>
      )
    }
    // The keyed Box is the hover area; the time takes no room (absolute) and
    // stays hidden until the pointer is over the message. A one-line-tall box
    // with the text centered in it lines the time up with the middle of the
    // app's toolbar rather than the row's bottom edge.
    return (
      <Box key={`prompt-${e.requestId}`} flexDirection="column">
        {separator}
        {row}
        <Box
          position="absolute"
          bottom={0}
          right={hoverToolbarWidth(now - at)}
          height={1}
          flexDirection="column"
          justifyContent="center"
          display="none"
          hover={{ display: 'flex' }}
        >
          {stamp}
        </Box>
      </Box>
    )
  })

  // Claude's reply: one time per turn, beside or under the last block of
  // text the turn wrote (while a turn runs, its latest block so far). Not on
  // the app's button row under it: a mod can't add to that row, and the
  // desktop clips anything drawn outside the message's own area.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const msgId = e.requestId.replace(/-t\d+$/, '')
    const map = await read($, stamps)
    const known = lookup(map, e.requestId)
    const row = await next(e)
    let at: number | undefined
    let duration: number | undefined
    let thought: number | undefined
    let written: number | undefined
    let isNewest = false
    if (known !== undefined) {
      // Saved already: shown only if it's its turn's last block of text.
      const saved = await read($, finals)
      if (saved.includes(msgId)) {
        at = known
        isNewest = saved[saved.length - 1] === msgId
        duration = (await read($, durations))[msgId]
        thought = (await read($, thinking))[msgId]
        written = (await read($, tokens))[msgId]
      }
    } else {
      // Not in the transcript file yet, so it's the newest reply: show the
      // live time Claude last wrote text, and have the file reread.
      retryLater()
      if (Object.keys(map).length > 0) {
        at = (await read($, latestAt)) ?? undefined
        const start = await read($, promptAt)
        if (at !== undefined && start !== null) duration = at - start
      }
    }
    if (at === undefined) return row
    const rule = hasSeparators(e.surface) ? replyDateRule(map, at, duration) : 'auto'
    const time = timeLabel(at, duration, await localNow($), rule)
    // The newest saved answer also says how much context is left before
    // auto-compaction: "23:21 · 2m 14s · ◕ 62%".
    // And how long until the prompt cache lapses: "· cache 42m".
    const extras: Figure[] = []
    if (isNewest) {
      const left = isContextOn ? await read($, contextLeft) : null
      if (typeof left === 'number') extras.push(contextFigure(left))
      const held = isCacheTimerOn ? await read($, cache) : null
      if (held !== null && typeof held === 'object') extras.push(cacheFigure(held.at + held.ttlMs - (await $.clock.now())))
    }
    // Only the desktop has a pointer to reveal the details with.
    const hoverId = e.surface === 'desktop' ? e.requestId : undefined
    return withReplyTime($.ui.resolve(e), row, time, workLabel(thought, written), hoverId, extras)
  })

  // A slash command's output (/reload-plugins, /cost, ...): the app treats it
  // like a reply (it gets the copy/pin/"Just now" row), so it gets a time too,
  // placed the same way.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const map = await read($, stamps)
    const at = map[e.requestId]
    const row = await next(e)
    if (at === undefined) {
      retryLater()
      return row
    }
    const rule = hasSeparators(e.surface) && isDayShownAbove(map, at) ? 'omit' : 'auto'
    const time = formatStamp(at, await localNow($), rule)
    return withReplyTime($.ui.resolve(e), row, time, '', undefined)
  })
}

// Claude's answer (or a command's output) with its time: at the bottom right,
// beside the last line, or on its own line under the text, at its right edge.
// The time goes on its own line when the setting asks for it, and whenever
// thinking and tokens or the context and cache figures are on: beside the last
// line there's no room for them
// without narrowing the whole answer or covering its text. On that line `work`
// goes before the time; given `hoverId` (where there's a pointer) it shows
// only while the pointer is on the time itself, so reading or scrolling with
// the pointer over the answer leaves it hidden. The time's box never shrinks,
// so a long date can't wrap.
function withReplyTime(
  { Box, Text }: ReturnType<EngineInterface['ui']['resolve']>,
  row: RenderElement,
  label: string,
  work: string,
  hoverId: string | undefined,
  extras: Figure[] = [],
): RenderElement {
  const time =
    extras.length === 0 ? (
      <Text dimColor size="body">{label}</Text>
    ) : (
      <Box flexDirection="row">
        <Text dimColor size="body">{label}</Text>
        {extras.map(figure => figureText(Text, figure))}
      </Box>
    )
  // The figures after the newest answer's time would widen the column beside
  // its last line and narrow the whole answer: with them the time goes below.
  if (isReplyTimeBelow || isWorkOn || extras.length > 0) {
    // The keyed Box around the time is the hover area; the work appears in it,
    // before the time, which stays put. The work's own Box has no key: a keyed
    // one would be its own hover area, and a hidden Box can't be hovered. The
    // no-break space keeps the gap that a plain trailing space would lose. Only
    // the time never shrinks, so in a narrow window the work wraps instead.
    const reveal = hoverId === undefined ? {} : { display: 'none' as const, hover: { display: 'flex' as const } }
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" justifyContent="flex-end" marginTop="xs">
          <Box key="stamp" flexDirection="row">
            {work === '' ? null : (
              <Box {...reveal}>
                <Text dimColor size="body">{`${work} · `}</Text>
              </Box>
            )}
            <Box flexShrink={0}>{time}</Box>
          </Box>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="row" alignItems="flex-end" gap="sm">
      <Box flexGrow={1} flexShrink={1}>
        {row}
      </Box>
      <Box key="stamp" flexShrink={0}>
        {time}
      </Box>
    </Box>
  )
}

// A tool call's row (or a folded run of them) with how long it took at its
// right edge, on its first line; left as drawn under a second or when unknown.
function withToolTime(
  { Box, Text }: ReturnType<EngineInterface['ui']['resolve']>,
  row: RenderElement,
  took: number | undefined,
): RenderElement {
  if (took === undefined || took < 1000) return row
  return (
    <Box flexDirection="row" alignItems="flex-start" gap="sm">
      <Box flexGrow={1} flexShrink={1}>
        {row}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor size="caption">{formatDuration(took)}</Text>
      </Box>
    </Box>
  )
}

// A figure after the time on the newest answer: its text, and a color from
// the theme, or none to stay grey like the time. Each starts with " · " in
// no-break spaces, which keep the gap the row would otherwise drop.
type Figure = { text: string; color: 'warning' | 'error' | undefined }

// How much context is left: " · ◕ 62%". The circle empties as the context
// fills. Grey while there's room, warning under 25%, error under 10%.
function contextFigure(left: number): Figure {
  const circle = left >= 88 ? '●' : left >= 63 ? '◕' : left >= 38 ? '◑' : left >= 13 ? '◔' : '○'
  const color = left < 10 ? 'error' : left < 25 ? 'warning' : undefined
  return { text: ` · ${circle} ${left}%`, color }
}
// How long until the prompt cache lapses: " · cache 42m", grey; under five
// minutes, " · cache 3m" in the warning color; once it has, " · cache expired",
// warning too: your next message sends the whole conversation uncached.
function cacheFigure(leftMs: number): Figure {
  if (leftMs <= 0) return { text: ` · ${cacheWords.expired}`, color: 'warning' }
  const minutes = Math.floor(leftMs / 60_000)
  const amount = minutes < 1 ? '<1m' : `${minutes}m`
  return { text: ` · ${cacheWords.cache} ${amount}`, color: leftMs < FIVE_MINUTES ? 'warning' : undefined }
}

function figureText(Text: ReturnType<EngineInterface['ui']['resolve']>['Text'], { text, color }: Figure): RenderElement {
  return color === undefined ? (
    <Text dimColor size="body">{text}</Text>
  ) : (
    <Text color={color} size="body">{text}</Text>
  )
}

// A reply block is drawn as `<API message id>-t<n>`; a prompt by its row uuid.
function lookup(map: Stamps, id: string): number | undefined {
  return map[id] ?? map[id.replace(/-t\d+$/, '')]
}

// A message drawn before its time was read: the poller (ensurePoller)
// rereads the transcript on its next tick (a render may not write state).
let isWanted = false
function retryLater(): void {
  isWanted = true
}

// One poller per module load, started from whichever lasting hook runs first
// (session.start may not run again after a /reload-plugins).
let isPolling = false
function ensurePoller($: EngineInterface): void {
  if (isPolling) return
  isPolling = true
  $.clock.every(1500, () => {
    if (!isWanted) return
    isWanted = false
    void refresh($)
  })
  // The toolbar's label ages ("Just now" -> "5 minutes ago"), and with it its
  // width: redraw once a minute so the hover time moves with it.
  $.clock.every(60000, () => $.ui.invalidate('ui.render'))
}

// How far in from the right edge the app's hover toolbar under your message
// reaches ("<age label> · branch · rewind · edit · copy"), in cells, so your
// hovered time sits just left of it. The toolbar's width follows the app's
// age label, so the offset does too. "Just now" measured on 20 Nov 2026 (the
// toolbar takes about 14.5 cells, plus one cell of gap); the others keep their
// earlier distance from it, which follows label length.
const HOVER_TOOLBAR = {
  justNow: 15, // "Just now", first minute
  minutes: 20, // "5 minutes ago"
  hours: 19, // "3 hours ago"
  days: 17, // "2 days ago"
  date: 14, // "Oct 22"
}
function hoverToolbarWidth(ageMs: number): number {
  const minute = 60_000
  if (ageMs < minute) return HOVER_TOOLBAR.justNow
  if (ageMs < 60 * minute) return HOVER_TOOLBAR.minutes
  if (ageMs < 24 * 60 * minute) return HOVER_TOOLBAR.hours
  if (ageMs < 7 * 24 * 60 * minute) return HOVER_TOOLBAR.days
  return HOVER_TOOLBAR.date
}
