import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureDir } from './fsUtil.js'

/** `sha256:<hex>` over raw bytes — the binary sibling of `fsUtil.sha256`. */
export function sha256Bytes(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/** Read a file as bytes; a missing file (or a directory) reads as `undefined`. */
export async function readBytesIfExists(file: string): Promise<Uint8Array | undefined> {
  try {
    return await fs.readFile(file)
  } catch {
    return undefined
  }
}

/** Same temp-file-then-rename dance as `atomicWrite`, but binary safe. */
export async function atomicWriteBytes(file: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, data)
    await fs.rename(temp, file)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}
