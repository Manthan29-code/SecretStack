# Secret Key Manager — Electron App Implementation Plan

## 1. Project Overview

Build a local-first Electron desktop application for securely managing API keys, tokens, database credentials, and other secrets used in development.

Examples:
- Gemini API key
- ImageKit public/private keys and URL endpoint
- MongoDB connection string or database credentials
- OpenAI, Hugging Face, and other LLM provider keys
- Cloud storage credentials
- Custom tokens, passwords, and environment variables

The app runs on the user's PC. Secrets are organized into user-created groups, and the secret value is never displayed in the normal interface. A user can copy, edit, or delete a secret without exposing its value on screen.

### Main product principles

1. **Local-first:** no account, remote server, or cloud sync in the initial version.
2. **Secret values stay hidden:** display names and metadata, never the stored value.
3. **Secure storage:** encrypt stored secrets using operating-system-backed protection.
4. **Explicit actions:** copying, editing, and deleting require deliberate user actions.
5. **Simple workflow:** find a group, select a secret, then copy/edit/delete it.

## 2. Suggested Technology Stack

- **Desktop shell:** Electron
- **Frontend:** React + Vite
- **Language:** TypeScript, recommended for safer IPC contracts
- **Styling:** CSS Modules or Tailwind CSS
- **Local persistence:** encrypted JSON vault file for the first version
- **Encryption key protection:** Electron `safeStorage`, which uses operating-system-backed cryptography where supported
- **Validation:** Zod
- **Testing:** Vitest for unit tests and Playwright or Electron-focused integration tests
- **Packaging:** Electron Forge or electron-builder

### Important storage decision

Do not save API keys as plain text in `localStorage`, an ordinary JSON file, or renderer state that is persisted unencrypted.

For the initial implementation:
- Keep a vault file in Electron's `app.getPath('userData')` directory.
- Encrypt secret values before writing them to disk.
- Use `safeStorage` to protect the encryption key or vault data key, after checking `safeStorage.isEncryptionAvailable()`.
- Store non-secret metadata separately only if it contains no credentials.
- If secure encryption is unavailable, **do not silently fall back to plaintext**. Explain the issue and block vault writes until the user chooses a supported secure setup.

`safeStorage` behavior varies by operating system and configuration. Review Electron's current documentation before implementation. For a stronger vault design, use a random data-encryption key protected by `safeStorage`, and authenticated encryption such as AES-256-GCM for vault contents. Keep cryptographic operations in the main process, not the renderer.

## 3. App Scope and Feature Split

The application is divided into two implementation parts. Complete and test Part 1 before starting Part 2.

# Part 1 — Core Vault and Secret Management

## 4. Features

### 4.1 Dashboard and navigation

Create a desktop layout with:
- Sidebar containing groups/categories
- Search field
- Main list of saved secrets
- Details panel for the selected secret
- Add Group and Add Secret actions
- Settings entry for basic app preferences

Suggested default groups:
- LLM / AI Keys
- Storage / Media
- Databases
- Cloud Services
- Other

Users must also be able to create, rename, and delete their own groups.

### 4.2 Group management

Each group should have:
- Name
- Optional description
- Created and updated timestamps
- Count of secrets in the group

Actions:
- Create group
- Rename group
- Edit description
- Delete group

Deleting a non-empty group must ask what to do with its secrets. Recommended behavior: require the user to move the secrets to another group or explicitly confirm deleting the group and all its secrets. Never silently discard secrets.

### 4.3 Secret creation

The Add Secret form should support:
- Secret name, e.g. `Gemini Development Key`
- Group/category
- Provider/service, e.g. `Google Gemini`
- Secret value
- Optional description
- Optional tags
- Optional expiry/reminder date
- Optional non-secret metadata, such as endpoint or project name

Requirements:
- Secret input uses a password-style field.
- Do not display the secret value in the secret list, details panel, toast notifications, logs, or error messages.
- Validate required fields and prevent accidental empty secret creation.
- Warn if a similarly named secret already exists in the same group.
- Do not log form contents or IPC payloads containing secrets.

### 4.4 Secret list and details

