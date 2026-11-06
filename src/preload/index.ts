import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiChunk,
  ExportPayload,
  HanMacAPI,
  MenuAction,
  SaveHwpxPayload
} from '../shared/types'

const api: HanMacAPI = {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  openPath: (path: string) => ipcRenderer.invoke('file:open-path', path),
  parseBuffer: (data: ArrayBuffer, name: string) =>
    ipcRenderer.invoke('file:parse-buffer', data, name),
  saveHwpx: (payload: SaveHwpxPayload) => ipcRenderer.invoke('file:save-hwpx', payload),
  exportFile: (payload: ExportPayload) => ipcRenderer.invoke('file:export', payload),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  getRecent: () => ipcRenderer.invoke('app:get-recent'),
  aiModels: (provider) => ipcRenderer.invoke('ai:models', provider),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiCancel: (requestId: string) => ipcRenderer.invoke('ai:cancel', requestId),
  onAiChunk: (callback: (chunk: AiChunk) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: AiChunk): void => callback(chunk)
    ipcRenderer.on('ai:chunk', listener)
    return () => ipcRenderer.removeListener('ai:chunk', listener)
  },
  onMenuAction: (callback: (action: MenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void =>
      callback(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },
  setTitle: (title: string, dirty: boolean) =>
    ipcRenderer.send('window:set-title', title, dirty),
  confirmDiscard: () => ipcRenderer.invoke('dialog:confirm-discard'),
  showItemInFolder: (path: string) => ipcRenderer.invoke('shell:show-item', path),
  getVersion: () => ipcRenderer.invoke('app:version'),
  platform: process.platform
}

contextBridge.exposeInMainWorld('hanmac', api)
