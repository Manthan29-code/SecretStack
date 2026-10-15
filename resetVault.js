const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline/promises')

// Development-only reset: preserves the old encrypted vault, then lets the app
// create a fresh one. It does not attempt to decrypt or overwrite old data.
function getUserDataDir() {
  if (process.env.SECRETSTACK_USER_DATA) return path.resolve(process.env.SECRETSTACK_USER_DATA)
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secretstack')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'secretstack')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'secretstack')
}

async function main() {
  const dir = getUserDataDir()
  const vaultPath = path.join(dir, 'vault.json')
  if (!fs.existsSync(vaultPath)) {
    console.log('No vault.json exists. SecretStack should already offer first-time setup.')
    return
  }

  let parsed
  try { parsed = JSON.parse(fs.readFileSync(vaultPath, 'utf8')) }
  catch { throw new Error('vault.json is not valid JSON. It was left untouched.') }
  if (parsed?.format !== 'secretstack-encrypted-v2') {
    throw new Error('The file is not a recognized encrypted SecretStack vault. It was left untouched.')
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('\nDEVELOPMENT RESET')
    console.log('This will start a fresh vault. Existing encrypted data will not be available in the new vault.')
    console.log('The old vault will be preserved as a timestamped backup.')
    const answer = (await rl.question('Type RESET VAULT to continue: ')).trim()
    if (answer !== 'RESET VAULT') {
      console.log('Cancelled. No files were changed.')
      return
    }
  } finally {
    rl.close()
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(dir, 'vault.json.reset-backup-' + stamp + '.bak')
  // Rename, rather than delete, so recovery remains possible.
  fs.renameSync(vaultPath, backupPath)
  console.log('\nReset complete.')
  console.log('Previous encrypted vault preserved at: ' + backupPath)
  console.log('Now run: npm start')
  console.log('SecretStack will detect that vault.json is absent and ask you to create a new master password.')
}

main().catch(error => {
  console.error('\nReset failed: ' + error.message)
  process.exitCode = 1
})
