const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

class VaultError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

const fail = (code, message) => { throw new VaultError(code, message) }
const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()
const cleanText = (value, max = 200) => String(value ?? '').trim().slice(0, max)
const optionalText = (value, max = 1000) => cleanText(value, max)

class VaultService {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath
    this.safeStorage = safeStorage
    this.data = null
    this.masterKey = null
    this.envelope = null
    this.legacyData = null
    this.initialData = null
    this.settingsPath = path.join(path.dirname(filePath), 'settings.json')
    this.settings = { autoLockMinutes: 5, clearClipboardSeconds: 30 }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))
      if ([1, 2, 5, 10, 15, 30].includes(saved.autoLockMinutes)) this.settings.autoLockMinutes = saved.autoLockMinutes
      if ([0, 15, 30, 60].includes(saved.clearClipboardSeconds)) this.settings.clearClipboardSeconds = saved.clearClipboardSeconds
      else if ([300, 900, 1800].includes(saved.clearClipboardSeconds)) this.settings.clearClipboardSeconds = 15
    } catch {}
    if (!fs.existsSync(this.filePath)) {
      this.initialData = this.createDefaultData()
    } else {
      let parsed
      try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) }
      catch { fail('VAULT_CORRUPT', 'The vault could not be read. Its original file was preserved.') }
      if (parsed?.format === 'secretstack-encrypted-v2') this.envelope = parsed
      else this.legacyData = this.validateData(parsed)
    }
  }

  createDefaultData() {
    const group = (name, description) => ({ id: id(), name, description, createdAt: now(), updatedAt: now() })
    return { schemaVersion: 1, groups: [
      group('LLM / AI Keys', 'AI model and provider credentials'),
      group('Storage / Media', 'Media and storage services'),
      group('Databases', 'Database credentials and connection strings'),
      group('Cloud Services', 'Cloud platform credentials'),
      group('Other', 'Other development secrets')
    ], secrets: [] }
  }

  validateData(parsed) {
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.groups) || !Array.isArray(parsed.secrets)) fail('VAULT_INVALID', 'The vault format is invalid.')
    const groups = new Set(parsed.groups.map(g => g.id))
    if (groups.size !== parsed.groups.length || parsed.groups.some(g => !g || typeof g.id !== 'string' || typeof g.name !== 'string')) fail('VAULT_INVALID', 'The vault contains invalid group data.')
    const secrets = new Set()
    for (const s of parsed.secrets) {
      if (!s || typeof s.id !== 'string' || typeof s.encryptedValue !== 'string' || !s.metadata || typeof s.metadata.name !== 'string' || !groups.has(s.metadata.groupId) || secrets.has(s.id)) fail('VAULT_INVALID', 'The vault contains invalid secret data.')
      secrets.add(s.id)
    }
    return parsed
  }

  status() {
    return { encryptionAvailable: this.safeStorage.isEncryptionAvailable(), setupRequired: !this.envelope, locked: !this.data,
      autoLockMinutes: this.settings.autoLockMinutes, clearClipboardSeconds: this.settings.clearClipboardSeconds }
  }

  requireUnlocked() {
    if (!this.data || !this.masterKey) fail('VAULT_LOCKED', 'Vault is locked. Unlock it before continuing.')
  }

  writeEnvelope(envelope) {
    const temp = this.filePath + '.tmp'
    let fd
    try {
      fd = fs.openSync(temp, 'w', 0o600)
      fs.writeFileSync(fd, JSON.stringify(envelope, null, 2), 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      try { fs.chmodSync(temp, 0o600) } catch {}
      fs.renameSync(temp, this.filePath)
      try { fs.chmodSync(this.filePath, 0o600) } catch {}
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(temp) } catch {}
      fail('VAULT_WRITE_FAILED', 'The vault could not be saved. Existing vault data was preserved.')
    }
  }

  setupMasterPassword({ password, confirmPassword }) {
    if (this.envelope) fail('ALREADY_CONFIGURED', 'A master password is already configured.')
    if (typeof password !== 'string' || password.length === 0) fail('VALIDATION', 'Enter a master password.')
    if (password !== confirmPassword) fail('PASSWORD_MISMATCH', 'The passwords do not match.')
    if (!this.safeStorage.isEncryptionAvailable()) fail('ENCRYPTION_UNAVAILABLE', 'OS-backed encryption is unavailable; secure vault setup is blocked.')
    const salt = crypto.randomBytes(16)
    const key = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const data = this.legacyData || this.initialData || this.createDefaultData()
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from('secretstack-vault-v2'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
    const envelope = { format: 'secretstack-encrypted-v2', schemaVersion: 2, kdf: 'scrypt', salt: salt.toString('base64'),
      nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), createdAt: now() }
    this.writeEnvelope(envelope)
    this.envelope = envelope; this.legacyData = null; this.initialData = null; this.masterKey = key; this.data = data
    return this.status()
  }

  unlock({ password }) {
    if (!this.envelope) fail('SETUP_REQUIRED', 'Create a master password before unlocking the vault.')
    if (typeof password !== 'string' || !password) fail('VALIDATION', 'Enter your master password.')
    const key = crypto.scryptSync(password, Buffer.from(this.envelope.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(this.envelope.nonce, 'base64'))
      decipher.setAAD(Buffer.from('secretstack-vault-v2'))
      decipher.setAuthTag(Buffer.from(this.envelope.authTag, 'base64'))
      const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(this.envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
      this.data = this.validateData(data); this.masterKey = key
      return this.status()
    } catch {
      key.fill(0)
      fail('BAD_PASSWORD_OR_CORRUPT', 'Password is incorrect or the encrypted vault is damaged. No data was changed.')
    }
  }

  lock() {
    if (this.masterKey) this.masterKey.fill(0)
    this.masterKey = null; this.data = null
    return { locked: true }
  }

  getSettings() { return { ...this.settings } }

  updateSettings({ autoLockMinutes, clearClipboardSeconds }) {
    if (autoLockMinutes !== undefined) {
      if (![1, 2, 5, 10, 15, 30].includes(Number(autoLockMinutes))) fail('VALIDATION', 'Choose a valid auto-lock timeout.')
      this.settings.autoLockMinutes = Number(autoLockMinutes)
    }
    if (clearClipboardSeconds !== undefined) {
      if (![0, 15, 30, 60].includes(Number(clearClipboardSeconds))) fail('VALIDATION', 'Choose a valid clipboard timeout.')
      this.settings.clearClipboardSeconds = Number(clearClipboardSeconds)
    }
    const temp = this.settingsPath + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
    try { fs.chmodSync(temp, 0o600) } catch {}
    fs.renameSync(temp, this.settingsPath)
    return this.getSettings()
  }

  createBackup({ password }) {
    this.requireUnlocked()
    if (typeof password !== 'string' || password.length < 12) fail('WEAK_PASSWORD', 'Backup password must contain at least 12 characters.')
    const salt = crypto.randomBytes(16)
    const key = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const portableData = JSON.parse(JSON.stringify(this.data))
    for (const secret of portableData.secrets) {
      try { secret.encryptedValue = this.safeStorage.decryptString(Buffer.from(secret.encryptedValue, 'base64')) }
      catch { key.fill(0); fail('BACKUP_FAILED', 'A secret could not be prepared for backup. No backup was exported.') }
    }
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from('secretstack-backup-v1'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ schemaVersion: 1, data: portableData }), 'utf8'), cipher.final()])
    const backup = { format: 'secretstack-backup-v1', kdf: 'scrypt', salt: salt.toString('base64'), nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    key.fill(0)
    return backup
  }

  previewBackup(backup, password) {
    this.requireUnlocked()
    if (!backup || backup.format !== 'secretstack-backup-v1' || backup.kdf !== 'scrypt' || typeof backup.salt !== 'string' ||
      typeof backup.nonce !== 'string' || typeof backup.authTag !== 'string' || typeof backup.ciphertext !== 'string' || backup.ciphertext.length > 100000000) fail('BACKUP_INVALID', 'This is not a supported encrypted backup.')
    const key = crypto.scryptSync(password, Buffer.from(backup.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(backup.nonce, 'base64'))
      decipher.setAAD(Buffer.from('secretstack-backup-v1'))
      decipher.setAuthTag(Buffer.from(backup.authTag, 'base64'))
      const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
      const data = this.validateData(parsed.data)
      return { groupCount: data.groups.length, secretCount: data.secrets.length }
    } catch { fail('BACKUP_INVALID', 'Backup password is incorrect or the backup is damaged.') }
    finally { key.fill(0) }
  }

  restoreBackup({ backup, password }) {
    this.requireUnlocked()
    if (!backup || backup.format !== 'secretstack-backup-v1' || backup.kdf !== 'scrypt' || typeof backup.salt !== 'string' ||
      typeof backup.nonce !== 'string' || typeof backup.authTag !== 'string' || typeof backup.ciphertext !== 'string' || backup.ciphertext.length > 100000000) fail('BACKUP_INVALID', 'This is not a supported encrypted SecretStack backup.')
    if (typeof password !== 'string' || !password) fail('VALIDATION', 'Enter the backup password.')
    const key = crypto.scryptSync(password, Buffer.from(backup.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    let restored
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(backup.nonce, 'base64'))
      decipher.setAAD(Buffer.from('secretstack-backup-v1'))
      decipher.setAuthTag(Buffer.from(backup.authTag, 'base64'))
      const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
      restored = this.validateData(parsed.data)
    } catch { key.fill(0); fail('BACKUP_INVALID', 'Backup password is incorrect or the backup is damaged. Current vault was not changed.') }
    key.fill(0)
    for (const secret of restored.secrets) {
      if (typeof secret.encryptedValue !== 'string' || !secret.encryptedValue) fail('BACKUP_INVALID', 'Backup secret data is invalid. Current vault was not changed.')
      secret.encryptedValue = this.safeStorage.encryptString(secret.encryptedValue).toString('base64')
    }
    const previous = this.data
    this.data = restored
    try { this.persist() } catch (error) { this.data = previous; throw error }
    return { restored: true, groupCount: restored.groups.length, secretCount: restored.secrets.length }
  }

  ensureLoaded() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      fail('ENCRYPTION_UNAVAILABLE', 'Secure OS-backed encryption is unavailable. Vault writes are disabled.')
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    if (!fs.existsSync(this.filePath)) {
      this.data = {
        schemaVersion: 1,
        groups: [
          { id: id(), name: 'LLM / AI Keys', description: 'AI model and provider credentials', createdAt: now(), updatedAt: now() },
          { id: id(), name: 'Storage / Media', description: 'Media and storage services', createdAt: now(), updatedAt: now() },
          { id: id(), name: 'Databases', description: 'Database credentials and connection strings', createdAt: now(), updatedAt: now() },
          { id: id(), name: 'Cloud Services', description: 'Cloud platform credentials', createdAt: now(), updatedAt: now() },
          { id: id(), name: 'Other', description: 'Other development secrets', createdAt: now(), updatedAt: now() }
        ],
        secrets: []
      }
      this.persist()
      return
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.groups) || !Array.isArray(parsed.secrets)) {
        fail('VAULT_INVALID', 'The vault format is invalid. The original file was left unchanged.')
      }
      const groupIds = new Set()
      for (const group of parsed.groups) {
        if (!group || typeof group.id !== 'string' || typeof group.name !== 'string' || groupIds.has(group.id)) {
          fail('VAULT_INVALID', 'The vault contains invalid group data. The original file was left unchanged.')
        }
        groupIds.add(group.id)
      }
      const secretIds = new Set()
      for (const secret of parsed.secrets) {
        if (!secret || typeof secret.id !== 'string' || typeof secret.encryptedValue !== 'string' ||
          !secret.metadata || typeof secret.metadata.name !== 'string' ||
          !groupIds.has(secret.metadata.groupId) || secretIds.has(secret.id)) {
          fail('VAULT_INVALID', 'The vault contains invalid secret data. The original file was left unchanged.')
        }
        secretIds.add(secret.id)
      }
      this.data = parsed
    } catch (error) {
      if (error instanceof VaultError) throw error
      fail('VAULT_CORRUPT', 'The vault could not be read. Its original file was preserved; do not delete it.')
    }
  }

  persist() {
    this.requireUnlocked()
    if (!this.safeStorage.isEncryptionAvailable()) {
      fail('ENCRYPTION_UNAVAILABLE', 'Secure OS-backed encryption is unavailable. Vault writes are disabled.')
    }
    const tempPath = this.filePath + '.tmp'
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, nonce)
    cipher.setAAD(Buffer.from('secretstack-vault-v2'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()])
    const content = JSON.stringify({ ...this.envelope, nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: now() }, null, 2)
    let fd
    try {
      fd = fs.openSync(tempPath, 'w', 0o600)
      fs.writeFileSync(fd, content, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      try { fs.chmodSync(tempPath, 0o600) } catch {}
      fs.renameSync(tempPath, this.filePath)
      try { fs.chmodSync(this.filePath, 0o600) } catch {}
      this.envelope = JSON.parse(content)
    } catch {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch {}
      }
      try { fs.unlinkSync(tempPath) } catch {}
      fail('VAULT_WRITE_FAILED', 'The vault could not be saved. Existing vault data was not intentionally replaced.')
    }
  }

  safeGroup(group) {
    return { ...group, secretCount: this.data.secrets.filter(s => s.metadata.groupId === group.id).length }
  }

  listGroups() {
    this.requireUnlocked()
    return this.data.groups.map(group => this.safeGroup(group))
  }

  requireGroup(groupId) {
    const group = this.data.groups.find(item => item.id === groupId)
    if (!group) fail('GROUP_NOT_FOUND', 'Select a valid group.')
    return group
  }

  createGroup({ name, description }) {
    this.requireUnlocked()
    const normalized = cleanText(name, 80)
    if (!normalized) fail('VALIDATION', 'Group name is required.')
    if (this.data.groups.some(group => group.name.toLowerCase() === normalized.toLowerCase())) {
      fail('DUPLICATE_GROUP', 'A group with that name already exists.')
    }
    const timestamp = now()
    const group = { id: id(), name: normalized, description: optionalText(description), createdAt: timestamp, updatedAt: timestamp }
    this.data.groups.push(group)
    this.persist()
    return this.safeGroup(group)
  }

  updateGroup({ id: groupId, name, description }) {
    this.requireUnlocked()
    const group = this.requireGroup(groupId)
    const normalized = cleanText(name, 80)
    if (!normalized) fail('VALIDATION', 'Group name is required.')
    if (this.data.groups.some(item => item.id !== groupId && item.name.toLowerCase() === normalized.toLowerCase())) {
      fail('DUPLICATE_GROUP', 'A group with that name already exists.')
    }
    group.name = normalized
    group.description = optionalText(description)
    group.updatedAt = now()
    this.persist()
    return this.safeGroup(group)
  }

  deleteGroup({ id: groupId, mode, targetGroupId }) {
    this.requireUnlocked()
    const group = this.requireGroup(groupId)
    const members = this.data.secrets.filter(secret => secret.metadata.groupId === groupId)
    if (members.length && mode === 'move') {
      if (!targetGroupId || targetGroupId === groupId) fail('VALIDATION', 'Choose a different destination group.')
      this.requireGroup(targetGroupId)
      for (const secret of members) {
        secret.metadata.groupId = targetGroupId
        secret.metadata.updatedAt = now()
      }
    } else if (members.length && mode === 'delete') {
      this.data.secrets = this.data.secrets.filter(secret => secret.metadata.groupId !== groupId)
    } else if (members.length) {
      fail('GROUP_NOT_EMPTY', 'This group contains secrets. Move or explicitly delete them before deleting the group.')
    }
    this.data.groups = this.data.groups.filter(item => item.id !== groupId)
    this.persist()
    return { deleted: true }
  }

  safeMetadata(secret) {
    // The renderer needs the opaque record ID to select a secret and invoke
    // copy/update/delete IPC handlers. Never include encryptedValue or plaintext.
    return { id: secret.id, ...secret.metadata }
  }

  listSecrets({ groupId, query } = {}) {
    this.requireUnlocked()
    const needle = cleanText(query, 200).toLowerCase()
    return this.data.secrets
      .filter(secret => !groupId || secret.metadata.groupId === groupId)
      .filter(secret => {
        const m = secret.metadata
        const searchable = [m.name, m.provider, m.description, ...(m.tags || []), m.metadata?.endpoint, m.metadata?.projectName]
          .filter(Boolean).join(' ').toLowerCase()
        return !needle || searchable.includes(needle)
      })
      .sort((a, b) => b.metadata.updatedAt.localeCompare(a.metadata.updatedAt))
      .map(secret => this.safeMetadata(secret))
  }

  assertNoDuplicate(name, groupId, exceptId) {
    const duplicate = this.data.secrets.some(secret => secret.id !== exceptId &&
      secret.metadata.groupId === groupId && secret.metadata.name.toLowerCase() === name.toLowerCase())
    if (duplicate) fail('DUPLICATE_SECRET', 'A secret with that name already exists in this group.')
  }

  encrypt(value) {
    if (!this.safeStorage.isEncryptionAvailable()) fail('ENCRYPTION_UNAVAILABLE', 'Secure encryption is unavailable.')
    return this.safeStorage.encryptString(value).toString('base64')
  }

  createSecret({ name, groupId, provider, description, tags, value, metadata }) {
    this.requireUnlocked()
    const normalizedName = cleanText(name, 120)
    if (!normalizedName) fail('VALIDATION', 'Secret name is required.')
    if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', 'Secret value is required.')
    if (value.length > 20000) fail('VALIDATION', 'Secret value is too long.')
    this.requireGroup(groupId)
    this.assertNoDuplicate(normalizedName, groupId)
    const timestamp = now()
    const record = {
      id: id(),
      metadata: {
        name: normalizedName,
        groupId,
        provider: cleanText(provider, 120),
        description: optionalText(description),
        tags: Array.isArray(tags) ? [...new Set(tags.map(tag => cleanText(tag, 40)).filter(Boolean))].slice(0, 20) : [],
        metadata: {
          endpoint: optionalText(metadata?.endpoint, 300),
          projectName: optionalText(metadata?.projectName, 120)
        },
        createdAt: timestamp,
        updatedAt: timestamp
      },
      encryptedValue: this.encrypt(value)
    }
    this.data.secrets.push(record)
    this.persist()
    return this.safeMetadata(record)
  }

  updateSecret({ id: secretId, name, groupId, provider, description, tags, value, replaceValue, metadata }) {
    this.requireUnlocked()
    const record = this.data.secrets.find(secret => secret.id === secretId)
    if (!record) fail('SECRET_NOT_FOUND', 'The selected secret no longer exists.')
    const normalizedName = cleanText(name, 120)
    if (!normalizedName) fail('VALIDATION', 'Secret name is required.')
    this.requireGroup(groupId)
    this.assertNoDuplicate(normalizedName, groupId, secretId)
    if (replaceValue) {
      if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', 'Enter a replacement value or turn off Replace secret value.')
      if (value.length > 20000) fail('VALIDATION', 'Secret value is too long.')
      record.encryptedValue = this.encrypt(value)
    }
    record.metadata = {
      ...record.metadata,
      name: normalizedName,
      groupId,
      provider: cleanText(provider, 120),
      description: optionalText(description),
      tags: Array.isArray(tags) ? [...new Set(tags.map(tag => cleanText(tag, 40)).filter(Boolean))].slice(0, 20) : [],
      metadata: {
        endpoint: optionalText(metadata?.endpoint, 300),
        projectName: optionalText(metadata?.projectName, 120)
      },
      updatedAt: now()
    }
    this.persist()
    return this.safeMetadata(record)
  }

  moveSecret({ id: secretId, groupId }) {
    this.requireUnlocked()
    const record = this.data.secrets.find(secret => secret.id === secretId)
    if (!record) fail('SECRET_NOT_FOUND', 'The selected secret no longer exists.')
    this.requireGroup(groupId)
    record.metadata.groupId = groupId
    record.metadata.updatedAt = now()
    this.persist()
    return this.safeMetadata(record)
  }

  deleteSecret(secretId) {
    this.requireUnlocked()
    const before = this.data.secrets.length
    this.data.secrets = this.data.secrets.filter(secret => secret.id !== secretId)
    if (before === this.data.secrets.length) fail('SECRET_NOT_FOUND', 'The selected secret no longer exists.')
    this.persist()
    return { deleted: true }
  }

  getSecretValueForCopy(secretId) {
    this.requireUnlocked()
    const record = this.data.secrets.find(secret => secret.id === secretId)
    if (!record) fail('SECRET_NOT_FOUND', 'The selected secret no longer exists.')
    try {
      return this.safeStorage.decryptString(Buffer.from(record.encryptedValue, 'base64'))
    } catch {
      fail('DECRYPT_FAILED', 'The secret could not be decrypted. No secret value was exposed.')
    }
  }
}

module.exports = { VaultService, VaultError }