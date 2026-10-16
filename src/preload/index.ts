import { contextBridge, ipcRenderer } from 'electron'
import type { EmberAPI } from '../core/types'

const api: EmberAPI = {
  list: () => ipcRenderer.invoke('ember:list'),
  importBundle: () => ipcRenderer.invoke('ember:import'),
  exportSession: (id, format, target) => ipcRenderer.invoke('ember:export', id, format, target),
  copy: text => ipcRenderer.invoke('ember:copy', text),
  onOpenSession: callback => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on('ember:open-session', listener)
    void ipcRenderer.invoke('ember:ready')
    return () => { ipcRenderer.removeListener('ember:open-session', listener) }
  },
}
contextBridge.exposeInMainWorld('ember', api)
