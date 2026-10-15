const api = window.secretStack
const $ = selector => document.querySelector(selector)

const state = { groups: [], secrets: [], selectedGroupId: null, selectedSecretId: null, query: '', view: 'vault', modalSubmit: null }

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const dateLabel = value => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
const shortDate = value => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const groupName = id => state.groups.find(group => group.id === id)?.name || 'Unknown group'
const selectedSecret = () => state.secrets.find(secret => secret.id === state.selectedSecretId)
const providerGlyph = provider => {
  const name = String(provider || '').toLowerCase()
  if (name.includes('google') || name.includes('gemini')) return 'G'
  if (name.includes('mongo') || name.includes('database')) return '◈'
  if (name.includes('imagekit') || name.includes('media')) return '▧'
  if (name.includes('openai')) return '◎'
  if (name.includes('hugging')) return 'H'
  return '⌘'
}

function showToast(message, isError = false) {
  const toast = document.createElement('div')
  toast.className = 'toast' + (isError ? ' error' : '')
  toast.innerHTML = '<span class="toast-mark">' + (isError ? '!' : '✓') + '</span><span>' + escapeHtml(message) + '</span>'
  $('#toastRegion').appendChild(toast)
  setTimeout(() => toast.remove(), 3200)
}

function readableError(error) {
  const code = error?.code || error?.message
  const messages = {
    ENCRYPTION_UNAVAILABLE: 'Secure encryption is unavailable on this system. Secret writes are blocked.',
    VAULT_INVALID: 'The vault format is invalid. The original file was preserved.',
    VAULT_CORRUPT: 'The vault could not be read. Its original file was preserved.',
    VAULT_WRITE_FAILED: 'The vault could not be saved.',
    VALIDATION: error.message,
    DUPLICATE_GROUP: error.message,
    DUPLICATE_SECRET: error.message,
    GROUP_NOT_EMPTY: error.message,
    GROUP_NOT_FOUND: error.message,
    SECRET_NOT_FOUND: error.message,
    DECRYPT_FAILED: error.message,
    VAULT_LOCKED: 'The vault is locked. Unlock it before continuing.',
    WEAK_PASSWORD: error.message || 'Master password must be exactly 6 characters long.',
    PASSWORD_MISMATCH: error.message || 'The passwords do not match.',
    BAD_PASSWORD_OR_CORRUPT: 'Password is incorrect or the encrypted vault is damaged.',
    BACKUP_INVALID: error.message || 'The backup is invalid or its password is incorrect.',
    BACKUP_FAILED: error.message || 'The encrypted backup could not be created.',
    SETUP_REQUIRED: 'Set up the vault password before continuing.',
    ALREADY_CONFIGURED: 'A master password is already configured.'
  }
  return messages[code] || 'The operation failed. No secret value was displayed.'
}

function renderGroups() {
  const list = $('#groupList')
  const total = state.secrets.length
  $('#totalCount').textContent = total
  list.innerHTML = state.groups.map(group => `
    <div class="group-item ${state.selectedGroupId === group.id ? 'selected' : ''}" data-group-id="${escapeHtml(group.id)}" title="${escapeHtml(group.name)}" role="button" tabindex="0">
      <span class="group-glyph">◫</span><span class="group-label">${escapeHtml(group.name)}</span><span class="group-count">${group.secretCount}</span>
      <button class="group-actions-button" data-group-actions="${escapeHtml(group.id)}" aria-label="Manage ${escapeHtml(group.name)}" title="Rename or delete group">···</button>
    </div>`).join('')
  list.querySelectorAll('.group-item').forEach(item => {
    const select = () => {
      state.selectedGroupId = item.dataset.groupId
      state.selectedSecretId = null
      state.view = 'vault'
      // Re-apply the selected-group filter whenever the group changes.
      // refresh() fetches metadata only; it never fetches secret values.
      refresh().catch(error => showToast(readableError(error), true))
    }
    item.addEventListener('click', event => {
      if (event.target.closest('[data-group-actions]')) return
      select()
    })
    item.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === item) {
        event.preventDefault()
        select()
      }
    })
  })
  list.querySelectorAll('[data-group-actions]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation()
    const group = state.groups.find(item => item.id === button.dataset.groupActions)
    if (group) openGroupActions(group)
  }))
}

