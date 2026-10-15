# SecretStack

A local-first desktop vault for development API keys, tokens, and credentials.

## Requirements

- Windows, macOS, or Linux with a supported Electron runtime
- Node.js and npm

## Run locally

From this directory:

```powershell
npm install
npm start
```

## Storage and security

The vault is saved under Electron's `app.getPath('userData')` directory as `vault.json`. Secret values are encrypted using Electron's OS-backed `safeStorage` before persistence. The renderer only receives metadata and does not have direct filesystem or Node.js access. Copy operations decrypt in the main process and write to the system clipboard.

If Electron reports that encryption is unavailable, the app blocks vault writes rather than falling back to plaintext. If a vault is malformed, the app does not automatically replace it.

The entire vault payload is encrypted with AES-256-GCM using a key derived from a master password with scrypt and a random per-vault salt. Secret values are also protected by Electron safeStorage for local persistence. Vault operations are enforced in the Electron main process; renderer hiding alone is not treated as a security boundary. Non-secret metadata is encrypted inside the vault payload after master-password setup. The small settings file stores only non-secret preferences.

On first launch, create a master password of any non-empty length; the app does not enforce password strength or a minimum length. Short or guessable passwords reduce protection against offline guessing, so choose a password you can remember and avoid reusing an important password. Keep encrypted backups safe. There is no password reset or hidden recovery. If it is forgotten, restore from a backup whose independent backup password you still know. The application auto-locks after the configured inactivity interval and can be locked manually. The key buffer is zeroed on lock on a best-effort basis; JavaScript runtimes cannot guarantee removal of all copies from process memory.

Encrypted backups use an independent password and AES-256-GCM authentication. Secret values are decrypted only inside the main process while preparing a backup, then immediately included inside the encrypted backup payload; restoring re-encrypts values with the current device's safeStorage. The backup password is not stored. Restore validates and previews group/secret counts, then asks for explicit confirmation before replacing the vault.

Clipboard clearing is best-effort and conditional: it clears only if the clipboard still contains the exact value copied by SecretStack. Clipboard managers and other software may still retain copies. These protections do not defend against malware, keyloggers, a compromised operating system, or an attacker controlling the logged-in account. Do not treat the app as production-ready until you have run the test checklist below on your machine.

Copying necessarily places a secret on the operating system clipboard. Clipboard managers, malware, or a compromised operating-system account may still expose it. OS-backed encryption depends on the platform and its configuration.

## Development vault reset

For development only, run `npm run reset-vault` to move the current encrypted `vault.json` to a timestamped backup and start a fresh vault. The script requires typing `RESET VAULT`; it never deletes the old file. Then run `npm start` and create a new master password. This does not recover data from the old vault. Do not use this procedure for a vault containing data you need.

## Tests

```powershell
npm test
```

The service tests use a fake reversible encryption adapter to test persistence and metadata behavior without requiring Electron. They do not validate the platform's actual encryption implementation.

## Project rules

- Never commit real API keys or test credentials.
- Do not log secret values or IPC payloads that contain them.
- Do not add plaintext secret export.
- Keep main-process-only code out of renderer files.