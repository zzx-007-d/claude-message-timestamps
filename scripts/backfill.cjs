'use strict'
// Reads this session's saved transcript and prints the send time of every
// user prompt, assistant text block and slash command output, keyed by row
// uuid and API message id, plus each turn's last reply.
// Usage: node backfill.cjs <session-id>
// Output: {"tz": <minutes behind UTC now>, "rows": {"<id>": <local-shifted ms>},
//          "finals": ["<API message id of a turn's last text reply>", ...],
//          "durations": {"<that id>": <ms from its turn's prompt to its last text>}}
// A message you send while Claude works is saved as an attachment row, not a
// user row, so it joins the running turn instead of starting a new one.

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const shift = ms => ms - new Date(ms).getTimezoneOffset() * 60000

function findTranscript(id) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const base = path.join(home, 'projects')
  if (!fs.existsSync(base)) return null
  for (const dir of fs.readdirSync(base)) {
    const file = path.join(base, dir, `${id}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

const hasText = blocks => blocks.some(b => b && b.type === 'text')

function isShown(row) {
  const content = row.message && row.message.content
  if (row.type === 'user') {
    if (row.isMeta) return false
    if (typeof content === 'string') return true
    return Array.isArray(content) && hasText(content) && !content.some(b => b && b.type === 'tool_result')
  }
  if (row.type === 'assistant') return Array.isArray(content) && hasText(content)
  // A slash command's printed output (/reload-plugins, /cost, ...).
  return row.type === 'system' && row.subtype === 'local_command'
}

async function main() {
  const id = process.argv[2] || ''
  // finals: the API message id of each turn's last text reply (what a turn ended on).
  // durations: the same ids -> how long that turn took (prompt to last text).
  const out = { tz: new Date().getTimezoneOffset(), rows: {}, finals: [], durations: {} }
  const file = /^[0-9a-f-]{8,64}$/i.test(id) ? findTranscript(id) : null
  let lastReply = null
  let promptTime = null
  let lastTextTime = null
  const closeTurn = () => {
    if (lastReply) {
      out.finals.push(lastReply)
      if (promptTime !== null && lastTextTime !== null) out.durations[lastReply] = lastTextTime - promptTime
    }
    lastReply = null
    lastTextTime = null
  }
  if (file) {
    const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.includes('"timestamp"')) continue
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"subtype":"local_command"')) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (!isShown(row)) continue
      const ms = Date.parse(row.timestamp)
      if (Number.isNaN(ms)) continue
      const local = shift(ms)
      if (row.uuid) out.rows[row.uuid] = local
      const msgId = row.message && row.message.id
      if (msgId && !(msgId in out.rows)) out.rows[msgId] = local
      if (row.type === 'user') {
        closeTurn()
        promptTime = local
      } else if (row.type === 'assistant' && msgId) {
        lastReply = msgId
        lastTextTime = local
      }
    }
    closeTurn() // the turn still running: its latest text so far
  }
  process.stdout.write(JSON.stringify(out))
}

main().catch(err => { process.stderr.write(String(err)); process.exit(1) })
