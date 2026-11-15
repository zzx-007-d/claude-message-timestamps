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
      /** Minutes behind UTC, as Date#getTimezoneOffset reports it; null until known. */
      tzOffset: number | null
    }
  }
}
