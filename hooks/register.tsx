import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Stamps } from '../types'

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

// The words for a pause, in whole hours: "3 hours later".
const PAUSE_WORDS: Record<Language, (hours: number) => string> = {
  English: hours => (hours === 1 ? '1 hour later' : `${hours} hours later`),
  Italiano: hours => (hours === 1 ? '1 ora dopo' : `${hours} ore dopo`),
  中文: hours => `${hours} 小时后`,
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

// Reads the saved transcript (it can be far past $.fs.read's 4 MiB cap) with
// a small Node script shipped in the mod.
async function backfill($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const script = `${$.plugin.root}/scripts/backfill.cjs`
  const ran = await $.process.run(['node', script, id], { timeoutMs: 120000 })
  if (ran.exitCode !== 0 || ran.isStdoutTruncated) {
    $.ui.log(`message-timestamps: backfill failed (${ran.exitCode}): ${ran.stderr.slice(0, 200)}`, { to: 'debug' })
    return
  }
  const out = JSON.parse(ran.stdout) as {
    tz: number
    rows: Stamps
    finals: string[]
    durations?: Stamps
    thinking?: Stamps
    tokens?: Stamps
  }
  await update($, tzOffset, () => out.tz)
  await update($, stamps, current => ({ ...current, ...out.rows }))
  await update($, finals, () => out.finals)
  await update($, durations, () => out.durations ?? {})
  await update($, thinking, () => out.thinking ?? {})
  await update($, tokens, () => out.tokens ?? {})
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
  isReplyTimeBelow = options.reply_time === 'below'
  isDurationOn = options.reply_duration !== false
  isWorkOn = options.reply_details === true
  isSeparatorOn = options.day_separators !== false
  isPromptTimeAbove = options.prompt_time === 'above'
  const isHoverTimeOn = options.hover_time !== false

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
    return started
  })

  // Catches what this turn wrote, and once more shortly after in case the
  // closing text reached the transcript file after the turn ended.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    ensurePoller($)
    void refresh($)
    isWanted = true
    return done
  })

  // Live record: the moment each prompt or reply block is stored. Not a
  // compacted chat's summary, which comes in as a user row but is no message
  // of yours (backfill.cjs leaves it out too).
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
    if (known !== undefined) {
      // Saved already: shown only if it's its turn's last block of text.
      if ((await read($, finals)).includes(msgId)) {
        at = known
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
    // Only the desktop has a pointer to reveal the details with.
    const hoverId = e.surface === 'desktop' ? e.requestId : undefined
    return withReplyTime($.ui.resolve(e), row, time, workLabel(thought, written), hoverId)
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
// thinking and tokens are on: beside the last line there's no room for them
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
): RenderElement {
  const time = <Text dimColor size="body">{label}</Text>
  if (isReplyTimeBelow || isWorkOn) {
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
