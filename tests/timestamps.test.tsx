import { expect, test } from 'claude-code/testing'

// 2026-11-14 22:56 local, kept local-shifted as the mod stores it.
const AT = Date.UTC(2026, 10, 14, 22, 56)
const OLD = Date.UTC(2026, 9, 2, 8, 5)
// Real UTC "now" for a zone 60 minutes ahead of UTC: local 23:30 on the same day.
const NOW_UTC = Date.UTC(2026, 10, 14, 22, 30)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(on: any) {
  on('state.get', (_: unknown, e: { key: string }) =>
    e.key === 'stamps'
      ? { value: { value: { shape: 'stamps-1', value: { u1: AT, msg_old: OLD } }, version: 1 } }
      : e.key === 'finals'
        ? { value: { value: { shape: 'finals-1', value: ['msg_old'] }, version: 1 } }
        : e.key === 'latestAt'
          ? { value: { value: Date.UTC(2026, 10, 14, 23, 21), version: 1 } }
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