For each secret, show only safe metadata:
- Name
- Provider/service
- Group
- Tags
- Last updated date

Never show the actual value or a partial preview of it. Avoid displaying the value in tooltips, accessibility labels, debug output, or notifications.

Actions:
- **Copy:** copies the secret value to the clipboard without showing it.
- **Edit:** opens a form with the value masked. Do not prefill the existing value into the renderer. Instead, provide a separate “Replace secret value” input and leave it blank by default. If unchanged, preserve the existing encrypted value.
- **Delete:** asks for confirmation and removes the secret from the vault.
- **Move:** changes the group without changing the secret value.
- **Search:** searches names, providers, tags, and descriptions only—not secret values.

### 4.5 Clipboard behavior

When Copy is clicked:
1. Request the secret from the main process through a narrow, validated IPC operation.
2. Write it to the system clipboard from the main process.
3. Show a generic confirmation such as “Secret copied.”
4. Never include the value in the confirmation.
5. Optionally clear the clipboard after a configurable timeout, but only if the clipboard still contains the value copied by this app. Clearly explain that clipboard clearing is best-effort and may not protect against clipboard managers or other software.

Do not automatically copy a secret just because the user selects it.

### 4.6 Local persistence and data model

Use a versioned vault schema. Example metadata structure:

```ts
type SecretMetadata = {
  id: string
  name: string
  groupId: string
  provider?: string
  description?: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

type SecretRecord = {
  metadata: SecretMetadata
  encryptedValue: string
  nonce: string
  authTag: string
}

type SecretGroup = {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
}
```

This is an illustrative schema; adapt it to the chosen authenticated-encryption format. Never store the raw secret value in the metadata object.

Required persistence behavior:
- Read/write the vault atomically to reduce corruption risk.
- Validate the schema when loading.
- Include a schema version and migration strategy.
- Handle malformed or corrupted vault files without overwriting them automatically.
- Keep backups encrypted.
- Use restrictive file permissions where supported.
- Avoid secret values in logs, crash reports, analytics, and telemetry. Prefer no telemetry in the first version.

## 5. Part 1 Implementation Milestones

1. Create the Electron + React + Vite + TypeScript project.
2. Configure a secure Electron main/preload/renderer architecture.
3. Implement the vault schema and encrypted persistence service.
4. Implement group CRUD operations.
5. Implement secret CRUD operations with masked inputs.
6. Implement copy-to-clipboard behavior.
7. Add search, empty states, loading states, and safe error handling.
8. Write unit tests for validation, encryption/decryption, group operations, and secret operations.
9. Test application restart and confirm saved secrets remain available and encrypted at rest.

### Part 1 acceptance criteria

- The app launches and works offline.
- Users can create, rename, and delete groups.
- Users can add, edit, copy, move, search, and delete secrets.
- Secret values never appear in the normal UI.
- The persisted vault does not contain plaintext secret values.
- Restarting the app preserves data.
- Deleting a secret requires confirmation.
- Errors and logs do not leak secret values.

---

# Part 2 — Security Hardening, Quality of Life, and Release

## 6. Features

### 6.1 Vault lock and unlock

Add a lock screen and explicit lock/unlock workflow.

Recommended design:
- Ask the user to create a vault password during setup.
- Derive a key from the password using a password-based key derivation function such as Argon2id or scrypt, with a unique random salt and appropriate parameters.
- Use a random data-encryption key for the vault and protect it using the selected key-management design.
- Keep decrypted secrets in memory only as long as needed.
- Lock the vault after a configurable period of inactivity and when the user manually locks it.
- Clear sensitive in-memory state when locking.
- Do not store the vault password in settings or logs.

Decide carefully how vault-password recovery works. A lost password may mean lost access to the vault; explain this during setup. Do not implement a hidden recovery bypass.

A vault password and OS-backed `safeStorage` can be combined, but the design must be explicit. Do not assume that `safeStorage` alone provides the same protection as a user-controlled master password in every operating-system configuration.

### 6.2 Security settings

Provide settings for:
- Auto-lock timeout
- Clear clipboard after a selected interval (optional, best-effort)
- Lock vault now
- Backup/export encrypted vault
- Restore/import a compatible encrypted backup
- Show storage location
- Confirm before deleting a group or secret

