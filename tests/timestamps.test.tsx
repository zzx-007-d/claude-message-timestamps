import { expect, test } from 'claude-code/testing'

// 2026-11-14 22:56 local, kept local-shifted as the mod stores it.
const AT = Date.UTC(2026, 10, 14, 22, 56)
const OLD = Date.UTC(2026, 9, 2, 8, 5)
const PAST = Date.UTC(2025, 9, 2, 8, 5)
const YDAY = Date.UTC(2026, 10, 13, 10, 0)
// Real UTC "now" for a zone 60 minutes ahead of UTC: local 23:30 on the same day.
const NOW_UTC = Date.UTC(2026, 10, 14, 22, 30)

// `durations`: how long each saved turn took; `promptAt`: when the newest turn
// started, recorded live; `thinking` and `tokens`: how long each saved turn
// thought and how many tokens it wrote; `stamps`: more send times, for a test
// that needs its own. All left empty unless a test needs them.
type Seed = {
  durations?: Record<string, number>
  promptAt?: number | null
  thinking?: Record<string, number>
  tokens?: Record<string, number>
  stamps?: Record<string, number>
  // The shape the send times were stored under; an older one is dropped.
  stampsShape?: string
  // How much context is left, as last measured.
  contextLeft?: number | null
  // Each turn's last reply, oldest first.
  finals?: string[]
  // How long each tool call took, by its id.
  toolTimes?: Record<string, number>
  // The prompt cache: when its last request was sent and how long it holds.
  cache?: { at: number; ttlMs: number } | null
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(on: any, { durations = {}, promptAt = null, thinking = {}, tokens = {}, stamps = {}, stampsShape = 'stamps-2', contextLeft = null, finals = ['msg_old'], toolTimes = {}, cache = null }: Seed = {}) {
  const sent = { u1: AT, msg_old: OLD, u_past: PAST, u_yday: YDAY, u_same: AT + 60_000, ...stamps }
  on('state.get', (_: unknown, e: { key: string }) =>
    e.key === 'stamps'
      ? { value: { value: { shape: stampsShape, value: sent }, version: 1 } }
      : e.key === 'finals'
        ? { value: { value: { shape: 'finals-1', value: finals }, version: 1 } }
        : e.key === 'durations'
          ? { value: { value: { shape: 'durations-1', value: durations }, version: 1 } }
          : e.key === 'thinking'
          ? { value: { value: { shape: 'thinking-1', value: thinking }, version: 1 } }
          : e.key === 'tokens'
          ? { value: { value: { shape: 'tokens-1', value: tokens }, version: 1 } }
          : e.key === 'latestAt'
            ? { value: { value: Date.UTC(2026, 10, 14, 23, 21), version: 1 } }
            : e.key === 'promptAt'
              ? { value: { value: promptAt, version: 1 } }
              : e.key === 'contextLeft'
                ? { value: { value: contextLeft, version: 1 } }
                : e.key === 'toolTimes'
                ? { value: { value: { shape: 'tools-1', value: toolTimes }, version: 1 } }
                : e.key === 'cache'
                ? { value: { value: cache, version: 1 } }
                : { value: { value: -60, version: 1 } },
  )
  on('clock.now', () => ({ value: NOW_UTC }))
}

test('the newest reply, not yet in the transcript file, shows the live time', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'msg_brand_new-t0',
    props: { text: 'latest', isFirstOfReply: true },
  })
  expect((await ui.find({ type: 'Text', text: /23:21/ }))?.text).toBe('23:21')
  await ui.unmount()
})

test('a prompt on the desktop carries its time in a hover-only box', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  // Drawn display:none, revealed by the surface on hover.
  expect((await ui.find({ type: 'Text', text: /22:56/ }))?.text).toBe('22:56')
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  if (surface === 'terminal') test(`a prompt shows its send time on ${surface}`, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({
      plugin: 'message-timestamps',
      surface,
      component: 'UserMessage',
      requestId: 'u1',
      props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
    })
    expect((await ui.find({ type: 'Text', text: /22:56/ }))?.text).toBe('22:56')
    await ui.unmount()
  })

  test(`a reply block, drawn as <message id>-t<n>, shows its date on ${surface}`, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({
      plugin: 'message-timestamps',
      surface,
      component: 'AssistantMessage',
      requestId: 'msg_old-t2',
      props: { text: 'hi', isFirstOfReply: false },
    })
    expect((await ui.find({ type: 'Text', text: /Oct/ }))?.text).toBe('2 Oct, 08:05')
    await ui.unmount()
  })
}

