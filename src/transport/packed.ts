/**
 * Wire encoding helpers for Overleaf/ShareJS text documents.
 *
 * `joinDoc` returns the document as an array of lines, but each line is not a
 * normal string: it is the UTF-8 byte sequence of the line, stored one byte
 * per UTF-16 code unit (i.e. `Buffer.from(text, 'utf8').toString('latin1')`).
 * Text has to be converted back before it is written to disk, otherwise every
 * non-ASCII character shows up as mojibake.
 *
 * The line array is also how the document's trailing newline is represented:
 * the text of a document is exactly its lines joined with `\n`. There is no
 * extra sentinel line on the wire — a document ending with `\n` simply has a
 * trailing empty line in the array — so `linesToText` and `textToLines` are
 * strict inverses of each other (`split('\n')` / `join('\n')`).
 */

/** Decode one packed line (`latin1`-wrapped UTF-8) back into real text. */
export function decodePackedUtf8(line: string): string {
  return Buffer.from(line, 'latin1').toString('utf8')
}

/** Encode real text into the `latin1`-wrapped UTF-8 form used on the wire. */
export function encodePackedUtf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

/**
 * Decode the `joinDoc` line array into document text: decode every line and
 * join with `\n`. A trailing empty line stays a trailing newline.
 */
export function linesToText(lines: string[]): string {
  return lines.map(decodePackedUtf8).join('\n')
}

/**
 * Encode document text into the line array expected by ShareJS: split on `\n`
 * and pack every line. Strict inverse of `linesToText`.
 */
export function textToLines(text: string): string[] {
  return text.split('\n').map(encodePackedUtf8)
}
