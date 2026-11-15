import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

export function formatStamp(local: number, localNow: number): string {
  const d = new Date(local)
  const now = new Date(localNow)
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  if (sameDay) return time
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? `${day}, ${time}`
    : `${day} ${d.getUTCFullYear()}, ${time}`
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
  const out = JSON.parse(ran.stdout) as { tz: number; rows: Stamps; finals: string[] }
  await update($, tzOffset, () => out.tz)
  await update($, stamps, current => ({ ...current, ...out.rows }))
  await update($, finals, () => out.finals)
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

export const register: Register = on => {
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
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const at = lookup(await read($, stamps), e.requestId)
    const row = await next(e)
    if (at === undefined) {
      retryLater()
      return row
    }
    const { Box, Text } = $.ui.resolve(e)
    const now = await localNow($)
    const stamp = <Text dimColor>{formatStamp(at, now)}</Text>
    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column">
          {row}
          {stamp}
        </Box>
      )
    }
    // The keyed Box is the hover area; the time takes no room (absolute) and
    // stays hidden until the pointer is over the message.
    return (
      <Box key={`prompt-${e.requestId}`} flexDirection="column">
        {row}
        <Box
          position="absolute"
          bottom={0}
          right={hoverToolbarWidth(now - at)}
          display="none"
          hover={{ display: 'flex' }}
        >
          {stamp}
        </Box>
      </Box>
    )
  })

  // Claude's reply: one time per turn, at the bottom right of the last block of
  // text the turn wrote (while a turn runs, its latest block so far). Not on
  // the app's button row under it: a mod can't add to that row, and the
  // desktop clips anything drawn outside the message's own area.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const msgId = e.requestId.replace(/-t\d+$/, '')
    const map = await read($, stamps)
    const known = lookup(map, e.requestId)
    const row = await next(e)
    let at: number | undefined
    if (known !== undefined) {
      // Saved already: shown only if it's its turn's last block of text.
      if ((await read($, finals)).includes(msgId)) at = known
    } else {
      // Not in the transcript file yet, so it's the newest reply: show the
      // live time Claude last wrote text, and have the file reread.
      retryLater()
      if (Object.keys(map).length > 0) at = (await read($, latestAt)) ?? undefined
    }
    if (at === undefined) return row
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="flex-end" gap="sm">
        <Box flexGrow={1} flexShrink={1}>
          {row}
        </Box>
        <Text dimColor>{formatStamp(at, await localNow($))}</Text>
      </Box>
    )
  })

  // A slash command's output (/reload-plugins, /cost, ...): the app treats it
  // like a reply (it gets the copy/pin/"Just now" row), so it gets a time too,
  // at its bottom right.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const at = (await read($, stamps))[e.requestId]
    const row = await next(e)
    if (at === undefined) {
      retryLater()
      return row
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="flex-end" gap="sm">
        <Box flexGrow={1} flexShrink={1}>
          {row}
        </Box>
        <Text dimColor>{formatStamp(at, await localNow($))}</Text>
      </Box>
    )
  })
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
// reaches ("✓✓ <age> · copy · rewind"), in cells, so your hovered time sits
// just left of it. The width follows the app's age label: "Just now" in the
// first minute, then up to "59 minutes ago" / "23 hours ago" / a date.
// Measured: 20 fits "Just now"; "5 minutes ago" needs ~23.
function hoverToolbarWidth(ageMs: number): number {
  if (ageMs < 60_000) return HOVER_TOOLBAR_JUST_NOW
  return HOVER_TOOLBAR_LONGEST
}
const HOVER_TOOLBAR_JUST_NOW = 20
const HOVER_TOOLBAR_LONGEST = 25