function renderSecrets() {
  const secrets = state.secrets
  $('#resultCount').textContent = secrets.length + (secrets.length === 1 ? ' secret' : ' secrets')
  $('#panelCount').textContent = secrets.length
  if (!secrets.length) {
    const filtered = Boolean(state.query || state.selectedGroupId)
    $('#secretList').innerHTML = `<div class="list-empty"><strong>${filtered ? 'No matching secrets' : 'Your vault is empty'}</strong><p>${filtered ? 'Try a different search or select another group.' : 'Add your first API key or credential to start organizing your development secrets.'}</p><button class="button button-primary button-small" id="emptyAddSecret">${filtered ? 'Add secret' : '+ Add your first secret'}</button></div>`
    $('#emptyAddSecret').addEventListener('click', () => openSecretForm())
    return
  }
  $('#secretList').innerHTML = secrets.map(secret => `
    <div class="secret-row ${secret.id === state.selectedSecretId ? 'selected' : ''}" data-secret-id="${escapeHtml(secret.id)}" role="button" tabindex="0" aria-label="Select ${escapeHtml(secret.name)}">
      <div class="secret-avatar">${escapeHtml(providerGlyph(secret.provider))}</div>
      <div class="secret-row-content"><div class="secret-name">${escapeHtml(secret.name)}</div><div class="secret-provider">${escapeHtml(secret.provider || groupName(secret.groupId))}</div></div>
      <div class="secret-row-end"><span class="type-chip">Secret</span><span class="secret-date">${escapeHtml(shortDate(secret.updatedAt))}</span></div>
    </div>`).join('')
  $('#secretList').querySelectorAll('[data-secret-id]').forEach(row => {
    const select = () => {
      state.selectedSecretId = row.dataset.secretId
      $('#secretList').querySelectorAll('[data-secret-id]').forEach(item => {
        item.classList.toggle('selected', item.dataset.secretId === state.selectedSecretId)
      })
      renderDetail()
    }
    row.addEventListener('click', event => {
      event.preventDefault()
      select()
    })
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        select()
      }
    })
  })
}