test('a reply block that is not its turn\'s last gets no time', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'u1-t0',
    props: { text: 'hi', isFirstOfReply: true },
  })
  expect(await ui.find({ type: 'Text', text: /\d\d:\d\d/ })).toBeUndefined()
  await ui.unmount()
})

test('an unknown message is left as drawn', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'nope',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await ui.find({ type: 'Text', text: /\d\d:\d\d/ })).toBeUndefined()
  await ui.unmount()
})

test('a slash command output row shows its time', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'CommandOutput',
    requestId: 'u1',
    props: { command: 'reload-plugins', args: '', text: 'Reloaded: 3 plugins', isErrored: false },
  })
  expect((await ui.find({ type: 'Text', text: /22:56/ }))?.text).toBe('22:56')
  await ui.unmount()
})

test('the 12-hour clock setting shows AM/PM', { options: { clock: '12-hour' } }, async ($, on) => {
  seed(on)
  const reply = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'msg_old-t0',
    props: { text: 'hi', isFirstOfReply: true },
  })
  expect((await reply.find({ type: 'Text', text: /Oct/ }))?.text).toBe('2 Oct, 8:05 AM')
  await reply.unmount()
  const prompt = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await prompt.find({ type: 'Text', text: /PM/ }))?.text).toBe('10:56 PM')
  await prompt.unmount()
})

test('turning the hover time off leaves your messages as the app draws them', { options: { hover_time: false } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await ui.find({ type: 'Text', text: /\d\d:\d\d/ })).toBeUndefined()
  await ui.unmount()
})

for (const [setting, isBelow] of [[undefined, false], ['below', true]] as const) {
  test(`Claude's time goes ${isBelow ? 'under the answer' : 'at its bottom right'} with reply_time ${setting ?? 'unset'}`, { options: setting ? { reply_time: setting } : {} }, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({
      plugin: 'message-timestamps',
      surface: 'desktop',
      component: 'AssistantMessage',
      requestId: 'msg_old-t0',
      props: { text: 'hi', isFirstOfReply: true },
    })
    // Under the answer, the time sits on its own line at the right edge.
    const line = (await ui.findAll({ type: 'Box' })).find(box => box.props.justifyContent === 'flex-end')
    expect(line !== undefined).toBe(isBelow)
    expect(await ui.find({ type: 'Box', key: 'stamp' })).toBeDefined()
    await ui.unmount()
  })
}

// How long Claude took: from your prompt to the turn's last block of text.
// Its prompt was the same day, already named above, so the time has no date.
function mountReply($: { ui: { mount: Function } }, requestId: string, surface: 'desktop' | 'terminal' = 'desktop') {
  return $.ui.mount({
    plugin: 'message-timestamps',
    surface,
    component: 'AssistantMessage',
    requestId,
    props: { text: 'hi', isFirstOfReply: true },
  })
}