Do not offer a plaintext “export all secrets” option by default. If plaintext export is ever added, it must require a separate explicit confirmation and should be treated as a high-risk feature.

### 6.3 Import and export

For the first release of Part 2:
- Support encrypted backup and restore.
- Validate backup version and integrity before importing.
- Show a preview of group/secret counts without displaying secret values.
- Avoid overwriting the current vault without a clear confirmation and a recovery path.
- Reject malformed files and unsupported versions safely.

Optional later enhancement: import `.env` files. Treat these as sensitive input, never print their contents, and let users choose which entries to import. Do not automatically execute imported values or write them into project files.

### 6.4 Quality-of-life features

- Filter by group and provider
- Sort by name or last updated
- Tags and descriptions
- Recently copied indicator that contains no secret value
- Keyboard shortcuts for search, lock, and copy
- Clear empty states and confirmation dialogs
- Responsive layout for different desktop window sizes
- Accessible labels that do not include secret values

### 6.5 Packaging and updates

- Package builds for the intended operating system first.
- Sign the application where feasible.
- Use a maintained packaging tool and document the release process.
- Do not bundle API keys or test secrets into the application.
- Keep dependencies updated and audit production dependencies.
- Provide a clear uninstall/data-retention explanation. Uninstalling the app should not unexpectedly erase the vault unless the user explicitly chooses that behavior.

## 7. Security Architecture

### 7.1 Process responsibilities

**Renderer (React UI)**
- Displays safe metadata.
- Collects user input.
- Never accesses Node.js APIs directly.
- Never reads or writes the vault file directly.

**Preload**
- Exposes a small, explicit API such as `createSecret`, `listSecrets`, `copySecret`, `updateSecret`, and `deleteSecret`.
- Validates argument shapes where practical.
- Does not expose arbitrary IPC, `ipcRenderer`, filesystem access, or generic command execution.

**Main process**
- Owns filesystem access, encryption, decryption, clipboard operations, and vault locking.
- Validates every IPC request.
- Returns only the minimum data the UI needs.
- Redacts sensitive errors and avoids logging payloads.

### 7.2 Electron hardening checklist

- Set `contextIsolation: true`.
- Set `nodeIntegration: false`.
- Use a restrictive Content Security Policy.
- Validate IPC sender and request payloads.
- Expose only allowlisted preload methods.
- Avoid loading remote content in the privileged app window.
- Deny unexpected navigation and new-window creation.
- Keep Electron and dependencies updated.
- Do not place secrets in command-line arguments or environment variables used to launch the app.
- Avoid unnecessary permissions and network access.

### 7.3 Threat model and limitations

The app should protect secrets at rest and avoid accidental display. It cannot fully protect secrets from malware, keyloggers, clipboard-monitoring software, a compromised operating system, or an attacker who controls the logged-in user account. Copying a secret necessarily places it on the system clipboard temporarily. State these limitations honestly in the app's security notes.

## 8. Suggested Folder Structure