function renderDetail() {
  const secret = selectedSecret()
  const panel = $('#detailPanel')
  if (!secret) {
    panel.innerHTML = '<div class="detail-empty"><div class="empty-lock">ϟ</div><h2>Select a secret</h2><p>Choose an item from your vault to see its safe metadata and available actions.</p><div class="empty-note"><span>◈</span> Secret values are never displayed here.</div></div>'
    return
  }
  const tags = (secret.tags || []).map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') || '<span class="metadata-value muted">No tags</span>'
  const metadata = secret.metadata || {}
  panel.innerHTML = `
    <div class="detail-content">
      <div class="detail-top"><div class="detail-identity"><div class="secret-avatar">${escapeHtml(providerGlyph(secret.provider))}</div><div><h2>${escapeHtml(secret.name)}</h2><p>${escapeHtml(secret.provider || 'Custom secret')}</p></div></div>
        <div class="detail-actions"><button class="action-icon" id="copySecret">↗ Copy</button><button class="action-icon" id="editSecret">Edit</button><button class="action-icon danger" id="deleteSecret">Delete</button></div>
      </div>
      <div class="detail-divider"></div><div class="detail-section-label">SECRET DETAILS</div>
      <div class="metadata-grid">
        <div class="metadata-item"><div class="metadata-label">Group</div><div class="metadata-value">${escapeHtml(groupName(secret.groupId))}</div></div>
        <div class="metadata-item"><div class="metadata-label">Last updated</div><div class="metadata-value">${escapeHtml(dateLabel(secret.updatedAt))}</div></div>
        <div class="metadata-item full"><div class="metadata-label">Description</div><div class="metadata-value ${secret.description ? '' : 'muted'}">${escapeHtml(secret.description || 'No description added')}</div></div>
        <div class="metadata-item full"><div class="metadata-label">Tags</div><div class="tag-list">${tags}</div></div>
        <div class="metadata-item"><div class="metadata-label">Endpoint</div><div class="metadata-value ${metadata.endpoint ? '' : 'muted'}">${escapeHtml(metadata.endpoint || '—')}</div></div>
        <div class="metadata-item"><div class="metadata-label">Project</div><div class="metadata-value ${metadata.projectName ? '' : 'muted'}">${escapeHtml(metadata.projectName || '—')}</div></div>
        <div class="metadata-item full"><div class="metadata-label">Secret value</div><div class="metadata-value muted">Hidden · encrypted at rest</div></div>
      </div>
      <div class="secret-hidden-notice"><span class="notice-glyph">◈</span><div><strong>Secret value stays hidden</strong><p>Copy places the value on your system clipboard. The stored value is never sent to this view.</p></div></div>
      <div class="detail-divider"></div><div class="detail-updated">CREATED ${escapeHtml(dateLabel(secret.createdAt))} <span style="padding:0 5px">·</span> ID ${escapeHtml(secret.id.slice(0, 8))}</div>
    </div>`
  $('#copySecret').addEventListener('click', async () => {
    try { await api.copySecret({ id: secret.id }); showToast('Secret copied to clipboard.') }
    catch (error) { showToast(readableError(error), true) }
  })
  $('#editSecret').addEventListener('click', () => openSecretForm(secret))
  $('#deleteSecret').addEventListener('click', () => confirmDeleteSecret(secret))
}

function render() {
  $('#vaultView').classList.toggle('hidden', state.view !== 'vault')
  $('#settingsView').classList.toggle('hidden', state.view !== 'settings')
  $('#navVault').classList.toggle('active', state.view === 'vault')
  $('#navSettings').classList.toggle('active', state.view === 'settings')
  $('#breadcrumbCurrent').textContent = state.view === 'settings' ? 'Settings' : (state.selectedGroupId ? groupName(state.selectedGroupId) : 'All secrets')
  renderGroups()
  renderSecrets()
  renderDetail()
}

async function refresh() {
  const [groups, allSecrets] = await Promise.all([api.listGroups(), api.listSecrets({})])
  state.groups = groups
  state.secrets = allSecrets.filter(secret => {
    const groupMatch = !state.selectedGroupId || secret.groupId === state.selectedGroupId
    const query = state.query.trim().toLowerCase()
    const searchMatch = !query || [secret.name, secret.provider, secret.description, ...(secret.tags || []), secret.metadata?.endpoint, secret.metadata?.projectName]
      .filter(Boolean).join(' ').toLowerCase().includes(query)
    return groupMatch && searchMatch
  })
  if (state.selectedSecretId && !state.secrets.some(secret => secret.id === state.selectedSecretId)) state.selectedSecretId = null
  render()
}

function field(label, name, value = '', options = {}) {
  const full = options.full ? ' full' : ''
  const required = options.required ? ' required' : ''
  const placeholder = options.placeholder ? ' placeholder="' + escapeHtml(options.placeholder) + '"' : ''
  const hint = options.hint ? '<span class="field-hint">' + escapeHtml(options.hint) + '</span>' : ''
  const input = options.textarea
    ? '<textarea name="' + name + '"' + placeholder + (options.maxlength ? ' maxlength="' + options.maxlength + '"' : '') + '>' + escapeHtml(value) + '</textarea>'
    : '<input name="' + name + '" type="' + (options.type || 'text') + '" value="' + escapeHtml(value) + '"' + placeholder + required + (options.maxlength ? ' maxlength="' + options.maxlength + '"' : '') + (options.autocomplete ? ' autocomplete="' + options.autocomplete + '"' : '') + '>'
  return '<div class="field' + full + '"><label for="field-' + name + '">' + escapeHtml(label) + (options.required ? ' <span style="color:var(--green)">*</span>' : '') + '</label>' + input.replace('name="' + name + '"', 'id="field-' + name + '" name="' + name + '"') + hint + '</div>'
}

