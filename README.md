# Message timestamps for Claude Code

The Claude Code desktop app only tells you how long ago a message was sent ("Just now", "2 hours ago"), and the terminal shows no time at all. This mod adds the actual time.

## What you'll see

- Each of Claude's answers gets a small grey time at its bottom right, where the answer ends. It shows up as soon as the answer does.
- The output of slash commands like `/reload-plugins` or `/cost` gets a time in the same spot.
- Your own messages show their time when you hover over them, just left of the app's own label ("Just now", "5 minutes ago"). In the terminal, the time sits on the line under your message.

Times follow your computer's time zone and use a 24-hour clock:

| Sent | Shown as |
| --- | --- |
| Today | `23:21` |
| Earlier this year | `2 Oct, 08:05` |
| A previous year | `2 Oct 2025, 08:05` |

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

## Privacy

To find the times of older messages, the mod runs a small Node.js script (`scripts/backfill.cjs`) that reads the conversation history Claude Code saves in your `.claude` folder. It looks up and reads only the current session's file, writes nothing, and sends nothing over the network. All of the mod's code is in this repository.

## What you need

- Claude Code with mod support. It was built and tested on version 2.1.325. Mods are an early-access feature, so a future Claude Code update could break this one.
- Node.js, which the mod uses to read times of older messages. Without it, only messages sent after a session starts get a time.
- A Code tab session, in the desktop app or the terminal. The regular Chat tab doesn't run mods.

## Turning it off

```
claude plugin disable message-timestamps@zzx-007-d
```

`claude plugin enable message-timestamps@zzx-007-d` turns it back on.

## Known limitations

- The hover time under your messages is positioned to sit just left of the app's own label. The spacing was measured on one screen, so with other window sizes or font settings it can overlap the label or leave a gap. See "Adjusting it" below.
- Claude's time can't go in the row of buttons under its answer (copy, pin, "Just now"). The app draws that row itself, and mods can't add to it.
- Mods are an early-access Claude Code feature and can change between releases.

## Adjusting it

Both settings are in `hooks/register.tsx`. A copy installed from GitHub doesn't pick up edits, so to change them, clone this repository, add your clone with `claude plugin marketplace add <folder>`, and install from it. After that, edit the files in your clone and type `/reload-plugins`.

- The time format is set in the `formatStamp` function, for example to switch to 12-hour times or add seconds.
- If the hover time overlaps the app's label, change `HOVER_TOOLBAR_JUST_NOW` (for messages under a minute old) or `HOVER_TOOLBAR_LONGEST` (for older ones) at the bottom of the file. A bigger number moves the time further left.

To run the tests, use `claude plugin test .` in this folder, and `claude plugin validate .` to check the mod for errors.
