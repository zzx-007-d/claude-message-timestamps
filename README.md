# Message timestamps for Claude Code

The Claude Code desktop app labels messages with how long ago they were sent ("Just now", "2 hours ago"), and you have to hover over that small label to see the actual time. The terminal shows no time at all. This mod puts the time where you can see it.

![Illustration: your message shows its time on hover, and Claude's answer shows the time it finished at its bottom right](docs/preview.svg)

## What you'll see

- Each of Claude's answers gets a grey time at its bottom right, where the answer ends, so you can see when it finished without hovering. It shows up as soon as the answer does. In Settings you can move it to its own line under the answer, at the right, so it doesn't narrow the answer's text.
- After that time, the answer shows how long Claude took, counted from when you sent your message: `23:21 · 2m 14s`. While Claude is still working, it shows the time so far. You can turn this off in Settings.
- If you turn it on in Settings, the time also shows how hard Claude worked on that answer: how long it thought, and how many tokens it wrote, tool calls included. The time then moves to its own line under the answer, since beside the last line there's no room for more without narrowing the answer or covering its text. In the desktop app the details appear to the left of the time while you point at it, so reading with the pointer over the answer doesn't bring them up: `thought 40s · 12k tokens · 23:21 · 2m 14s`. Outside the desktop app, in the terminal for example, they always show.
- Tokens are the pieces Claude counts text in, about three quarters of a word each; the more Claude writes, the more of your usage it takes. The details appear once the answer is saved, usually a second or two after it shows up. A turn that didn't think shows only its tokens, and work done by subagents isn't counted.
- The output of slash commands like `/reload-plugins` or `/cost` gets a time in the same spot.
- Your own messages show their time as soon as your pointer is anywhere over them, just left of the app's own label, which is quicker than aiming at the label and waiting for its tooltip. If you'd rather see it all the time, a setting puts it on a small line above each message instead. You can also turn it off.
- In the terminal, your messages get their time on the line underneath.
- When a conversation runs into a new day, a line above your first message of that day names it: `── Today ──`, `── Yesterday ──`, or for older days `── Thu 2 Oct ──`. A conversation that has stayed within today gets none. Within a day, when you write again an hour or more after the last message, a line says how long the pause was, to the nearest hour: `── 3 hours later ──`. You can turn both off in Settings.
- Since those lines name each day, times under them leave the date out: after `── Thu 2 Oct ──` you see `08:05`, not `2 Oct, 08:05`. The one exception is an answer that finishes after midnight: no line comes before it on the new day, so it shows its date, even if that day is today. The lines are drawn in the desktop app and the terminal; elsewhere, or with the lines turned off, times from other days show their date as below.
- After the time on Claude's newest answer, a percentage says how much of the context is left before Claude Code compacts the conversation on its own: `23:21 · 2m 14s · ◑ 62%`. The circle empties as the context fills (● ◕ ◑ ◔ ○). It stays grey like the time while there's room, turns yellow under 25% and red under 10%, in your theme's warning and error colors. It's measured when a session opens, after each of Claude's answers and after a compaction, and moves to the newest answer once that's saved. If you've turned auto-compaction off, it's how much of the whole context is left instead. You can turn it off in Settings.
- After that, how long until the conversation's prompt cache expires: `23:21 · 2m 14s · ◑ 62% · cache 42m`. Each message sends Claude the whole conversation, and the parts it has seen in the last while come from a cache, which is cheaper and faster; every message restarts the countdown. If the conversation sits idle past it (usually an hour, sometimes five minutes, which the mod reads from each answer), the cache expires and your next message sends everything again uncached, which uses much more of your limits, the more so the longer the conversation. Under five minutes left the countdown turns yellow, and once it has run out it reads `cache expired`. It counts down a minute at a time. Reopening a conversation later, the mod reads when it last used the cache from the conversation history. You can turn it off in Settings.
- Each command, edit or search Claude runs shows how long it took, in grey at the right of its row, once it's done: `42s`. Calls under a second show nothing, so quick reads and edits stay clean. A folded line like "Read 3 files" shows the calls' times added up. The time counts from when the call starts running, so waiting for your permission isn't included; calls made before you installed the mod are timed from the conversation history, where that wait can't be told apart. You can turn it off in Settings.

Times follow your computer's time zone. With the default 24-hour clock they look like this:

| Sent | Shown as |
| --- | --- |
| Today | `23:21` |
| Earlier this year | `2 Oct, 08:05` |
| A previous year | `2 Oct 2025, 08:05` |

With the 12-hour setting, the same times read `11:21 PM` and `2 Oct, 8:05 AM`.

Dates can also be written in Italian or Chinese:

| Language | This year | A previous year | 12-hour clock | Thinking and tokens |
| --- | --- | --- | --- | --- |
| English | `2 Oct, 08:05` | `2 Oct 2025, 08:05` | `11:21 PM` | `thought 40s · 1.5k tokens` |
| Italiano | `2 ott, 08:05` | `2 ott 2025, 08:05` | `11:21 PM` | `pensato 40s · 1,5k token` |
| 中文 | `10月2日 08:05` | `2025年10月2日 08:05` | `下午11:21` | `思考 40s · 1.5k token` |

Messages sent before you installed the mod get times too. The mod reads them from the conversation history Claude Code already saves on your computer.

## Install

In a terminal session of Claude Code, type:

```
/plugin install message-timestamps --marketplace zzx-007-d/claude-message-timestamps
```

Or from a regular command line:

```
claude plugin install message-timestamps --marketplace zzx-007-d/claude-message-timestamps
```

In the desktop app, `/plugin` doesn't work. Click the + next to the message box, choose Plugins, then Add marketplace, enter `zzx-007-d/claude-message-timestamps`, and click Add plugin.

New sessions pick the mod up on their own. In a session that's already open, type `/reload-plugins`.

To get a newer version later, run `claude plugin update message-timestamps@zzx-007-d` and restart Claude Code.

## Settings

| Setting | Choices | Default |
| --- | --- | --- |
| `clock` | `24-hour` or `12-hour` | `24-hour` |
| `language`, how dates are written | `English`, `Italiano` or `中文` | `English` |
| `reply_time`, where the time on Claude's answers goes | `bottom right` or `below` (on its own line under the answer, at the right) | `bottom right` |
| `reply_duration`, how long Claude took, after the time on its answers | `true` or `false` | `true` |
| `reply_details`, how long Claude thought and how many tokens it wrote, shown when you point at the time; puts the time on its own line under the answer | `true` or `false` | `false` |
| `day_separators`, a line naming the day when a conversation reaches a new one, or saying how long it paused | `true` or `false` | `true` |
| `prompt_time`, where the time on your own messages goes in the desktop app | `on hover` (beside the app's "Just now" label) or `above` (always shown, on its own line above the message) | `on hover` |
| `hover_time`, the time on your own messages in the desktop app | `true` or `false` | `true` |
| `context_left`, how much context is left before auto-compaction, after the time on Claude's newest answer | `true` or `false` | `true` |
| `tool_time`, how long each tool call took, at the right of its row | `true` or `false` | `true` |
| `cache_timer`, how long until the prompt cache expires, after the time on Claude's newest answer | `true` or `false` | `true` |

The desktop app has no settings screen for mods, so how you change these depends on what you have installed. A change applies on its own within a few seconds; if it doesn't, type `/reload-plugins` in the session.

If you use Claude Code in a terminal, type `/plugin configure message-timestamps@zzx-007-d` in a session and pick the values from the menu.

If the `claude` command works on your command line, you can pipe the values to it. This switches to the 12-hour clock and turns the time on your messages off, in PowerShell, macOS or Linux:

```
echo '{"clock":"12-hour","hover_time":"false"}' | claude plugin configure message-timestamps@zzx-007-d --values-stdin
```

In the Windows Command Prompt, leave out the single quotes. Leave out a setting to keep its current value.

If you only have the desktop app, the `claude` command usually isn't available, so edit your settings file instead. Open `.claude/settings.json` in your home folder (on Windows, `C:\Users\<you>\.claude\settings.json`) and add this inside the outermost `{ }`, with a comma after the entry before it:

```json
"pluginConfigs": {
  "message-timestamps@zzx-007-d": {
    "options": { "clock": "12-hour", "hover_time": false }
  }
}
```

If the file already has a `pluginConfigs` section, add the `"message-timestamps@zzx-007-d"` part inside it instead.

## Privacy

To find the times of older messages, the mod reads the conversation history Claude Code saves in your `.claude` folder (`hooks/transcript.ts`). It reads only the current session's file, and after the first read only the lines added since. It writes nothing, starts no other program, and sends nothing over the network. All of the mod's code is in this repository.

## What you need

- Claude Code with mod support. It was built on version 2.1.325 and last tested on 2.1.328. Versions before 2.1.271 can't load it because of how its settings are declared. Mods are an early-access feature, so a future Claude Code update could break this one.
- A Code tab session, in the desktop app or the terminal. The regular Chat tab doesn't run mods.

## Turning it off

```
claude plugin disable message-timestamps@zzx-007-d
```

`claude plugin enable message-timestamps@zzx-007-d` turns it back on.

## Known limitations

- The hover time under your messages is positioned to sit just left of the app's own label. The spacing was measured on one screen, so with other window sizes, font settings or a later version of the app it can overlap the label or leave a gap. See "Adjusting the position" below, or set `prompt_time` to `above`: the time then sits on its own line above your message, where nothing the app draws can move it.
- The hover time appears as soon as your pointer reaches the message, a moment before the app fades in its own label and buttons. Mods can't delay it to match.
- Claude's time can't go in the row of buttons under its answer (copy, pin, "Just now"). The app draws that row itself, and mods can't add to it.

## Adjusting the position

If the hover time overlaps the app's label or leaves a gap, change the matching number in `HOVER_TOOLBAR` at the bottom of `hooks/register.tsx`. There's one per kind of label the app shows ("Just now", "5 minutes ago", "3 hours ago", "2 days ago", a date). A bigger number moves the time further left.

A copy installed from GitHub doesn't pick up edits, so first clone this repository, add your clone with `claude plugin marketplace add <folder>`, and install from it. Then edit the file in your clone and type `/reload-plugins`.

To run the tests, use `claude plugin test .` in this folder, and `claude plugin validate .` to check the mod for errors.
