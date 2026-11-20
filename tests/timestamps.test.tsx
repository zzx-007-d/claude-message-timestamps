import { expect, test } from 'claude-code/testing'

// 2026-11-14 22:56 local, kept local-shifted as the mod stores it.
const AT = Date.UTC(2026, 10, 14, 22, 56)
const OLD = Date.UTC(2026, 9, 2, 8, 5)
const PAST = Date.UTC(2025, 9, 2, 8, 5)
const YDAY = Date.UTC(2026, 10, 13, 10, 0)
// Real UTC "now" for a zone 60 minutes ahead of UTC: local 23:30 on the same day.
const NOW_UTC = Date.UTC(2026, 10, 14, 22, 30)

// `durations`: how long each saved turn took; `promptAt`: when the newest turn
// started, recorded live. Both left empty unless a test needs a duration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(on: any, { durations = {}, promptAt = null }: { durations?: Record<string, number>; promptAt?: number | null } = {}) {
  on('state.get', (_: unknown, e: { key: string }) =>
    e.key === 'stamps'
      ? { value: { value: { shape: 'stamps-1', value: { u1: AT, msg_old: OLD, u_past: PAST, u_yday: YDAY, u_same: AT + 60_000 } }, version: 1 } }
      : e.key === 'finals'
        ? { value: { value: { shape: 'finals-1', value: ['msg_old'] }, version: 1 } }
        : e.key === 'durations'
          ? { value: { value: { shape: 'durations-1', value: durations }, version: 1 } }
          : e.key === 'latestAt'
            ? { value: { value: Date.UTC(2026, 10, 14, 23, 21), version: 1 } }
            : e.key === 'promptAt'
              ? { value: { value: promptAt, version: 1 } }
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
    const box = await ui.find({ type: 'Box', key: 'stamp' })
    expect(box?.props.paddingLeft).toBe(isBelow ? 'xs' : undefined)
    await ui.unmount()
  })
}

// How long Claude took: from your prompt to the turn's last block of text.
function mountReply($: { ui: { mount: Function } }, requestId: string) {
  return $.ui.mount({
    plugin: 'message-timestamps',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'hi', isFirstOfReply: true },
  })
}

test('a saved answer shows how long Claude took after its time', async ($, on) => {
  seed(on, { durations: { msg_old: (2 * 60 + 14) * 1000 } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /Oct/ }))?.text).toBe('2 Oct, 08:05 · 2m 14s')
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
  expect((await ui.find({ type: 'Text', text: /Oct/ }))?.text).toBe('2 Oct, 08:05 · 1h 5m')
  await ui.unmount()
})

for (const [ms, shown] of [[59_600, '1m'], [120_000, '2m'], [2 * 3600_000 + 20_000, '2h']] as const) {
  test(`a round duration drops the empty unit: ${shown}`, async ($, on) => {
    seed(on, { durations: { msg_old: ms } })
    const ui = await mountReply($, 'msg_old-t0')
    expect((await ui.find({ type: 'Text', text: /Oct/ }))?.text).toBe(`2 Oct, 08:05 · ${shown}`)
    await ui.unmount()
  })
}

test('turning the duration off shows only the time', { options: { reply_duration: false } }, async ($, on) => {
  seed(on, { durations: { msg_old: 30_000 } })
  const ui = await mountReply($, 'msg_old-t0')
  expect((await ui.find({ type: 'Text', text: /Oct/ }))?.text).toBe('2 Oct, 08:05')
  await ui.unmount()
})

// The "Language" setting: how dates are written.
for (const [language, earlier, previousYear] of [
  ['Italiano', '2 ott, 08:05', '2 ott 2025, 08:05'],
  ['中文', '10月2日 08:05', '2025年10月2日 08:05'],
] as const) {
  test(`dates are written in ${language}`, { options: { language } }, async ($, on) => {
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
