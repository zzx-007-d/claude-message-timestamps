/** Message id (transcript row uuid or API message id) -> send time, in local-shifted ms. */
export type Stamps = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    'message-timestamps': {
      stamps: Shaped<Stamps>
      /** API message ids of each turn's last text reply: the saved reply blocks given a time. */
      finals: Shaped<string[]>
      /** When Claude last wrote reply text (local-shifted ms), recorded live. */
      latestAt: number | null
      /** API message id of each turn's last text reply -> how long that turn took, in ms. */
      durations: Shaped<Stamps>
      /** The same ids -> how long that turn thought, in ms. */
      thinking: Shaped<Stamps>
      /** The same ids -> how many tokens Claude wrote in that turn. */
      tokens: Shaped<Stamps>
      /** When the newest turn with a prompt started (local-shifted ms), recorded live. */
      promptAt: number | null
      /** Minutes behind UTC, as Date#getTimezoneOffset reports it; null until known. */
      tzOffset: number | null
      /**
       * How much of the context is left before auto-compaction (of the whole
       * window when it's off), as a whole percentage; null until measured.
       */
      contextLeft: number | null
      /**
       * The main conversation's prompt cache: when its last request was sent
       * (real ms since the epoch) and how long the cache holds it, in ms.
       * Null until the first request.
       */
      cache: { at: number; ttlMs: number } | null
      /** Tool call id -> how long the call took to run, in ms. */
      toolTimes: Shaped<Stamps>
    }
  }
}