function selectField(label, name, selectedId, options, full = false) {
  return '<div class="field' + (full ? ' full' : '') + '"><label for="field-' + name + '">' + escapeHtml(label) + '</label><select id="field-' + name + '" name="' + name + '">' + options.map(option => '<option value="' + escapeHtml(option.id) + '"' + (option.id === selectedId ? ' selected' : '') + '>' + escapeHtml(option.name) + '</option>').join('') + '</select></div>'
}

function openModal({ title, eyebrow = 'VAULT ACTION', submit = 'Save', body, onSubmit }) {

  state.modalSubmit = onSubmit
  $('#modalTitle').textContent = title
  $('#modalEyebrow').textContent = eyebrow
  $('#submitModal').textContent = submit
  $('#modalBody').innerHTML = body
  $('#modalError').classList.add('hidden')
  $('#modalBackdrop').classList.remove('hidden')
  const firstInput = $('#modalBody input, #modalBody textarea, #modalBody select')
  if (firstInput) firstInput.focus()
}

function closeModal() {
  $('#modalBackdrop').classList.add('hidden')
  $('#modalBody').innerHTML = ''
  state.modalSubmit = null
  $('#modalForm').reset()
}

$('#modalForm').addEventListener('submit', async event => {
  event.preventDefault()

  const submit = state.modalSubmit
  if (!submit) return
  $('#submitModal').disabled = true
  $('#modalError').classList.add('hidden')
  try {
    await submit(new FormData(event.currentTarget))
    closeModal()
    await refresh()
  } catch (error) {
    $('#modalError').textContent = readableError(error)
    $('#modalError').classList.remove('hidden')
  } finally {
    $('#submitModal').disabled = false
  }
})
$('#closeModal').addEventListener('click', closeModal)
$('#cancelModal').addEventListener('click', closeModal)
$('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal() })
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeModal()
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (state.view !== 'vault') switchView('vault')
    $('#searchInput').focus()
  }
})

function openGroupForm(group = null) {
  const isEdit = Boolean(group)
  openModal({
    title: isEdit ? 'Edit group' : 'Create a group',
    eyebrow: 'ORGANIZE YOUR VAULT',
    submit: isEdit ? 'Save changes' : 'Create group',
    body: field('Group name', 'name', group?.name || '', { required: true, full: true, placeholder: 'e.g. Production services', maxlength: 80 }) +
      field('Description (optional)', 'description', group?.description || '', { full: true, textarea: true, placeholder: 'What belongs in this group?' }),
    onSubmit: async form => {
      const data = { name: form.get('name'), description: form.get('description') }
      if (isEdit) await api.updateGroup({ id: group.id, ...data })
      else await api.createGroup(data)
      showToast(isEdit ? 'Group updated.' : 'Group created.')
    }
  })
}

