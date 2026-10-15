const { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell } = require('electron')
const path = require('node:path')
const { VaultService, VaultError } = require('./vault-service')

let mainWindow
let vault
let autoLockTimer = null
let lastActivity = Date.now()
let clipboardTimer = null
let copiedClipboardValue = null

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
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = null
  if (copiedClipboardValue !== null) {
    try { if (clipboard.readText() === copiedClipboardValue) clipboard.clear() } catch {}
    copiedClipboardValue = null
  }
  if (vault) vault.lock()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vault:locked', { reason })
}

function registerIpc() {
  const logPath = path.join(app.getPath('userData'), 'secretstack-debug.log')
  const debugLog = (event, details = {}) => {
    try {
      const safeDetails = { ...details }
      delete safeDetails.value
      delete safeDetails.password
      delete safeDetails.secretValue
      require('node:fs').appendFileSync(logPath, JSON.stringify({ time: new Date().toISOString(), event, ...safeDetails }) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch {}
  }
  console.log('[SecretStack debug] Log file:', logPath)
  debugLog('logging-started', { userDataPath: app.getPath('userData') })
  const handle = (channel, callback, options = {}) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (['secrets:list', 'secrets:create', 'secrets:update', 'secrets:delete', 'secrets:copy'].includes(channel)) {
        debugLog('ipc-request', { channel, id: payload?.id, name: payload?.name, groupId: payload?.groupId, filePath: vault?.filePath })
      }
      if (event.sender !== mainWindow?.webContents) {
        throw new Error('Untrusted IPC sender')
      }
      try {
        if (!options.public) { vault.requireUnlocked(); resetAutoLock() }
        const result = await callback(payload || {})
        if (['secrets:list', 'secrets:create', 'secrets:update', 'secrets:delete', 'secrets:copy'].includes(channel)) {
          debugLog('ipc-success', { channel, id: payload?.id, filePath: vault?.filePath })
        }
        return result
      } catch (error) {
        debugLog('ipc-failure', { channel, code: error?.code, message: error?.message, stack: error?.stack, filePath: vault?.filePath })
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
  handle('secrets:update', ({ id, name, groupId, provider, description, tags, value, replaceValue, metadata }) => {
    debugLog('update-start', { id, name, groupId, replaceValue, filePath: vault.filePath })
    return vault.updateSecret({ id, name, groupId, provider, description, tags, value, replaceValue, metadata })
  })
  handle('secrets:move', ({ id, groupId }) => vault.moveSecret({ id, groupId }))
  handle('secrets:delete', ({ id }) => {
    debugLog('delete-start', { id, filePath: vault.filePath })
    const result = vault.deleteSecret(id)
    debugLog('delete-finished', { id, result, filePath: vault.filePath })
    return result
  })
  handle('secrets:copy', ({ id }) => {
    debugLog('copy-start', { id, filePath: vault.filePath })
    const value = vault.getSecretValueForCopy(id)
    clipboard.writeText(value)
    copiedClipboardValue = value
    if (clipboardTimer) clearTimeout(clipboardTimer)
    const seconds = vault.getSettings().clearClipboardSeconds
    if (seconds > 0) clipboardTimer = setTimeout(() => {
      try { if (clipboard.readText() === value) clipboard.clear() } catch {}
      if (copiedClipboardValue === value) copiedClipboardValue = null
      clipboardTimer = null
    }, seconds * 1000)
    else copiedClipboardValue = null
    return { copied: true, clipboardClearSeconds: seconds }
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
  if (clipboardTimer) clearTimeout(clipboardTimer)
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})