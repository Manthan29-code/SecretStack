const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload = {}) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('secretStack', Object.freeze({
  status: () => invoke('vault:status'),
  setupVault: data => invoke('vault:setup', data),
  unlockVault: data => invoke('vault:unlock', data),
  lockVault: () => invoke('vault:lock'),
  activity: () => invoke('vault:activity'),
  getSettings: () => invoke('vault:settings:get'),
  updateSettings: data => invoke('vault:settings:update', data),
  exportBackup: data => invoke('backup:export', data),
  importBackup: data => invoke('backup:import', data),
  onVaultLocked: callback => ipcRenderer.on('vault:locked', (_event, payload) => callback(payload)),
  onVaultStatusUpdated: callback => ipcRenderer.on('vault:status-updated', (_event, payload) => callback(payload)),
  listGroups: () => invoke('groups:list'),
  createGroup: data => invoke('groups:create', data),
  updateGroup: data => invoke('groups:update', data),
  deleteGroup: data => invoke('groups:delete', data),
  listSecrets: data => invoke('secrets:list', data),
  createSecret: data => invoke('secrets:create', data),
  updateSecret: data => invoke('secrets:update', data),
  moveSecret: data => invoke('secrets:move', data),
  deleteSecret: data => invoke('secrets:delete', data),
  copySecret: data => invoke('secrets:copy', data),
  openDataFolder: () => invoke('app:openDataFolder')
}))