function openSecretForm(secret = null) {
  if (!state.groups.length) { showToast('Create a group before adding a secret.', true); return }
  const editing = Boolean(secret)
  const selectedGroup = secret?.groupId || state.selectedGroupId || state.groups[0].id
  const groupOptions = state.groups.map(group => ({ id: group.id, name: group.name }))
  const tagText = (secret?.tags || []).join(', ')
  const metadata = secret?.metadata || {}
  const body =
    field('Secret name', 'name', secret?.name || '', { required: true, full: true, placeholder: 'e.g. Gemini Development Key', maxlength: 120 }) +
    selectField('Group', 'groupId', selectedGroup, groupOptions) +
    field('Provider / service', 'provider', secret?.provider || '', { placeholder: 'e.g. Google Gemini', maxlength: 120 }) +
    field('Description', 'description', secret?.description || '', { full: true, textarea: true, placeholder: 'Optional context for this credential' }) +
    field('Tags', 'tags', tagText, { full: true, placeholder: 'development, production, backend', maxlength: 300, hint: 'Separate tags with commas. Search checks tags and metadata.' }) +
    field('Endpoint (optional)', 'endpoint', metadata.endpoint || '', { placeholder: 'https://api.example.com', maxlength: 300 }) +
    field('Project name (optional)', 'projectName', metadata.projectName || '', { placeholder: 'Project or environment', maxlength: 120 }) +
    (editing
      ? '<div class="field full"><label class="check-row"><input type="checkbox" id="replaceValueToggle" name="replaceValue"> Replace secret value</label><span class="field-hint">The existing value is never loaded into this form. Leave this unchecked to keep it unchanged.</span></div>' + field('New secret value', 'value', '', { type: 'password', full: true, placeholder: 'Enter a new value only if replacing it', autocomplete: 'new-password', hint: 'This field starts blank. The value is encrypted in the main process.' })
      : field('Secret value', 'value', '', { type: 'password', full: true, required: true, placeholder: 'Paste your API key or credential', autocomplete: 'new-password', hint: 'The value will be encrypted before it is saved and will never be displayed in the list.' }))
  openModal({
    title: editing ? 'Edit secret' : 'Add a secret',
    eyebrow: editing ? 'UPDATE CREDENTIAL' : 'NEW CREDENTIAL',
    submit: editing ? 'Save changes' : 'Save secret',
    body,
    onSubmit: async form => {
      const data = {
        name: form.get('name'),
        groupId: form.get('groupId'),
        provider: form.get('provider'),
        description: form.get('description'),
        tags: String(form.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean),
        metadata: { endpoint: form.get('endpoint'), projectName: form.get('projectName') }
      }
      if (editing) {
        data.id = secret.id
        data.replaceValue = $('#replaceValueToggle').checked
        if (data.replaceValue) data.value = form.get('value')
        await api.updateSecret(data)
        showToast('Secret updated.')
      } else {
        data.value = form.get('value')
        await api.createSecret(data)
        state.selectedSecretId = null
        showToast('Secret saved securely.')
      }
    }
  })
  if (editing) {
    const toggle = $('#replaceValueToggle')
    const valueInput = $('#field-value')
    valueInput.disabled = true
    toggle.addEventListener('change', () => {
      valueInput.disabled = !toggle.checked
      if (!toggle.checked) valueInput.value = ''
      if (toggle.checked) valueInput.focus()
    })
  }
}

function confirmDeleteSecret(secret) {
  openModal({
    title: 'Delete this secret?',
    eyebrow: 'CONFIRM DELETION',
    submit: 'Delete secret',
    body: '<p class="field full" style="grid-column:1/-1;color:var(--muted);font-size:12px;line-height:1.7;margin:0">This permanently removes <strong style="color:var(--ink)">' + escapeHtml(secret.name) + '</strong> from the local vault. This action cannot be undone.</p>',
    onSubmit: async () => {

      await api.deleteSecret({ id: secret.id })

      state.selectedSecretId = null
      showToast('Secret deleted.')
    }
  })
  $('#submitModal').classList.add('button-primary')
}

function openGroupActions(group) {
  openModal({
    title: group.name,
    eyebrow: 'MANAGE GROUP',
    submit: 'Rename group',
    body: field('Group name', 'name', group.name, { required: true, full: true, maxlength: 80 }) +
      field('Description', 'description', group.description || '', { full: true, textarea: true }),
    onSubmit: async form => {
      await api.updateGroup({ id: group.id, name: form.get('name'), description: form.get('description') })
      showToast('Group updated.')
    }
  })
  const deleteButton = document.createElement('button')
  deleteButton.type = 'button'
  deleteButton.className = 'button button-outline'
  deleteButton.textContent = 'Delete group…'
  deleteButton.addEventListener('click', () => {
    closeModal()
    openDeleteGroup(group)
  })
  $('#modalForm .modal-actions').prepend(deleteButton)
}

