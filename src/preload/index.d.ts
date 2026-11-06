import type { HanMacAPI } from '../shared/types'

declare global {
  interface Window {
    hanmac: HanMacAPI
  }
}

export {}
