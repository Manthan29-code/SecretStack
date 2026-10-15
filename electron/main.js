const { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { VaultService, VaultError } = require('./vault-service')
const { createClipboardSafety } = require('./clipboard-safety')

let mainWindow
let vault
let autoLockTimer = null
let lastActivity = Date.now()
const clipboardSafety = createClipboardSafety({ clipboard })

function safeError(error) {
  if (error instanceof VaultError) return { code: error.code, message: error.message }
  return { code: 'INTERNAL_ERROR', message: 'The operation could not be completed. No secret values were logged.' }
}

function resetAutoLock() {
  lastActivity = Date.now()
  if (autoLockTimer) clearTimeout(autoLockTimer)
  if (!vault || vault.status().locked) return
  autoLockTimer = setTimeout(() => lockVault('inactivity'), vault.getSettings().autoLockMinutes * 60000)
}
function lockVault(reason = 'manual') {
  if (autoLockTimer) clearTimeout(autoLockTimer)
  autoLockTimer = null
  clipboardSafety.clearNow(reason)
  if (vault) vault.lock()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vault:locked', { reason })
}

function registerIpc() {
  // Remove diagnostic log files left by earlier development builds.
  for (const filename of ['secretstack-debug.log', 'clipboard-auto-clear.log']) {
    try { fs.unlinkSync(path.join(app.getPath('userData'), filename)) } catch {}
  }
  const handle = (channel, callback, options = {}) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (event.sender !== mainWindow?.webContents) {
        throw new Error('Untrusted IPC sender')
      }
      try {
        if (!options.public) { vault.requireUnlocked(); resetAutoLock() }
        return await callback(payload || {})
      } catch (error) {
        const safe = safeError(error)
        const ipcError = new Error(safe.message)
        ipcError.code = safe.code
        throw ipcError
      }
    })
  }

  handle('vault:status', () => ({ ...vault.status(), appName: app.getName() }), { public: true })
  handle('vault:setup', payload => { const result = vault.setupMasterPassword(payload); resetAutoLock(); return result }, { public: true })
  handle('vault:unlock', payload => { const result = vault.unlock(payload); resetAutoLock(); return result }, { public: true })
  handle('vault:lock', () => { lockVault('manual'); return { locked: true } }, { public: true })
  handle('vault:activity', () => { resetAutoLock(); return { ok: true } }, { public: true })
  handle('vault:settings:get', () => vault.getSettings(), { public: true })
  handle('vault:settings:update', payload => { const result = vault.updateSettings(payload); resetAutoLock(); return result }, { public: true })

  handle('groups:list', () => vault.listGroups())
  handle('groups:create', ({ name, description }) => vault.createGroup({ name, description }))
  handle('groups:update', ({ id, name, description }) => vault.updateGroup({ id, name, description }))
  handle('groups:delete', ({ id, mode, targetGroupId }) => vault.deleteGroup({ id, mode, targetGroupId }))

  handle('secrets:list', ({ groupId, query }) => vault.listSecrets({ groupId, query }))
  handle('secrets:create', ({ name, groupId, provider, description, tags, value, metadata }) =>
    vault.createSecret({ name, groupId, provider, description, tags, value, metadata }))
  handle('secrets:update', ({ id, name, groupId, provider, description, tags, value, replaceValue, metadata }) =>
    vault.updateSecret({ id, name, groupId, provider, description, tags, value, replaceValue, metadata }))
  handle('secrets:move', ({ id, groupId }) => vault.moveSecret({ id, groupId }))
  handle('secrets:delete', ({ id }) => vault.deleteSecret(id))
  handle('secrets:copy', ({ id }) => {
    const value = vault.getSecretValueForCopy(id)
    const seconds = vault.getSettings().clearClipboardSeconds
    return clipboardSafety.copy(value, seconds)
  })

  handle('backup:export', async ({ password }) => {
    const backup = vault.createBackup({ password })
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export encrypted backup', defaultPath: 'secretstack-backup.ssbak', filters: [{ name: 'SecretStack backup', extensions: ['ssbak'] }] })
    if (result.canceled || !result.filePath) return { canceled: true }
    const fs = require('node:fs')
    const temp = result.filePath + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(backup, null, 2), { mode: 0o600, flag: 'wx' })
    try { fs.chmodSync(temp, 0o600) } catch {}
    fs.renameSync(temp, result.filePath)
    return { exported: true }
  })
  handle('backup:import', async ({ password }) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Restore encrypted backup', properties: ['openFile'], filters: [{ name: 'SecretStack backup', extensions: ['ssbak'] }] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const fs = require('node:fs')
    let backup
    try {
      if (fs.statSync(result.filePaths[0]).size > 100 * 1024 * 1024) throw new Error()
      backup = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'))
    } catch { const error = new Error('Backup file is invalid or too large.'); error.code = 'BACKUP_INVALID'; throw error }
    const preview = vault.previewBackup(backup, password)
    const confirmation = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Cancel', 'Replace current vault'], defaultId: 0, cancelId: 0,
      title: 'Confirm restore', message: 'Replace the current vault with this backup?',
      detail: preview.groupCount + ' groups and ' + preview.secretCount + ' secrets will be restored.' })
    if (confirmation.response !== 1) return { canceled: true }
    return vault.restoreBackup({ backup, password })
  })
  handle('app:openDataFolder', async () => {
    await shell.openPath(app.getPath('userData'))
    return { opened: true }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#101010',
    title: 'SecretStack',
    icon: path.join(__dirname, '..', 'asset', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== 'file://' && !url.startsWith('file://')) event.preventDefault()
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.secretstack.desktop')
  vault = new VaultService({
    filePath: path.join(app.getPath('userData'), 'vault.json'),
    safeStorage
  })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (vault) vault.lock()
  if (autoLockTimer) clearTimeout(autoLockTimer)
  clipboardSafety.clearNow('app-quit')
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})