test('a saved answer shows how long Claude took after its time', async ($, on) => {
  seed(on, { durations: { msg_old: (2 * 60 + 14) * 1000 } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('08:05 · 2m 14s')
  await ui.unmount()
})

test('the newest answer shows how long it has taken so far', async ($, on) => {
  seed(on, { promptAt: Date.UTC(2026, 10, 14, 23, 20, 15) })
  const ui = await mountReply($, 'msg_brand_new-t0')
  expect((await ui.find({ type: 'Text', text: /23:21/ }))?.text).toBe('23:21 · 45s')
  await ui.unmount()
})

test('a turn of an hour or more shows hours and minutes', async ($, on) => {
  seed(on, { durations: { msg_old: (65 * 60 + 30) * 1000 } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('08:05 · 1h 5m')
  await ui.unmount()
})

for (const [ms, shown] of [[59_600, '1m'], [120_000, '2m'], [2 * 3600_000 + 20_000, '2h']] as const) {
  test(`a round duration drops the empty unit: ${shown}`, async ($, on) => {
    seed(on, { durations: { msg_old: ms } })
    const ui = await mountReply($, 'msg_old-t0')
    expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe(`08:05 · ${shown}`)
    await ui.unmount()
  })
}

test('turning the duration off shows only the time', { options: { reply_duration: false } }, async ($, on) => {
  seed(on, { durations: { msg_old: 30_000 } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('08:05')
  await ui.unmount()
})

// How hard Claude worked: how long it thought and how many tokens it wrote.
// Off unless the setting turns it on. On, the time goes on its own line under
// the answer, with the details before it; the terminal, with no pointer,
// always shows them.
type Drawn = { type: string; props?: Record<string, unknown>; hover?: { display?: string }; children?: unknown[] }
async function drawn($: { ui: { mount: Function } }, surface: 'desktop' | 'terminal') {
  const ui = await mountReply($, 'msg_old-t0', surface)
  const texts: { text: string }[] = await ui.findAll({ type: 'Text' })
  const boxes: { key?: string; props: Record<string, unknown>; children: unknown[] }[] = await ui.findAll({ type: 'Box' })
  await ui.unmount()
  return { texts: texts.map(t => t.text), boxes }
}

const WORKED = { durations: { msg_old: (2 * 60 + 14) * 1000 }, thinking: { msg_old: 40_200 }, tokens: { msg_old: 12_345 } }
const NBSP = ' '
const DETAILS = { options: { reply_details: true } }

test('by default there are no details: the time and duration sit beside the answer', async ($, on) => {
  seed(on, WORKED)
  const { texts, boxes } = await drawn($, 'desktop')
  expect(texts).toEqual(['08:05 · 2m 14s'])
  expect(boxes.find(b => b.props.justifyContent === 'flex-end')).toBeUndefined()
})

test('nothing is drawn over the answer to cover its text', DETAILS, async ($, on) => {
  seed(on, WORKED)
  const { boxes } = await drawn($, 'desktop')
  expect(boxes.find(b => b.props.position === 'absolute')).toBeUndefined()
})

// With the details on, pointing at the time (not the answer) reveals them:
// they sit in the keyed Box that holds the time, which is the hover area.
test('with the details on, the time goes under the answer and pointing at it shows them', DETAILS, async ($, on) => {
  seed(on, WORKED)
  const { texts, boxes } = await drawn($, 'desktop')
  expect(texts).toContain('08:05 · 2m 14s')
  expect(texts).toContain(`thought 40s · 12k tokens ·${NBSP}`)
  expect(boxes.find(b => b.props.justifyContent === 'flex-end')).toBeDefined()
  const box = boxes.find(b => b.key === 'stamp')?.children[0] as Drawn | undefined
  // No key of its own, or it would be its own (hidden) hover area.
  expect(box?.props?.key).toBeUndefined()
  expect(box?.props?.display).toBe('none')
  expect(box?.hover?.display).toBe('flex')
})

test('in the terminal, the details under the answer always show', DETAILS, async ($, on) => {
  seed(on, WORKED)
  const { texts, boxes } = await drawn($, 'terminal')
  expect(texts).toContain(`thought 40s · 12k tokens ·${NBSP}`)
  expect(texts).toContain('08:05 · 2m 14s')
  const box = boxes.find(b => b.key === 'stamp')?.children[0] as Drawn | undefined
  expect(box?.type).toBe('Box')
  expect(box?.props?.display).toBeUndefined()
  expect(box?.hover).toBeUndefined()
})

// In a narrow window a long details line must be able to wrap: only the time
// itself never shrinks.
test('the details under the answer can wrap; the time never shrinks', DETAILS, async ($, on) => {
  seed(on, WORKED)
  const { boxes } = await drawn($, 'terminal')
  const stamp = boxes.find(b => b.key === 'stamp')
  expect(stamp?.props.flexShrink).not.toBe(0)
  const [work, time] = (stamp?.children ?? []) as Drawn[]
  expect(work?.props?.flexShrink).not.toBe(0)
  expect(time?.type).toBe('Box')
  expect(time?.props?.flexShrink).toBe(0)
})

for (const [tokens, shown] of [[850, '850 tokens'], [1_000, '1k tokens'], [1_540, '1.5k tokens'], [2_300_000, '2.3M tokens']] as const) {
  test(`a turn with no thinking shows only its tokens: ${shown}`, DETAILS, async ($, on) => {
    seed(on, { durations: { msg_old: 30_000 }, tokens: { msg_old: tokens } })
    const { texts } = await drawn($, 'terminal')
    expect(texts).toEqual([`${shown} ·${NBSP}`, '08:05 · 30s'])
  })
}

test('how hard Claude worked follows the language setting', { options: { reply_details: true, language: 'Italiano' } }, async ($, on) => {
  seed(on, { durations: { msg_old: 30_000 }, thinking: { msg_old: 5_000 }, tokens: { msg_old: 1_540 } })
  const { texts } = await drawn($, 'terminal')
  expect(texts).toContain(`pensato 5s · 1,5k token ·${NBSP}`)
})

// The "Language" setting: how dates are written. With the separators off, so
// that every time from another day carries its date.
for (const [language, earlier, previousYear] of [
  ['Italiano', '2 ott, 08:05', '2 ott 2025, 08:05'],
  ['中文', '10月2日 08:05', '2025年10月2日 08:05'],
] as const) {
  test(`dates are written in ${language}`, { options: { language, day_separators: false } }, async ($, on) => {
    seed(on)
    const ui = await mountReply($, 'msg_old-t0')
    expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe(earlier)
    await ui.unmount()
    const past = await $.ui.mount({
      plugin: 'message-timestamps',
      surface: 'terminal',
      component: 'UserMessage',
      requestId: 'u_past',
      props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
    })
    expect((await past.find({ type: 'Text', text: /08:05/ }))?.text).toBe(previousYear)
    await past.unmount()
  })
}

test('the 12-hour clock in Chinese puts 上午/下午 before the time', { options: { language: '中文', clock: '12-hour' } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text', text: /10:56/ }))?.text).toBe('下午10:56')
  await ui.unmount()
})

// Day separators: a line above your message when the conversation reaches a
// new day. Stamps in order: u_past (2025), msg_old (Oct), u_yday (yesterday),
// u1 and u_same (today, a minute apart).
async function separatorOf($: { ui: { mount: Function } }, requestId: string, surface: 'desktop' | 'terminal' = 'desktop') {
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface,
    component: 'UserMessage',
    requestId,
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  const text = (await ui.find({ type: 'Text', text: /──/ }))?.text
  await ui.unmount()
  return text
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the first message of a new day gets a separator on ${surface}`, async ($, on) => {
    seed(on)
    expect(await separatorOf($, 'u1', surface)).toBe('── Today ──')
    expect(await separatorOf($, 'u_yday', surface)).toBe('── Yesterday ──')
  })
}

test('a message on the same day as the one before gets no separator', async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u_same')).toBeUndefined()
})

test('an older day is named by its weekday and date', async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u_past')).toBe('── Thu 2 Oct 2025 ──')
})

test('separators follow the language setting', { options: { language: 'Italiano' } }, async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u_yday')).toBe('── Ieri ──')
  expect(await separatorOf($, 'u_past')).toBe('── gio 2 ott 2025 ──')
})

test('separators in Chinese', { options: { language: '中文' } }, async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u1')).toBe('── 今天 ──')
  expect(await separatorOf($, 'u_past')).toBe('── 2025年10月2日 周四 ──')
})

test('separators stay when the hover time is off', { options: { hover_time: false } }, async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u1')).toBe('── Today ──')
})

test('turning separators off removes them', { options: { day_separators: false } }, async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u1')).toBeUndefined()
})

// Pauses: within one day, a message sent an hour or more after the one before
// it (often Claude's last reply) gets a line saying how long the pause was,
// rounded to the nearest hour. Today: a prompt at 09:00, its reply at 09:05,
// then prompts at 09:50 (45 minutes on), 11:10 and 14:30.
const PAUSES = {
  stamps: {
    u_t1: Date.UTC(2026, 10, 14, 9, 0),
    msg_t1: Date.UTC(2026, 10, 14, 9, 5),
    u_t2: Date.UTC(2026, 10, 14, 9, 50),
    u_t3: Date.UTC(2026, 10, 14, 11, 10),
    u_t4: Date.UTC(2026, 10, 14, 14, 30),
  },
}

test('a message after a pause of an hour or more gets a line saying how long', async ($, on) => {
  seed(on, PAUSES)
  expect(await separatorOf($, 'u_t4')).toBe('── 3 hours later ──')
  // 1h 20m rounds to one hour.
  expect(await separatorOf($, 'u_t3')).toBe('── 1 hour later ──')
})

test('a pause under an hour gets no line', async ($, on) => {
  seed(on, PAUSES)
  expect(await separatorOf($, 'u_t2')).toBeUndefined()
})

test('a new day is still named, however long the pause before it', async ($, on) => {
  seed(on, PAUSES)
  expect(await separatorOf($, 'u_t1')).toBe('── Today ──')
})

for (const [language, shown] of [['Italiano', '── 3 ore dopo ──'], ['中文', '── 3 小时后 ──']] as const) {
  test(`pauses are written in ${language}`, { options: { language } }, async ($, on) => {
    seed(on, PAUSES)
    expect(await separatorOf($, 'u_t4')).toBe(shown)
  })
}

// With the separators on, a time leaves out its date when the day is already
// said above it: by the separator over the first message of its day, or by an
// earlier time of the same day. A reply that ran past midnight is the first
// time of its day with no separator over it, so it keeps its date.
async function promptTime($: { ui: { mount: Function } }, requestId: string) {
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  const text = (await ui.find({ type: 'Text', text: /\d\d:\d\d/ }))?.text
  await ui.unmount()
  return text
}

test('your message from another day shows only its time, under the day separator', async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u_yday', 'terminal')).toBe('── Yesterday ──')
  expect(await promptTime($, 'u_yday')).toBe('10:00')
})

test("Claude's answer shows only its time after an earlier message of its day", async ($, on) => {
  seed(on, { stamps: { u_oct: Date.UTC(2026, 9, 2, 8, 0) } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('08:05')
  await ui.unmount()
})

test('an answer that ran past midnight keeps its date', async ($, on) => {
  // Your message at 23:50 on 1 Oct; the answer finished at 08:05 on 2 Oct,
  // the first time of that day, with no separator above it.
  seed(on, { stamps: { u_late: Date.UTC(2026, 9, 1, 23, 50) } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('2 Oct, 08:05')
  await ui.unmount()
})

// The answer's earlier text blocks are stored but never shown with a time, so
// they can't be what says the day: an answer whose prompt was the day before
// keeps its date, even after a text block of its own past midnight.
test('an answer past midnight keeps its date after its own earlier text blocks', async ($, on) => {
  const prompt = Date.UTC(2026, 9, 1, 23, 50)
  seed(on, {
    stamps: { u_late: prompt, msg_mid: Date.UTC(2026, 9, 2, 7, 0) },
    durations: { msg_old: OLD - prompt },
  })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('2 Oct, 08:05 · 8h 15m')
  await ui.unmount()
})

// An answer whose turn started yesterday and finished after midnight today
// keeps its date, though times from today normally have none: nothing else
// above it says the day changed.
test('an answer that ran past midnight into today keeps its date', async ($, on) => {
  const prompt = Date.UTC(2026, 10, 13, 23, 50)
  seed(on, {
    stamps: { u_mid: prompt, msg_old: Date.UTC(2026, 10, 14, 0, 10) },
    durations: { msg_old: 20 * 60_000 },
  })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /00:10/ }))?.text).toBe('14 Nov, 00:10 · 20m')
  await ui.unmount()
})

// Separators are drawn only above your messages in the desktop app and the
// terminal, so elsewhere (VS Code, the phone) times keep their dates.
for (const surface of ['vscode', 'mobile'] as const) {
  test(`on ${surface}, with no separators drawn, an answer keeps its date`, async ($, on) => {
    seed(on, { durations: { msg_old: (2 * 60 + 14) * 1000 } })
    const ui = await $.ui.mount({
      plugin: 'message-timestamps',
      surface,
      component: 'AssistantMessage',
      requestId: 'msg_old-t0',
      props: { text: 'hi', isFirstOfReply: true },
    })
    expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('2 Oct, 08:05 · 2m 14s')
    await ui.unmount()
  })
}

// A slash command's output follows the same rule as an answer.
test('a command output leaves out its date when its day is said above', async ($, on) => {
  seed(on, { stamps: { cmd: Date.UTC(2026, 10, 13, 10, 5) } })
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'CommandOutput',
    requestId: 'cmd',
    props: { command: 'cost', args: '', text: 'Total cost: $0.10', isErrored: false },
  })
  expect((await ui.find({ type: 'Text', text: /10:05/ }))?.text).toBe('10:05')
  await ui.unmount()
})

test('with the separators off, times from another day keep their date', { options: { day_separators: false } }, async ($, on) => {
  seed(on, { stamps: { u_oct: Date.UTC(2026, 9, 2, 8, 0) } })
  expect(await promptTime($, 'u_yday')).toBe('13 Nov, 10:00')
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /08:05/ }))?.text).toBe('2 Oct, 08:05')
  await ui.unmount()
})

// Times read before the fix for compacted chats could include the summary's
// misleading time, and a later read only adds times, never drops them: so the
// old stored times are dropped and read again from the saved chat.
test('times stored by an older version are dropped, to be read again', async ($, on) => {
  seed(on, { stampsShape: 'stamps-1' })
  expect(await separatorOf($, 'u1')).toBeUndefined()
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await ui.find({ type: 'Text', text: /22:56/ })).toBeUndefined()
  await ui.unmount()
})

test('turning separators off removes the pause lines too', { options: { day_separators: false } }, async ($, on) => {
  seed(on, PAUSES)
  expect(await separatorOf($, 'u_t4')).toBeUndefined()
})

// The "Time on your messages" setting set to "above": the time is always
// shown, on a line of its own above your message, aligned with its right edge.
test('with prompt_time above, your time sits on its own line above the message', { options: { prompt_time: 'above' } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'u_same',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  })
  const line = await ui.find({ type: 'Box', key: 'prompt-time' })
  expect(line?.props.justifyContent).toBe('flex-end')
  expect(line?.props.position).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /22:57/ }))?.text).toBe('22:57')
  await ui.unmount()
})

test('with prompt_time above, a day separator still comes first', { options: { prompt_time: 'above' } }, async ($, on) => {
  seed(on)
  expect(await separatorOf($, 'u1')).toBe('── Today ──')
})

// Regression: a long date ("22 Oct, 21:47") beside a wide answer was squeezed
// onto three lines. The time's box must never shrink.
for (const component of ['AssistantMessage', 'CommandOutput'] as const) {
  test(`the time beside a ${component} never shrinks or wraps`, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({
      plugin: 'message-timestamps',
      surface: 'desktop',
      component,
      requestId: component === 'AssistantMessage' ? 'msg_old-t0' : 'u1',
      props:
        component === 'AssistantMessage'
          ? { text: 'a long answer', isFirstOfReply: true }
          : { command: 'cost', args: '', text: 'a long output', isErrored: false },
    })
    const box = await ui.find({ type: 'Box', key: 'stamp' })
    expect(box?.props.flexShrink).toBe(0)
    await ui.unmount()
  })
}

// The time on a saved answer and the context figure after it, as drawn.
// `msg_old` is the newest one saved.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function replyTime($: any, requestId = 'msg_old-t0', surface: 'terminal' | 'desktop' = 'desktop') {
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface,
    component: 'AssistantMessage',
    requestId,
    props: { text: 'an answer', isFirstOfReply: true },
  })
  const time = (await ui.find({ type: 'Text', text: /\d:\d\d/ }))?.text
  const found = await ui.find({ type: 'Text', text: /%/ })
  await ui.unmount()
  const figure = found && { text: found.text.replace(/\u00a0/g, ' '), color: found.props.color, isDim: found.props.dimColor === true }
  return { time, figure }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the newest answer says how much context is left after its time, on ${surface}`, async ($, on) => {
    seed(on, { contextLeft: 62 })
    const { time, figure } = await replyTime($, 'msg_old-t0', surface)
    expect(time).toMatch(/08:05$/)
    expect(figure).toEqual({ text: ' · ◑ 62%', color: undefined, isDim: true })
  })
}

for (const [left, circle] of [[100, '●'], [75, '◕'], [50, '◑'], [25, '◔'], [5, '○']] as const) {
  test(`the circle empties as the context fills: ${left}% left draws ${circle}`, async ($, on) => {
    seed(on, { contextLeft: left })
    expect((await replyTime($)).figure?.text).toBe(` · ${circle} ${left}%`)
  })
}

test('under 25% left the figure turns the warning color', async ($, on) => {
  seed(on, { contextLeft: 20 })
  expect((await replyTime($)).figure).toEqual({ text: ' · ◔ 20%', color: 'warning', isDim: false })
})

test('under 10% left the figure turns the error color', async ($, on) => {
  seed(on, { contextLeft: 8 })
  expect((await replyTime($)).figure).toEqual({ text: ' · ○ 8%', color: 'error', isDim: false })
})

test('an older answer gets no context figure', async ($, on) => {
  seed(on, { contextLeft: 62, stamps: { msg_older: OLD - 60_000 }, finals: ['msg_older', 'msg_old'] })
  const { time, figure } = await replyTime($, 'msg_older-t0')
  expect(time).toMatch(/08:04$/)
  expect(figure).toBeUndefined()
})

test('before the first reading there is no context figure', async ($, on) => {
  seed(on)
  const { time, figure } = await replyTime($)
  expect(time).toMatch(/08:05$/)
  expect(figure).toBeUndefined()
})

test('turning the context figure off removes it', { options: { context_left: false } }, async ($, on) => {
  seed(on, { contextLeft: 62 })
  const { time, figure } = await replyTime($)
  expect(time).toMatch(/08:05$/)
  expect(figure).toBeUndefined()
})

// How full the context is, as the session reports it: `tokens` used of a
// 200k window, and where auto-compaction runs (none when it's off). Returns
// what the mod then keeps as the context left.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usage(on: any, { tokens, threshold }: { tokens?: number; threshold?: number }) {
  const kept: { left?: number } = {}
  on('state.set', (_: unknown, e: { key: string; value: number }) => {
    if (e.key === 'contextLeft') kept.left = e.value
    return { value: { isSet: true, version: 1 } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens,
        window: 200_000,
        breakdown: { totalTokens: 50_000, isAutoCompactEnabled: threshold !== undefined, autoCompactThreshold: threshold },
      },
      rateLimits: {},
      cost: {},
    },
  }))
  on('session.compact', (_: unknown, e: { messages: unknown[] }) => ({ messages: e.messages }))
  return kept
}

// What a compaction leaves: one message holding the summary.
const SUMMARY = { role: 'user' as const, text: 'Summary of the chat so far', toolUses: [] }

test('after a compaction, what is left is measured against the auto-compaction point', async ($, on) => {
  const kept = usage(on, { tokens: 60_000, threshold: 160_000 })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(kept.left).toBe(63)
})

test('with no answer yet to count, the estimate stands in', async ($, on) => {
  const kept = usage(on, { threshold: 160_000 })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(kept.left).toBe(69)
})

test('with auto-compaction off, what is left is measured against the whole window', async ($, on) => {
  const kept = usage(on, { tokens: 60_000 })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(kept.left).toBe(70)
})

test('a compaction only computed ahead measures nothing', async ($, on) => {
  const kept = usage(on, { tokens: 60_000, threshold: 160_000 })
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })
  expect(kept.left).toBeUndefined()
})

