const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { VaultService } = require('../electron/vault-service')

// A reversible stand-in for Electron safeStorage keeps these service tests independent
// from a running Electron process. It tests service logic, not OS encryption.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value.split('').reverse().join(''), 'utf8'),
  decryptString: buffer => buffer.toString('utf8').split('').reverse().join('')
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secretstack-test-'))
  const service = new VaultService({ filePath: path.join(directory, 'vault.json'), safeStorage: fakeSafeStorage })
  service.setupMasterPassword({ password: 'Ab3!x9', confirmPassword: 'Ab3!x9' })
  return { directory, service, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('accepts any non-empty master password and rejects an empty one', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secretstack-password-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const service = new VaultService({ filePath: path.join(directory, 'vault.json'), safeStorage: fakeSafeStorage })
  assert.throws(() => service.setupMasterPassword({ password: '', confirmPassword: '' }), /enter a master password/i)
  service.setupMasterPassword({ password: 'mantha', confirmPassword: 'mantha' })
  assert.equal(service.status().locked, false)
  service.lock()
  service.unlock({ password: 'mantha' })
  assert.equal(service.status().locked, false)
})

test('creates groups and persists secret values as ciphertext rather than plaintext', t => {
  const f = fixture()
  t.after(f.cleanup)
  const group = f.service.listGroups()[0]
  const secretValue = 'test-secret-value-123'
  const created = f.service.createSecret({ name: 'Test key', groupId: group.id, value: secretValue })
  assert.equal(created.name, 'Test key')
  const fileContent = fs.readFileSync(path.join(f.directory, 'vault.json'), 'utf8')
  assert.equal(fileContent.includes(secretValue), false)
  assert.equal(f.service.listSecrets({})[0].name, 'Test key')
})

test('does not return a saved secret value in list metadata', t => {
  const f = fixture()
  t.after(f.cleanup)
  const group = f.service.listGroups()[0]
  f.service.createSecret({ name: 'Metadata only', groupId: group.id, value: 'never-return-this' })
  assert.equal(JSON.stringify(f.service.listSecrets({})).includes('never-return-this'), false)
})

test('moves secrets when a populated group is deleted with move mode', t => {
  const f = fixture()
  t.after(f.cleanup)
  const groups = f.service.listGroups()
  const secret = f.service.createSecret({ name: 'Movable', groupId: groups[0].id, value: 'secret' })
  f.service.deleteGroup({ id: groups[0].id, mode: 'move', targetGroupId: groups[1].id })
  assert.equal(f.service.listSecrets({})[0].groupId, groups[1].id)
  assert.equal(secret.name, 'Movable')
})

test('refuses to delete a populated group without an explicit policy', t => {
  const f = fixture()
  t.after(f.cleanup)
  const group = f.service.listGroups()[0]
  f.service.createSecret({ name: 'Protected', groupId: group.id, value: 'secret' })
  assert.throws(() => f.service.deleteGroup({ id: group.id }), /contains secrets/i)
})

test('locks vault and rejects secret operations until correct password unlocks it', t => {
  const f = fixture()
  t.after(f.cleanup)
  f.service.lock()
  assert.throws(() => f.service.listSecrets({}), /locked/i)
  assert.throws(() => f.service.unlock({ password: 'incorrect password' }), /incorrect|damaged/i)
  f.service.unlock({ password: 'Ab3!x9' })
  assert.equal(f.service.listSecrets({}).length, 0)
})

test('encrypted backup round-trips data without exposing secret values', t => {
  const f = fixture()
  t.after(f.cleanup)
  const group = f.service.listGroups()[0]
  f.service.createSecret({ name: 'Backup test', groupId: group.id, value: 'backup-private-value' })
  const backup = f.service.createBackup({ password: 'independent backup password' })
  assert.equal(JSON.stringify(backup).includes('backup-private-value'), false)
  const preview = f.service.previewBackup(backup, 'independent backup password')
  assert.equal(preview.secretCount, 1)
  f.service.createGroup({ name: 'Extra group' })
  const result = f.service.restoreBackup({ backup, password: 'independent backup password' })
  assert.equal(result.secretCount, 1)
  assert.equal(f.service.listSecrets({}).length, 1)
})

test('does not overwrite a malformed vault automatically', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secretstack-corrupt-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'vault.json')
  fs.writeFileSync(filePath, '{broken json')
  assert.throws(() => new VaultService({ filePath, safeStorage: fakeSafeStorage }), /could not be read/i)
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken json')
})