function openDeleteGroup(group) {
  const members = state.secrets.filter(secret => secret.groupId === group.id)
  if (!members.length) {
    openModal({
      title: 'Delete group?',
      eyebrow: 'CONFIRM DELETION',
      submit: 'Delete group',
      body: '<p style="grid-column:1/-1;color:var(--muted);font-size:12px;line-height:1.7;margin:0">Delete the empty group <strong style="color:var(--ink)">' + escapeHtml(group.name) + '</strong>?</p>',
      onSubmit: async () => { await api.deleteGroup({ id: group.id }); if (state.selectedGroupId === group.id) state.selectedGroupId = null; showToast('Group deleted.') }
    })
    return
  }
  const destinations = state.groups.filter(item => item.id !== group.id)
  const body = '<p style="grid-column:1/-1;color:var(--muted);font-size:12px;line-height:1.7;margin:0">This group contains <strong style="color:var(--ink)">' + members.length + ' secret(s)</strong>. Choose where they go. Secrets will not be silently discarded.</p>' +
    '<div class="field full"><label for="groupDeleteMode">When deleting this group</label><select id="groupDeleteMode" name="mode"><option value="move">Move secrets to another group (recommended)</option><option value="delete">Permanently delete this group and its secrets</option></select></div>' +
    selectField('Destination group', 'targetGroupId', destinations[0]?.id, destinations) +
    '<p id="deleteGroupWarning" class="field-hint full" style="grid-column:1/-1;color:#d7a3a3">Choosing permanent deletion will remove every secret in this group.</p>'
  openModal({
    title: 'Delete group?',
    eyebrow: 'GROUP CONTAINS SECRETS',
    submit: 'Continue',
    body,
    onSubmit: async form => {
      const mode = form.get('mode')
      if (mode === 'delete') {
        const accepted = window.confirm('Permanently delete this group and all ' + members.length + ' secrets? This cannot be undone.')
        if (!accepted) return
        await api.deleteGroup({ id: group.id, mode: 'delete' })
      } else {
        await api.deleteGroup({ id: group.id, mode: 'move', targetGroupId: form.get('targetGroupId') })
      }
      if (state.selectedGroupId === group.id) state.selectedGroupId = null
      state.selectedSecretId = null
      showToast(mode === 'move' ? 'Group deleted; secrets moved.' : 'Group and its secrets deleted.')
    }
  })
  const modeSelect = $('#modalBody select[name="mode"]')
  const destination = $('#modalBody select[name="targetGroupId"]')
  const updateMode = () => {
    destination.disabled = modeSelect.value === 'delete'
    $('#deleteGroupWarning').textContent = modeSelect.value === 'delete'
      ? 'Permanent deletion removes all secrets in this group.'
      : 'All secrets will be moved to the selected destination group.'
    $('#submitModal').textContent = modeSelect.value === 'delete' ? 'Delete group and secrets' : 'Move secrets & delete group'
  }
  modeSelect.addEventListener('change', updateMode)
  updateMode()
}

$('#addGroupButton').addEventListener('click', () => openGroupForm())
$('#addSecretButton').addEventListener('click', () => openSecretForm())
$('#searchInput').addEventListener('input', async event => { state.query = event.target.value; await refresh() })
$('#navVault').addEventListener('click', () => switchView('vault'))
$('#navSettings').addEventListener('click', () => switchView('settings'))
$('#settingsButton').addEventListener('click', () => switchView('settings'))
$('#openDataFolder').addEventListener('click', async () => {
  try { await api.openDataFolder(); showToast('Opened local storage folder.') }
  catch { showToast('Could not open the storage folder.', true) }
})

