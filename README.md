# Message timestamps for Claude Code

The Claude Code desktop app labels messages with how long ago they were sent ("Just now", "2 hours ago"), and you have to hover over that small label to see the actual time. The terminal shows no time at all. This mod puts the time where you can see it.

![Illustration: your message shows its time on hover, and Claude's answer shows the time it finished at its bottom right](docs/preview.svg)

## What you'll see

- Each of Claude's answers gets a grey time at its bottom right, where the answer ends, so you can see when it finished without hovering. It shows up as soon as the answer does. In Settings you can move it to its own line under the answer.
- The output of slash commands like `/reload-plugins` or `/cost` gets a time in the same spot.
- Your own messages show their time as soon as your pointer is anywhere over them, just left of the app's own label, which is quicker than aiming at the label and waiting for its tooltip. You can turn this off in Settings.
- In the terminal, your messages get their time on the line underneath.

Times follow your computer's time zone. With the default 24-hour clock they look like this:

| Sent | Shown as |
| --- | --- |
| Today | `23:21` |
| Earlier this year | `2 Oct, 08:05` |
| A previous year | `2 Oct 2025, 08:05` |

With the 12-hour setting, the same times read `11:21 PM` and `2 Oct, 8:05 AM`.

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
| `reply_time`, where the time on Claude's answers goes | `bottom right` or `below` (on its own line under the answer) | `bottom right` |
| `hover_time`, the time on hover over your own messages | `true` or `false` | `true` |

The desktop app has no settings screen for mods, so how you change these depends on what you have installed. Restart Claude Code after any change.

**With Claude Code in a terminal:** type `/plugin configure message-timestamps@zzx-007-d` in a session and pick the values from the menu.

**With the `claude` command on your command line:** for example, to switch to the 12-hour clock and turn the hover time off, in PowerShell, macOS or Linux:

```
echo '{"clock":"12-hour","hover_time":"false"}' | claude plugin configure message-timestamps@zzx-007-d --values-stdin
```

In the Windows Command Prompt, leave out the single quotes. Leave out a setting to keep its current value.

**With only the desktop app:** the `claude` command usually isn't available, so edit your settings file instead. Open `.claude/settings.json` in your home folder (on Windows, `C:\Users\<you>\.claude\settings.json`) and add this inside the outermost `{ }`, with a comma after the entry before it:

```json
"pluginConfigs": {
  "message-timestamps@zzx-007-d": {
    "options": { "clock": "12-hour", "hover_time": false }
  }
}
```

If the file already has a `pluginConfigs` section, add the `"message-timestamps@zzx-007-d"` part inside it instead.

## Privacy

To find the times of older messages, the mod runs a small Node.js script (`scripts/backfill.cjs`) that reads the conversation history Claude Code saves in your `.claude` folder. It looks up and reads only the current session's file, writes nothing, and sends nothing over the network. All of the mod's code is in this repository.

## What you need

- Claude Code with mod support. It was built and tested on version 2.1.325, and versions before 2.1.271 can't load it because of how its settings are declared. Mods are an early-access feature, so a future Claude Code update could break this one.
- Node.js, which the mod uses to read times of older messages. Without it, only messages sent after a session starts get a time.
- A Code tab session, in the desktop app or the terminal. The regular Chat tab doesn't run mods.

## Turning it off

```
claude plugin disable message-timestamps@zzx-007-d
```

`claude plugin enable message-timestamps@zzx-007-d` turns it back on.

## Known limitations

- The hover time under your messages is positioned to sit just left of the app's own label. The spacing was measured on one screen, so with other window sizes or font settings it can overlap the label or leave a gap. See "Adjusting the position" below.
- The hover time appears as soon as your pointer reaches the message, a moment before the app fades in its own label and buttons. Mods can't delay it to match.
- Claude's time can't go in the row of buttons under its answer (copy, pin, "Just now"). The app draws that row itself, and mods can't add to it.

## Adjusting the position

If the hover time overlaps the app's label or leaves a gap, change the matching number in `HOVER_TOOLBAR` at the bottom of `hooks/register.tsx`. There's one per kind of label the app shows ("Just now", "5 minutes ago", "3 hours ago", "2 days ago", a date). A bigger number moves the time further left.

A copy installed from GitHub doesn't pick up edits, so first clone this repository, add your clone with `claude plugin marketplace add <folder>`, and install from it. Then edit the file in your clone and type `/reload-plugins`.

To run the tests, use `claude plugin test .` in this folder, and `claude plugin validate .` to check the mod for errors.