// A tool call's row, as drawn, and the time at its right if any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toolRow($: any, props: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'desktop') {
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface,
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'npm test' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'ok', stderr: '' }, ...props },
  })
  const text = (await ui.find({ type: 'Text', text: /^\d+[smh]/ }))?.text
  await ui.unmount()
  return text
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a tool call shows how long it took, on ${surface}`, async ($, on) => {
    seed(on, { toolTimes: { toolu_1: 42_000 } })
    expect(await toolRow($, {}, surface)).toBe('42s')
  })
}

test('a tool call under a second shows no time', async ($, on) => {
  seed(on, { toolTimes: { toolu_1: 300 } })
  expect(await toolRow($)).toBeUndefined()
})

test('a tool call still running shows no time yet', async ($, on) => {
  seed(on, { toolTimes: { toolu_1: 42_000 } })
  expect(await toolRow($, { isRunning: true, output: undefined })).toBeUndefined()
})

test('turning tool times off removes them', { options: { tool_time: false } }, async ($, on) => {
  seed(on, { toolTimes: { toolu_1: 42_000 } })
  expect(await toolRow($)).toBeUndefined()
})

test('a folded run of tool calls shows their times added up', async ($, on) => {
  seed(on, { toolTimes: { toolu_a: 1_500, toolu_b: 2_000, toolu_c: 100 } })
  const call = (id: string) => ({ tool_use_id: id, tool: 'Read', input: { file_path: 'a.ts' }, isRunning: false, isErrored: false, isInterrupted: false })
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'ToolGroup',
    props: { calls: [call('toolu_a'), call('toolu_b'), call('toolu_c')], isActive: false, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text', text: /^\d+[smh]/ }))?.text).toBe('4s')
  await ui.unmount()
})

test('a tool call is timed from when it starts running', async ($, on) => {
  let now = NOW_UTC
  on('clock.now', () => ({ value: (now += 2_500) }))
  const kept: { times?: Record<string, number> } = {}
  on('state.get', () => ({ value: { value: null, version: 0 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    if (e.key === 'toolTimes') kept.times = (e.value as { value: Record<string, number> }).value
    return { value: { isSet: true, version: 1 } }
  })
  on('tool.run', () => ({ result: 'done' }))
  await $.tool.run({ tool: 'Bash', command: 'sleep 2', tool_use_id: 'toolu_live' })
  expect(kept.times).toEqual({ toolu_live: 2_500 })
})

// The cache countdown after the newest answer's time, as drawn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cacheFigure($: any, requestId = 'msg_old-t0') {
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'an answer', isFirstOfReply: true },
  })
  const found = await ui.find({ type: 'Text', text: /cache|缓存/ })
  await ui.unmount()
  return found && { text: found.text.replace(/\u00a0/g, ' '), color: found.props.color }
}

const HOUR = 60 * 60_000

test('the newest answer says how long until the cache expires', async ($, on) => {
  seed(on, { cache: { at: NOW_UTC - 18 * 60_000, ttlMs: HOUR } })
  expect(await cacheFigure($)).toEqual({ text: ' · cache 42m', color: undefined })
})

test('the cache figure comes after the context left', async ($, on) => {
  seed(on, { contextLeft: 62, cache: { at: NOW_UTC - 18 * 60_000, ttlMs: HOUR } })
  const ui = await $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'msg_old-t0',
    props: { text: 'an answer', isFirstOfReply: true },
  })
  const texts: string[] = []
  for (const t of await ui.findAll({ type: 'Text' })) texts.push(t.text.replace(/\u00a0/g, ' '))
  await ui.unmount()
  expect(texts.slice(-3)).toEqual(['2 Oct, 08:05', ' · ◑ 62%', ' · cache 42m'])
})

test('under five minutes left the cache figure turns the warning color', async ($, on) => {
  seed(on, { cache: { at: NOW_UTC - 57 * 60_000, ttlMs: HOUR } })
  expect(await cacheFigure($)).toEqual({ text: ' · cache 3m', color: 'warning' })
})

test('under a minute left it says so', async ($, on) => {
  seed(on, { cache: { at: NOW_UTC - HOUR + 20_000, ttlMs: HOUR } })
  expect((await cacheFigure($))?.text).toBe(' · cache <1m')
})

test('once the cache has expired it says so, in the warning color', async ($, on) => {
  seed(on, { cache: { at: NOW_UTC - 2 * HOUR, ttlMs: HOUR } })
  expect(await cacheFigure($)).toEqual({ text: ' · cache expired', color: 'warning' })
})

test('the cache figure follows the language setting', { options: { language: 'Italiano' } }, async ($, on) => {
  seed(on, { cache: { at: NOW_UTC - 2 * HOUR, ttlMs: HOUR } })
  expect((await cacheFigure($))?.text).toBe(' · cache scaduta')
})

test('an older answer gets no cache figure', async ($, on) => {
  seed(on, { cache: { at: NOW_UTC, ttlMs: HOUR }, stamps: { msg_older: OLD - 60_000 }, finals: ['msg_older', 'msg_old'] })
  expect(await cacheFigure($, 'msg_older-t0')).toBeUndefined()
})

test('turning the cache timer off removes it', { options: { cache_timer: false } }, async ($, on) => {
  seed(on, { cache: { at: NOW_UTC, ttlMs: HOUR } })
  expect(await cacheFigure($)).toBeUndefined()
})

// A request of the main conversation, answered with this cache usage; returns
// what the mod then keeps as the cache.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request($: any, on: any, usage: Record<string, number>, { agentId, before }: { agentId?: string; before?: { at: number; ttlMs: number } } = {}) {
  const kept: { cache?: { at: number; ttlMs: number } } = {}
  on('clock.now', () => ({ value: NOW_UTC }))
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: e.key === 'cache' ? (before ?? null) : null, version: 1 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    if (e.key === 'cache') kept.cache = e.value as { at: number; ttlMs: number }
    return { value: { isSet: true, version: 2 } }
  })
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm', ...usage },
    }
  })
  // The request streams: read it to its end.
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId }));
  return kept.cache
}

test('a request that writes the cache for an hour starts an hour countdown', async ($, on) => {
  expect(await request($, on, { cache_creation_input_tokens: 900, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 })).toEqual({ at: NOW_UTC, ttlMs: HOUR })
})

test('a request that writes it for five minutes starts a five-minute one', async ($, on) => {
  expect(await request($, on, { cache_creation_input_tokens: 900, ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 })).toEqual({ at: NOW_UTC, ttlMs: 5 * 60_000 })
})

test('a request that only reads the cache renews it for as long as before', async ($, on) => {
  expect(await request($, on, { cache_read_input_tokens: 5000 }, { before: { at: NOW_UTC - HOUR, ttlMs: HOUR } })).toEqual({ at: NOW_UTC, ttlMs: HOUR })
})

test("a subagent's request leaves the conversation's cache alone", async ($, on) => {
  expect(await request($, on, { cache_creation_input_tokens: 900, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 }, { agentId: 'a1' })).toBeUndefined()
})
