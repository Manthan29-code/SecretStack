function createClipboardSafety({ clipboard, log = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = () => Date.now() }) {
  let timer = null
  let copiedValue = null
  let copiedAt = null
  let timerToken = 0

  function cancelTimer(reason = 'replaced') {
    if (timer !== null) {
      clearTimeoutFn(timer)
      log('timer-cancelled', { reason, elapsedMs: copiedAt === null ? null : now() - copiedAt })
    }
    timer = null
    timerToken += 1
  }

  function clearIfUnchanged(expectedValue, reason, startedAt, timeoutMs = null) {
    try {
      const matches = clipboard.readText() === expectedValue
      if (!matches) {
        log('clipboard-preserved', {
          reason,
          clipboardMatchedSecret: false,
          elapsedMs: now() - startedAt,
          configuredTimeoutMs: timeoutMs,
          note: 'Current clipboard differs from the copied secret; it was not modified. Windows Clipboard History is separate and is not controlled by Electron clipboard.clear().'
        })
        return false
      }

      clipboard.clear()
      let currentClipboardEmpty = false
      try {
        currentClipboardEmpty = clipboard.readText() === ''
      } catch {}

      log('clipboard-cleared', {
        reason,
        clipboardMatchedSecret: true,
        currentClipboardEmpty,
        elapsedMs: now() - startedAt,
        configuredTimeoutMs: timeoutMs,
        windowsClipboardHistoryCleared: false,
        note: 'Only the current clipboard was cleared. Windows Clipboard History can retain a historical copy and must be managed separately by Windows.'
      })
      return true
    } catch (error) {
      log('clipboard-check-failed', {
        reason,
        elapsedMs: now() - startedAt,
        errorName: error?.name || 'Error',
        note: 'Could not verify or clear the current clipboard. Windows Clipboard History is not controlled by this operation.'
      })
      return false
    }
  }

  function copy(value, seconds) {
    const requestedAt = now()
    clipboard.writeText(value)
    cancelTimer('new-copy')
    copiedValue = value
    copiedAt = requestedAt

    const delaySeconds = Number(seconds)
    const delayMs = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : 0
    log('secret-copied', {
      configuredTimeoutSeconds: delaySeconds,
      configuredTimeoutMs: delayMs,
      copiedAt: new Date(requestedAt).toISOString(),
      scheduledClearAt: delayMs ? new Date(requestedAt + delayMs).toISOString() : null,
      autoClearEnabled: delayMs > 0,
      windowsClipboardHistoryCleared: false
    })

    if (delayMs > 0) {
      const expectedValue = value
      const startedAt = requestedAt
      const token = timerToken
      timer = setTimeoutFn(() => {
        if (token !== timerToken) return
        const firedAt = now()
        log('timer-fired', {
          firedAt: new Date(firedAt).toISOString(),
          elapsedMs: firedAt - startedAt,
          configuredTimeoutMs: delayMs,
          timingDifferenceMs: (firedAt - startedAt) - delayMs
        })
        clearIfUnchanged(expectedValue, 'timeout', startedAt, delayMs)
        if (copiedValue === expectedValue) {
          copiedValue = null
          copiedAt = null
        }
        timer = null
      }, delayMs)
    } else {
      copiedValue = null
      copiedAt = null
    }

    return { copied: true, clipboardClearSeconds: Number.isFinite(delaySeconds) ? delaySeconds : 0 }
  }

  function clearNow(reason = 'vault-lock') {
    cancelTimer(reason)
    if (copiedValue !== null && copiedAt !== null) {
      clearIfUnchanged(copiedValue, reason, copiedAt)
    } else {
      log('clear-skipped', { reason, why: 'no-active-secret-copy' })
    }
    copiedValue = null
    copiedAt = null
  }

  return { copy, clearNow }
}

module.exports = { createClipboardSafety }
