import { contextBridge, ipcRenderer } from 'electron'
import type { StaitheAPI } from '../core/types'

const api: StaitheAPI = {
  platform: process.platform,
  sources: {
    connections: () => ipcRenderer.invoke('pinekin:sources-connections'),
    autoConnect: source => ipcRenderer.invoke('pinekin:sources-auto-connect', source),
    connect: source => ipcRenderer.invoke('pinekin:sources-connect', source),
    refresh: id => ipcRenderer.invoke('pinekin:sources-refresh', id),
    cancel: id => ipcRenderer.invoke('pinekin:sources-cancel', id),
    disconnect: id => ipcRenderer.invoke('pinekin:sources-disconnect', id),
    page: query => ipcRenderer.invoke('pinekin:sources-page', query),
    read: id => ipcRenderer.invoke('pinekin:sources-read', id),
  },
  list: () => ipcRenderer.invoke('staithe:list'),
  previewImport: () => ipcRenderer.invoke('staithe:import-preview'),
  confirmImport: token => ipcRenderer.invoke('staithe:import-confirm', token),
  cancelImport: token => ipcRenderer.invoke('staithe:import-cancel', token),
  exportSession: (id, format, target) => ipcRenderer.invoke('staithe:export', id, format, target),
  copy: text => ipcRenderer.invoke('staithe:copy', text),
  onOpenSession: callback => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on('staithe:open-session', listener)
    void ipcRenderer.invoke('staithe:ready')
    return () => { ipcRenderer.removeListener('staithe:open-session', listener) }
  },
}
contextBridge.exposeInMainWorld('staithe', api)
