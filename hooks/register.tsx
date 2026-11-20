import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Stamps } from '../types'

// Times are kept "local-shifted": UTC ms minus the zone offset, so the UTC
// getters below read local wall-clock time without needing the zone here.
const stamps = atom({ plugin: 'message-timestamps', key: 'stamps' } as const, {} as Stamps, {
  shape: 'stamps-1',
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

// Whether the message sent at `at` is the first of its day: no message before
// it, or the one just before it was sent on another day. A first message sent
// today needs none: the whole conversation is today so far.
function startsNewDay(map: Stamps, at: number, now: number): boolean {
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
  const previous = times[lo - 1]
  if (previous === undefined) return dayNumber(at) !== dayNumber(now)
  return dayNumber(previous) !== dayNumber(at)
}

// Settings, read once in `register`.
// "Language": how dates and 12-hour times are written.
let dateStyle = DATE_STYLES.English
// "Clock": 24-hour (23:21) or 12-hour (11:21 PM).
let isTwelveHour = false
// "Where Claude's time goes": bottom right of the answer, or on its own line
// under it.
let isReplyTimeBelow = false
// "How long Claude took": the turn's length after its time.
let isDurationOn = true
// "Day separators": a line naming the day above its first message.
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
function replyLabel(at: number, duration: number | null | undefined, now: number): string {
  const time = formatStamp(at, now)
  if (!isDurationOn || duration == null || duration < 0) return time
  return `${time} · ${formatDuration(duration)}`
}

export function formatStamp(local: number, localNow: number): string {
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
  if (sameDay) return time
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
  const out = JSON.parse(ran.stdout) as { tz: number; rows: Stamps; finals: string[]; durations?: Stamps }
  await update($, tzOffset, () => out.tz)
  await update($, stamps, current => ({ ...current, ...out.rows }))
  await update($, finals, () => out.finals)
  await update($, durations, () => out.durations ?? {})
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
  isReplyTimeBelow = options.reply_time === 'below'
  isDurationOn = options.reply_duration !== false
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

  // Live record: the moment each prompt or reply block is stored.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && stored.deny === undefined && isShownRow(stored.message)) {
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
  // the day ("── Yesterday ──").
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
    const separator =
      isSeparatorOn && startsNewDay(map, at, now) ? (
        <Box justifyContent="center" marginY="xs">
          <Text dimColor size="caption">{`── ${formatDay(at, now)} ──`}</Text>
        </Box>
      ) : null
    const stamp = <Text dimColor size="caption">{formatStamp(at, now)}</Text>
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
    if (known !== undefined) {
      // Saved already: shown only if it's its turn's last block of text.
      if ((await read($, finals)).includes(msgId)) {
        at = known
        duration = (await read($, durations))[msgId]
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
    return withReplyTime($.ui.resolve(e), row, replyLabel(at, duration, await localNow($)))
  })

  // A slash command's output (/reload-plugins, /cost, ...): the app treats it
  // like a reply (it gets the copy/pin/"Just now" row), so it gets a time too,
  // placed the same way.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const at = (await read($, stamps))[e.requestId]
    const row = await next(e)
    if (at === undefined) {
      retryLater()
      return row
    }
    return withReplyTime($.ui.resolve(e), row, formatStamp(at, await localNow($)))
  })
}

// Claude's answer (or a command's output) with its time: at the bottom right,
// beside the last line, or on its own line under the text, lined up with it.
// The time's box never shrinks, so a long date can't wrap.
function withReplyTime(
  { Box, Text }: ReturnType<EngineInterface['ui']['resolve']>,
  row: RenderElement,
  label: string,
): RenderElement {
  const time = <Text dimColor size="body">{label}</Text>
  if (isReplyTimeBelow) {
    return (
      <Box flexDirection="column">
        {row}
        <Box key="stamp" flexShrink={0} paddingLeft="xs" marginTop="xs">
          {time}
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