function switchView(view) {
  state.view = view
  render()
  if (view === 'settings') {
    api.status().then(status => {
      $('#encryptionStatus').textContent = status.encryptionAvailable ? 'Master-password encryption + OS-backed secret protection enabled' : 'Unavailable · secret writes blocked'
      $('#encryptionStatus').style.color = status.encryptionAvailable ? 'var(--green)' : 'var(--danger)'
    }).catch(() => { $('#encryptionStatus').textContent = 'Could not determine encryption status' })
  }
}

let isVaultReady = false
let lastActivityPing = 0

function showLockScreen(setupRequired, reason = '') {
  isVaultReady = false
  $('#lockScreen').classList.remove('hidden')
  $('#lockSetupFields').classList.toggle('hidden', !setupRequired)
  $('#lockUnlockFields').classList.toggle('hidden', setupRequired)
  $('#lockTitle').innerHTML = setupRequired ? 'Create your master password<span class="title-period">.</span>' : 'Unlock SecretStack<span class="title-period">.</span>'
  $('#lockEyebrow').textContent = setupRequired ? 'FIRST-TIME SECURE SETUP' : 'LOCAL SECRET VAULT'
  $('#lockDescription').textContent = setupRequired
    ? 'Create a master password to encrypt your vault. This password cannot be recovered if lost.'
    : (reason === 'inactivity' ? 'Your vault was locked after inactivity. Enter your master password to continue.' : 'Enter your master password to access your encrypted vault.')
  $('#lockSubmit').textContent = setupRequired ? 'Create vault password' : 'Unlock vault'
  $('#masterPassword').required = setupRequired
  $('#confirmMasterPassword').required = setupRequired
  $('#unlockPassword').required = !setupRequired
  $('#lockError').classList.add('hidden')
  if (setupRequired) $('#masterPassword').focus()
  else $('#unlockPassword').focus()
}

async function loadSecuritySettings() {
  const settings = await api.getSettings()
  $('#autoLockMinutes').value = String(settings.autoLockMinutes)
  $('#clipboardTimeout').value = String(settings.clearClipboardSeconds)
}

$('#lockForm').addEventListener('submit', async event => {
  event.preventDefault()
  const submit = $('#lockSubmit')
  submit.disabled = true
  $('#lockError').classList.add('hidden')
  try {
    const status = await api.status()
    if (status.setupRequired) {
      await api.setupVault({ password: $('#masterPassword').value, confirmPassword: $('#confirmMasterPassword').value })
      $('#masterPassword').value = ''
      $('#confirmMasterPassword').value = ''
      showToast('Master password created. Vault encrypted.')
    } else {
      await api.unlockVault({ password: $('#unlockPassword').value })
      $('#unlockPassword').value = ''
      showToast('Vault unlocked.')
    }
    $('#lockScreen').classList.add('hidden')
    isVaultReady = true
    await refresh()
    await loadSecuritySettings()
  } catch (error) {
    $('#lockError').textContent = readableError(error)
    $('#lockError').classList.remove('hidden')
  } finally {
    submit.disabled = false
  }
})

function handleVaultLocked(payload = {}) {
  closeModal()
  state.groups = []
  state.secrets = []
  state.selectedSecretId = null
  state.selectedGroupId = null
  render()
  showLockScreen(false, payload.reason)
}
api.onVaultLocked(handleVaultLocked)
api.onVaultStatusUpdated(status => {
  if (status.locked && !$('#lockScreen').classList.contains('hidden')) return
  if (status.locked) handleVaultLocked({ reason: 'inactivity' })
})

