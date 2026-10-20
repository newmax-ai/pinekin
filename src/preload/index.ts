import { contextBridge, ipcRenderer } from 'electron'
import type { StaitheAPI } from '../core/types'

const api: StaitheAPI = {
  platform: process.platform,
  sources: {
    connections: () => ipcRenderer.invoke('pinekin:sources-connections'),
    autoConnect: source => ipcRenderer.invoke('pinekin:sources-auto-connect', source),
    connect: source => ipcRenderer.invoke('pinekin:sources-connect', source),
    refresh: id => ipcRenderer.invoke('pinekin:sources-refresh', id),
    check: query => ipcRenderer.invoke('pinekin:sources-check', query),
    cancel: id => ipcRenderer.invoke('pinekin:sources-cancel', id),
    disconnect: id => ipcRenderer.invoke('pinekin:sources-disconnect', id),
    page: query => ipcRenderer.invoke('pinekin:sources-page', query),
    read: (id, cursor) => ipcRenderer.invoke('pinekin:sources-read', id, cursor),
  },
  sourceActions: {
    prepareHandoffFile: id => ipcRenderer.invoke('pinekin:handoff-file-prepare', id),
    deliverHandoffFile: (token, action) => ipcRenderer.invoke('pinekin:handoff-file-deliver', token, action),
    discardHandoffFile: token => ipcRenderer.invoke('pinekin:handoff-file-discard', token),
    inspect: id => ipcRenderer.invoke('pinekin:source-actions-inspect', id),
    openOriginal: id => ipcRenderer.invoke('pinekin:source-actions-open-original', id),
    exportText: text => ipcRenderer.invoke('pinekin:source-actions-export-text', text),
    inspectTarget: (target, mode) => ipcRenderer.invoke('pinekin:source-actions-inspect-target', target, mode),
    configureTarget: (target, token) => ipcRenderer.invoke('pinekin:source-actions-configure-target', target, token),
    listTargetProjects: (target, id) => ipcRenderer.invoke('pinekin:source-actions-list-target-projects', target, id),
    chooseTargetProject: (target, id, projectId) => ipcRenderer.invoke('pinekin:source-actions-choose-target-project', target, id, projectId),
    continueInTarget: (id, target, destination) => ipcRenderer.invoke('pinekin:source-actions-continue-target', id, target, destination),
    inspectCodexTarget: mode => ipcRenderer.invoke('pinekin:source-actions-inspect-codex', mode),
    configureCodex: token => ipcRenderer.invoke('pinekin:source-actions-configure-codex', token),
    listCodexProjects: id => ipcRenderer.invoke('pinekin:source-actions-list-codex-projects', id),
    chooseCodexProject: (id, projectId) => ipcRenderer.invoke('pinekin:source-actions-choose-codex-project', id, projectId),
    continueInCodex: (id, destination) => ipcRenderer.invoke('pinekin:source-actions-continue-codex', id, destination),
    rollbackTargetTransfer: (target, receipt) => ipcRenderer.invoke('pinekin:source-actions-rollback-target', target, receipt),
    rollbackTransfer: receipt => ipcRenderer.invoke('pinekin:source-actions-rollback-transfer', receipt),
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
