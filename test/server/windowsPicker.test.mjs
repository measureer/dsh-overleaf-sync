import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickViaWindows, windowsPickerAvailable } from '../../lib/server/windowsPicker.js'

test('windowsPickerAvailable answers without throwing on any platform', () => {
  assert.equal(typeof windowsPickerAvailable(), 'boolean')
})

test('pickViaWindows gives up instead of hanging when the host has no PowerShell', async () => {
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir }
  process.env.SystemRoot = 'C:\no-such-windows-root'
  process.env.windir = 'C:\no-such-windows-root'
  try {
    assert.equal(windowsPickerAvailable(), false)
    assert.equal(await pickViaWindows(), undefined)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('pickViaWindows stops cleanly when the caller aborts', async () => {
  if (!windowsPickerAvailable()) return
  const controller = new AbortController()
  const pending = pickViaWindows(controller.signal)
  controller.abort()
  // Must not reject: an abort is reported as "no dialog", never a cancel.
  assert.equal(await pending, undefined)
})