$('#lockButton').addEventListener('click', async () => {
  try { await api.lockVault() } catch (error) { showToast(readableError(error), true) }
})
$('#lockNowSettings').addEventListener('click', async () => {
  try { await api.lockVault() } catch (error) { showToast(readableError(error), true) }
})
$('#saveSecuritySettings').addEventListener('click', async () => {
  try {
    await api.updateSettings({ autoLockMinutes: Number($('#autoLockMinutes').value), clearClipboardSeconds: Number($('#clipboardTimeout').value) })
    showToast('Security settings saved.')
  } catch (error) { showToast(readableError(error), true) }
})
$('#exportBackupButton').addEventListener('click', () => {
  openModal({
    title: 'Export encrypted backup',
    eyebrow: 'PROTECT YOUR BACKUP',
    submit: 'Choose backup location',
    body: field('Backup password', 'backupPassword', '', { type: 'password', required: true, full: true, autocomplete: 'new-password', placeholder: 'At least 12 characters' }) +
      field('Confirm backup password', 'confirmBackupPassword', '', { type: 'password', required: true, full: true, autocomplete: 'new-password', placeholder: 'Enter it again' }) +
      '<p class="field-hint full" style="grid-column:1/-1">This password encrypts the backup independently from your vault password. SecretStack cannot recover it.</p>',
    onSubmit: async form => {
      const password = String(form.get('backupPassword') || '')
      if (password.length < 12) throw Object.assign(new Error('Use at least 12 characters for the backup password.'), { code: 'WEAK_PASSWORD' })
      if (password !== form.get('confirmBackupPassword')) throw Object.assign(new Error('The backup passwords do not match.'), { code: 'PASSWORD_MISMATCH' })
      const result = await api.exportBackup({ password })
      if (result.canceled) showToast('Backup export cancelled.')
      else showToast('Encrypted backup exported.')
    }
  })
})
$('#importBackupButton').addEventListener('click', () => {
  openModal({
    title: 'Restore encrypted backup',
    eyebrow: 'RESTORE VAULT',
    submit: 'Choose backup file',
    body: field('Backup password', 'backupPassword', '', { type: 'password', required: true, full: true, autocomplete: 'current-password', placeholder: 'Password used when exporting' }) +
      '<p class="field-hint full" style="grid-column:1/-1">You will be shown a group and secret count, then asked to confirm before the current vault is replaced.</p>',
    onSubmit: async form => {
      const result = await api.importBackup({ password: String(form.get('backupPassword') || '') })
      if (result.canceled) showToast('Restore cancelled.')
      else { showToast('Backup restored: ' + result.groupCount + ' groups and ' + result.secretCount + ' secrets.'); state.selectedGroupId = null; state.selectedSecretId = null }
    }
  })
})

function reportActivity() {
  if (!isVaultReady) return
  const now = Date.now()
  if (now - lastActivityPing < 15000) return
  lastActivityPing = now
  api.activity().catch(() => {})
}
document.addEventListener('pointerdown', reportActivity, { passive: true })
document.addEventListener('pointermove', reportActivity, { passive: true })
document.addEventListener('keydown', event => {
  reportActivity()
  if (isVaultReady && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    api.lockVault().catch(() => {})
  }
})

async function init() {
  try {
    const status = await api.status()
    if (status.setupRequired) {
      showLockScreen(true)
      return
    }
    if (status.locked) {
      showLockScreen(false)
      return
    }
    isVaultReady = true
    if (!status.encryptionAvailable) showToast('Secure encryption is unavailable. Vault writes are blocked.', true)
    await refresh()
    await loadSecuritySettings()
  } catch (error) {
    document.body.innerHTML = '<main style="padding:48px;max-width:760px;margin:auto;color:#f2f2f2;font-family:system-ui"><p style="color:#00d992;letter-spacing:2px;font-size:10px">SECRETSTACK / STARTUP</p><h1>Vault could not be opened.</h1><p style="color:#bdbdbd;line-height:1.7">' + escapeHtml(readableError(error)) + '</p><p style="color:#8b949e">The original vault file has not been automatically overwritten. Review the local vault file before trying recovery steps.</p></main>'
  }
}

init()