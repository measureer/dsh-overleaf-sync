import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodePackedUtf8,
  encodePackedUtf8,
  linesToText,
  textToLines,
} from '../../lib/transport/packed.js'

const SAMPLES = [
  '',
  'single line',
  '\n',
  '\n\n',
  'trailing\n',
  'trailing\n\n',
  '中文\n混合 CRLF\r\nline',
  '  leading and trailing spaces  ',
  'a\tb\tc',
  'emoji 😀🎉 mixed with 汉字',
  '\\documentclass{article}\n\\end{document}\n',
]

describe('packed utf8', () => {
  it('decodes a latin1-wrapped utf8 line', () => {
    const packed = Buffer.from('中文 — café 😀', 'utf8').toString('latin1')
    assert.equal(decodePackedUtf8(packed), '中文 — café 😀')
  })

  it('encodes text into the latin1 wire form', () => {
    const text = '第一行\n第二行 🚀'
    const encoded = encodePackedUtf8(text)
    assert.equal(Buffer.from(encoded, 'latin1').toString('utf8'), text)
    // ASCII is unaffected by the packing.
    assert.equal(encodePackedUtf8('plain ascii'), 'plain ascii')
  })

  it('round-trips every sample through textToLines -> linesToText', () => {
    for (const sample of SAMPLES) {
      const lines = textToLines(sample)
      assert.equal(linesToText(lines), sample)
    }
  })

  it('textToLines splits on \\n and is the strict inverse of linesToText', () => {
    assert.deepEqual(textToLines(''), [''])
    assert.deepEqual(textToLines('a'), [encodePackedUtf8('a')])
    assert.deepEqual(textToLines('a\n'), [encodePackedUtf8('a'), ''])
    assert.deepEqual(textToLines('a\nb'), [encodePackedUtf8('a'), encodePackedUtf8('b')])
    // No extra sentinel line is appended.
    assert.equal(textToLines('a').length, 1)
  })
})

describe('joinDoc line handling (no sentinel)', () => {
  it('joins lines with \\n and keeps every trailing newline', () => {
    const a = encodePackedUtf8('a')
    const b = encodePackedUtf8('b')
    assert.equal(linesToText([]), '')
    assert.equal(linesToText(['']), '')
    assert.equal(linesToText([a]), 'a')
    assert.equal(linesToText([a, b]), 'a\nb')
    // a trailing empty line is a genuine trailing newline, not a sentinel
    assert.equal(linesToText([a, b, '']), 'a\nb\n')
    assert.equal(linesToText([a, b, '', '']), 'a\nb\n\n')
  })

  it('keeps genuine trailing newlines across a round trip', () => {
    assert.equal(linesToText(textToLines('a\nb\n')), 'a\nb\n')
    assert.equal(linesToText(textToLines('a\nb\n\n')), 'a\nb\n\n')
    // the lead's positive case: ['a', ''] <-> 'a\n'
    assert.deepEqual(textToLines('a\n'), [encodePackedUtf8('a'), ''])
    assert.equal(linesToText([encodePackedUtf8('a'), '']), 'a\n')
  })

  it('decodes a packed Chinese document from the server', () => {
    const wire = [
      Buffer.from('第一行', 'utf8').toString('latin1'),
      Buffer.from('第二行 😀', 'utf8').toString('latin1'),
    ]
    assert.equal(linesToText(wire), '第一行\n第二行 😀')
    // a real document ending with a newline comes back with it
    assert.equal(linesToText([...wire, '']), '第一行\n第二行 😀\n')
  })

  it('preserves CRLF text byte-for-byte', () => {
    assert.equal(linesToText(textToLines('a\r\nb\r\n')), 'a\r\nb\r\n')
  })
})