```text
secret-key-manager/
├── electron/
│   ├── main.ts
│   ├── preload.ts
│   ├── ipc/
│   │   ├── groups.ts
│   │   ├── secrets.ts
│   │   └── settings.ts
│   ├── services/
│   │   ├── vault-service.ts
│   │   ├── encryption-service.ts
│   │   ├── clipboard-service.ts
│   │   └── backup-service.ts
│   └── security/
│       ├── validate-ipc.ts
│       └── redact-errors.ts
├── src/
│   ├── app/
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── GroupList.tsx
│   │   ├── SecretList.tsx
│   │   ├── SecretForm.tsx
│   │   ├── SecretDetails.tsx
│   │   ├── ConfirmDialog.tsx
│   │   └── LockScreen.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   └── Settings.tsx
│   ├── hooks/
│   ├── types/
│   │   └── vault.ts
│   └── styles/
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

Adjust the structure to the Electron starter template. Keep main-process-only modules out of renderer imports.

## 9. Core IPC API Proposal

Use explicit, narrow IPC methods. These are conceptual contracts, not implementation code.

| Method | Purpose | Secret value returned to renderer? |
|---|---|---|
| `groups:list` | List groups | No |
| `groups:create` | Create a group | No |
| `groups:update` | Rename/edit a group | No |
| `groups:delete` | Delete a group after policy checks | No |
| `secrets:list` | List secret metadata | No |
| `secrets:create` | Save a new secret | Only submitted value travels to main for saving; do not return it |
| `secrets:update` | Update metadata and optionally replace value | Only submitted replacement travels to main; do not return it |
| `secrets:copy` | Decrypt and copy a secret in main process | No |
| `secrets:delete` | Delete a secret | No |
| `vault:lock` | Lock vault and clear sensitive state | No |
| `vault:status` | Return locked/unlocked status | No |
| `backup:export` | Write encrypted backup | No |
| `backup:import` | Validate and restore encrypted backup | No |

The renderer should receive identifiers, metadata, status, and safe error codes—not decrypted secret values. If the UI needs to edit a secret, use a blank “Replace value” field instead of fetching the existing value.

## 10. UI Layout Sketch

```text
┌────────────────────────────────────────────────────────────────┐
│ Secret Key Manager                              [Lock] [Settings]│
├─────────────────────┬──────────────────────────┬────────────────┤
│ Search              │ Secrets                  │ Selected Secret│
│                     │                          │                │
│ Groups              │ Gemini Development Key   │ Name           │
│  LLM / AI Keys      │ ImageKit Production      │ Gemini Dev Key │
│  Storage / Media    │ MongoDB Local            │ Group          │
│  Databases          │                          │ LLM / AI Keys  │
│  Cloud Services     │                          │                │
│  Other              │                          │ [Copy] [Edit]  │
│                     │                          │ [Delete]       │
│ [+ Add Group]       │ [+ Add Secret]           │                │
└─────────────────────┴──────────────────────────┴────────────────┘
```

The details panel must not contain a visible secret-value field. On edit, open a form that allows metadata edits and an optional replacement value.

## 11. Testing Plan

### Functional tests
- Create, rename, and delete groups.
- Create, edit, move, copy, search, and delete secrets.
- Handle duplicate names, empty fields, invalid IDs, and missing groups.
- Verify group deletion cannot silently delete secrets.
- Verify app restart preserves the vault.

### Security tests
- Inspect persisted files and confirm secret values are not plaintext.
- Confirm secrets are absent from console output, error messages, notifications, and renderer-visible data.
- Confirm the renderer cannot access filesystem or Node.js APIs directly.
- Confirm arbitrary IPC channels cannot be invoked through the preload API.
- Confirm vault lock prevents further secret operations until unlock.
- Test corrupted vaults and invalid backup files.
- Test clipboard clearing behavior without claiming it is guaranteed.

### Platform tests
- Test on each target OS, especially encryption availability and app-data permissions.
- Test packaged builds, not only development mode.
- Test recovery behavior after interrupted writes and failed imports.

## 12. Recommended Development Order

1. **Part 1:** scaffold, secure process boundaries, encrypted storage, groups, secrets, copy/edit/delete, tests.
2. Review the threat model and verify there is no plaintext persistence.
3. **Part 2:** vault password/locking, settings, encrypted backups, quality-of-life improvements, packaging.
4. Perform a security review before storing real production credentials.

## 13. Definition of Done

The project is ready for personal use when:
- It runs locally without requiring a remote backend.
- Secrets are encrypted at rest and never displayed in normal UI.
- Copy, edit, and delete actions work reliably.
- Group organization and search work correctly.
- The main/preload/renderer boundary is hardened.
- Locking and backup/restore behavior are documented and tested.
- No secrets are committed to Git or included in build artifacts.
- The README explains setup, data location, backups, and security limitations.

## 14. Official Documentation to Consult

- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron `safeStorage`: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron clipboard: https://www.electronjs.org/docs/latest/api/clipboard
- Electron app paths: https://www.electronjs.org/docs/latest/api/app
- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model

**Final recommendation:** build Part 1 first and keep the renderer completely unaware of stored secret values. Treat security as an architectural requirement, not a feature to add after the UI is complete.
