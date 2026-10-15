const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const APP_NAME = 'secretstack'
const AAD = Buffer.from('secretstack-vault-v2')

function getVaultPath() {
  if (process.env.SECRETSTACK_USER_DATA) {
    return path.join(process.env.SECRETSTACK_USER_DATA, 'vault.json')
  }

  let userDataDirectory
  if (process.platform === 'win32') {
    userDataDirectory = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME)
  } else if (process.platform === 'darwin') {
    userDataDirectory = path.join(os.homedir(), 'Library', 'Application Support', APP_NAME)
  } else {
    userDataDirectory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME)
  }

  return path.join(userDataDirectory, 'vault.json')
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
}

function decryptVault(envelope, password) {
  const key = deriveKey(password, Buffer.from(envelope.salt, 'base64'))
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.nonce, 'base64')
    )
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ])
    return { plaintext, key }
  } catch {
    key.fill(0)
    throw new Error('Current password is incorrect or the vault is damaged. No changes were made.')
  }
}

function encryptVault(plaintext, password) {
  const salt = crypto.randomBytes(16)
  const key = deriveKey(password, salt)
  const nonce = crypto.randomBytes(12)

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      format: 'secretstack-encrypted-v2',
      schemaVersion: 2,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: new Date().toISOString()
    }
  } finally {
    key.fill(0)
  }
}

// Read a password without echoing it to the terminal.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const output = process.stdout
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      output.write(prompt + '(input will be visible because this terminal does not support hidden input)\n')
      input.resume()
      let value = ''
      const onLine = chunk => {
        input.removeListener('data', onLine)
        resolve(String(chunk).replace(/[\r\n]+$/, ''))
      }
      input.once('data', onLine)
      return
    }

    output.write(prompt)
    let value = ''
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          cleanup()
          output.write('\n')
          reject(new Error('Cancelled.'))
          process.exitCode = 1
          return
        }
        if (char === '\r' || char === '\n') {
          cleanup()
          output.write('\n')
          resolve(value)
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
        } else if (char >= ' ' && char !== '\u001b') {
          value += char
        }
      }
    }
    const cleanup = () => {
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.pause()
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function main() {
  const vaultPath = getVaultPath()
  if (!fs.existsSync(vaultPath)) {
    throw new Error(
      'Vault file was not found at:\n' + vaultPath +
      '\nIf SecretStack stores data elsewhere, set SECRETSTACK_USER_DATA to its user-data directory.'
    )
  }

  let envelope
  try {
    envelope = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
  } catch {
    throw new Error('Vault file is not valid JSON. No changes were made.')
  }

  if (
    envelope?.format !== 'secretstack-encrypted-v2' ||
    envelope.kdf !== 'scrypt' ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.authTag !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('Unsupported or unencrypted vault format. No changes were made.')
  }

  let plaintext
  let oldKey
  try {
    const currentPassword = await askHidden('Current master password: ')
    const newPassword = await askHidden('New master password (exactly 6 characters): ')
    const confirmPassword = await askHidden('Confirm new master password: ')

    if (newPassword.length !== 6) {
      throw new Error('New master password must be exactly 6 characters. No changes were made.')
    }
    if (newPassword !== confirmPassword) {
      throw new Error('New passwords do not match. No changes were made.')
    }
    if (newPassword === currentPassword) {
      throw new Error('Choose a different password. No changes were made.')
    }

    const decrypted = decryptVault(envelope, currentPassword)
    plaintext = decrypted.plaintext
    oldKey = decrypted.key

    // Validate the decrypted JSON before changing anything.
    const data = JSON.parse(plaintext.toString('utf8'))
    if (data?.schemaVersion !== 1 || !Array.isArray(data.groups) || !Array.isArray(data.secrets)) {
      throw new Error('Decrypted vault data has an unsupported structure. No changes were made.')
    }

    const replacement = encryptVault(plaintext, newPassword)
    const backupPath = vaultPath + '.before-password-reset.bak'
    fs.copyFileSync(vaultPath, backupPath, fs.constants.COPYFILE_EXCL)
    try {
      fs.chmodSync(backupPath, 0o600)
    } catch {}

    const tempPath = vaultPath + '.password-reset.tmp'
    let fd
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify(replacement, null, 2), 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(tempPath, vaultPath)
      try {
        fs.chmodSync(vaultPath, 0o600)
      } catch {}
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch {}
      }
      try { fs.unlinkSync(tempPath) } catch {}
      throw new Error('Could not replace the vault file. The original vault and its backup were preserved.')
    }

    // Confirm that the newly written vault can be opened with the new password.
    const saved = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
    const verification = decryptVault(saved, newPassword)
    verification.key.fill(0)
    verification.plaintext.fill(0)
    console.log('\nMaster password changed successfully.')
    console.log('Vault: ' + vaultPath)
    console.log('Original encrypted vault backup: ' + backupPath)
    console.log('Keep the backup private. It can still be opened with the OLD password.')
  } finally {
    if (oldKey) oldKey.fill(0)
    if (plaintext) plaintext.fill(0)
  }
}

main().catch(error => {
  console.error('\nPassword reset failed: ' + error.message)
  process.exitCode = 1
})
