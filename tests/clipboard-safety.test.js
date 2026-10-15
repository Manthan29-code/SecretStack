const test = require('node:test')
const assert = require('node:assert/strict')
const { createClipboardSafety } = require('../electron/clipboard-safety')

function fakeClipboard(initial = '') {
  return {
    value: initial,
    writes: [],
    clears: 0,
    writeText(value) { this.value = value; this.writes.push(value) },
    readText() { return this.value },
    clear() { this.value = ''; this.clears += 1 }
  }
}

function fakeTimers() {
  let nextId = 1
  const timers = new Map()
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeoutFn(id) { timers.delete(id) },
    runNext() {
      const entry = timers.entries().next().value
      assert.ok(entry, 'expected a pending timer')
      const [id, timer] = entry
      timers.delete(id)
      timer.callback()
      return timer.delay
    },
    get size() { return timers.size }
  }
}

test('clears copied secret when configured timeout elapses', () => {
  const clipboard = fakeClipboard()
  const timers = fakeTimers()
  const safety = createClipboardSafety({ clipboard, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })

  const result = safety.copy('dummy-secret-value', 30)
  assert.deepEqual(result, { copied: true, clipboardClearSeconds: 30 })
  assert.equal(clipboard.readText(), 'dummy-secret-value')
  assert.equal(timers.size, 1)
  assert.equal(timers.runNext(), 30000)
  assert.equal(clipboard.readText(), '')
  assert.equal(clipboard.clears, 1)
})

test('does not clear clipboard if user copied different text before timeout', () => {
  const clipboard = fakeClipboard()
  const timers = fakeTimers()
  const safety = createClipboardSafety({ clipboard, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })

  safety.copy('dummy-secret-value', 15)
  clipboard.writeText('user copied something else')
  timers.runNext()

  assert.equal(clipboard.readText(), 'user copied something else')
  assert.equal(clipboard.clears, 0)
})

test('a later secret copy replaces the previous timeout', () => {
  const clipboard = fakeClipboard()
  const timers = fakeTimers()
  const safety = createClipboardSafety({ clipboard, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })

  safety.copy('first-dummy-secret', 30)
  safety.copy('second-dummy-secret', 15)
  assert.equal(timers.size, 1)
  assert.equal(clipboard.readText(), 'second-dummy-secret')
  assert.equal(timers.runNext(), 15000)
  assert.equal(clipboard.readText(), '')
})

test('zero timeout disables automatic clearing', () => {
  const clipboard = fakeClipboard()
  const timers = fakeTimers()
  const safety = createClipboardSafety({ clipboard, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })

  safety.copy('dummy-secret-value', 0)
  assert.equal(clipboard.readText(), 'dummy-secret-value')
  assert.equal(timers.size, 0)
})

test('clears clipboard on lock only when it still contains SecretStack copied value', () => {
  const clipboard = fakeClipboard()
  const timers = fakeTimers()
  const safety = createClipboardSafety({ clipboard, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })

  safety.copy('dummy-secret-value', 30)
  safety.clearNow()
  assert.equal(clipboard.readText(), '')
  assert.equal(timers.size, 0)

  clipboard.writeText('keep this user text')
  safety.copy('another-dummy-secret', 30)
  clipboard.writeText('keep this user text')
  safety.clearNow()
  assert.equal(clipboard.readText(), 'keep this user text')
})
