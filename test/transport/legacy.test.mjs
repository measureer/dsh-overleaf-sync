import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { after, describe, test } from 'node:test'

import {
  LegacyOverleafSocket,
  WebSocketFrameParser,
  acceptKeyFor,
  decodePacket,
  decodePayload,
  detectSocketProtocol,
  encodeAckPacket,
  encodeConnectPacket,
  encodeDisconnectPacket,
  encodeErrorPacket,
  encodeEventPacket,
  encodeHeartbeatPacket,
  encodeWebSocketFrame,
  parseHandshakeResponse,
} from '../../lib/transport/legacy.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ---------------------------------------------------------------------------
// Test-side RFC6455 helpers (deliberately independent of the implementation)
// ---------------------------------------------------------------------------

/** Build an unmasked server frame with a correct length header. */
function serverFrame(payload, opcode = 1) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

/** Parse one client frame; returns `{ frame, rest }` or null when incomplete. */
function parseClientFrame(buffer) {
  if (buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
  if (mask !== undefined) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return {
    frame: { fin, opcode, masked, payload },
    rest: buffer.subarray(offset + maskLength + length),
  }
}

const CLIENT_PACKET_RE = /^(\d):(\d+)?(\+)?:([^:]*)?:?([\s\S]*)$/

/** Minimal server-side socket.io 0.9 packet reader. */
function parseClientText(text) {
  const match = CLIENT_PACKET_RE.exec(text)
  if (match === null) return { type: -1, ackId: '', name: '', args: [], raw: text }
  const packet = {
    type: Number(match[1]),
    ackId: match[2] ?? '',
    ackRequested: match[3] === '+',
    endpoint: match[4] ?? '',
    raw: match[5] ?? '',
    name: '',
    args: [],
  }
  if (packet.type === 5 && packet.raw.length > 0) {
    try {
      const value = JSON.parse(packet.raw)
      packet.name = typeof value.name === 'string' ? value.name : ''
      packet.args = Array.isArray(value.args) ? value.args : []
    } catch {
      // leave name empty
    }
  }
  return packet
}

// ---------------------------------------------------------------------------
// Fake socket.io 0.9 server
// ---------------------------------------------------------------------------

/**
 * A local stand-in for the self-hosted Overleaf socket.io endpoint: plain HTTP
 * handshake, a hand-written 101 upgrade response and unmasked server frames.
 */
async function startFakeServer(options = {}) {
  const state = {
    requests: [],
    frames: [],
    packets: [],
    sockets: new Set(),
    joinPayload: undefined,
    rejections: 0,
  }
  const handshakeBody = options.handshake ?? 'FAKE-SID-1:60:60:websocket,xhr-polling'
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers, upgraded: false })
    if (options.handshakeStatus !== undefined) {
      res.writeHead(options.handshakeStatus, { 'Content-Type': 'text/html' })
      res.end(options.handshakeStatus === 200 ? handshakeBody : '<html>nope</html>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' })
    res.end(handshakeBody)
  })

  const writeFrame = (buffer) => {
    for (const socket of state.sockets) {
      if (!socket.destroyed) socket.write(buffer)
    }
  }
  const send = (text) => writeFrame(serverFrame(text))
  const sendRaw = (buffer) => writeFrame(buffer)
  const ack = (ackId, args) => send(`6:::${ackId}+${JSON.stringify(args)}`)

  const handlePacket = (packet) => {
    if (packet.type === 4) return
    if (packet.type === 2) return
    if (options.silent === true) return
    if (packet.type === 1) {
      if (options.connectReply !== false) send('1::')
      return
    }
    if (packet.type !== 5) return
    if (packet.name === 'joinProject') {
      state.joinPayload = packet.args[0]
      if (options.joinMode === 'error') {
        send('7:::2+0')
        return
      }
      if (options.joinMode === 'ack' && packet.ackId.length > 0) {
        ack(packet.ackId, [options.joinResult ?? { publicId: 'public-1' }])
        return
      }
      if (options.joinMode === 'silent') return
      send(
        `5:::${JSON.stringify({
          name: 'joinProjectResponse',
          args: [options.joinResult ?? { publicId: 'public-1', project: { name: 'Fake Project' } }],
        })}`,
      )
      return
    }
    if (packet.name === 'joinDoc' && packet.ackId.length > 0) {
      ack(packet.ackId, [
        ['first line', 'second line'],
        { version: 7, encodeRanges: true },
      ])
      return
    }
    if (packet.name === 'pushBack') {
      send(`5:::${JSON.stringify({ name: 'clientTracking', args: [{ clients: [] }] })}`)
    }
  }

  server.on('upgrade', (req, socket, head) => {
    state.requests.push({ url: req.url, headers: req.headers, upgraded: true })
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept =
      options.acceptOverride ??
      createHash('sha1')
        .update(`${key}${WS_GUID}`)
        .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (options.acceptOverride !== undefined) {
      socket.destroy()
      return
    }
    // Mimic the fork's proxy: some upgrades land on a backend that never saw
    // the handshake, answer `7:::1+0` and hang up.
    if (state.rejections < (options.rejectUpgrades ?? 0)) {
      state.rejections += 1
      socket.write(serverFrame('7:::1+0'))
      socket.end()
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    state.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    const feed = (chunk) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
      for (;;) {
        const parsed = parseClientFrame(buffer)
        if (parsed === null) return
        buffer = parsed.rest
        state.frames.push(parsed.frame)
        if (parsed.frame.opcode === 1) {
          const packet = parseClientText(parsed.frame.payload.toString('utf8'))
          state.packets.push(packet)
          handlePacket(packet)
        }
      }
    }
    socket.on('data', feed)
    socket.on('close', () => state.sockets.delete(socket))
    socket.on('error', () => state.sockets.delete(socket))
    if (options.autoConnect === true) {
      // The fork connects — and joins the project — without being asked.
      socket.write(serverFrame('1::'))
      if (options.autoJoin === true) {
        socket.write(
          serverFrame(
            `5:::${JSON.stringify({
              name: 'joinProjectResponse',
              args: [options.joinResult ?? { publicId: 'auto-1', project: { name: 'Auto Joined' } }],
            })}`,
          ),
        )
      }
    }
    if (head !== undefined && head.length > 0) feed(head)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    port,
    state,
    baseUrl: `http://127.0.0.1:${port}/`,
    send,
    sendRaw,
    close: () =>
      new Promise((resolve) => {
        for (const socket of state.sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

const servers = []
async function withServer(options) {
  const fake = await startFakeServer(options)
  servers.push(fake)
  return fake
}
after(async () => {
  await Promise.all(servers.map((fake) => fake.close()))
})

const CREDENTIALS = { cookie: 'overleaf_session2=abc123; GCLB=xyz' }

// ---------------------------------------------------------------------------
// socket.io 0.9 packet encoding
// ---------------------------------------------------------------------------

describe('socket.io 0.9 packet encoding', () => {
  test('encodes fire-and-forget event packets', () => {
    assert.equal(
      encodeEventPacket('joinProject', [{ project_id: 'p1', user_id: null }]),
      '5:::{"name":"joinProject","args":[{"project_id":"p1","user_id":null}]}',
    )
    assert.equal(encodeEventPacket('serverPing'), '5:::{"name":"serverPing"}')
    assert.equal(encodeEventPacket('serverPing', []), '5:::{"name":"serverPing"}')
  })

  test('encodes event packets that request an ack', () => {
    assert.equal(
      encodeEventPacket('joinDoc', ['doc-1', { encodeRanges: true }], '4'),
      '5:4+::{"name":"joinDoc","args":["doc-1",{"encodeRanges":true}]}',
    )
  })

  test('encodes connect, heartbeat, ack, error and disconnect packets', () => {
    assert.equal(encodeConnectPacket(), '1::')
    assert.equal(encodeConnectPacket('/chat'), '1::/chat')
    assert.equal(encodeHeartbeatPacket(), '2::')
    assert.equal(encodeDisconnectPacket(), '0::')
    assert.equal(encodeAckPacket('3', [{ ok: true }]), '6:::3+[{"ok":true}]')
    assert.equal(encodeAckPacket('3'), '6:::3')
    assert.equal(encodeErrorPacket(2), '7:::2')
    assert.equal(encodeErrorPacket(2, 0), '7:::2+0')
  })
})

describe('socket.io 0.9 packet decoding', () => {
  test('decodes connect, heartbeat and disconnect packets', () => {
    assert.deepEqual(
      pick(decodePacket('1::')),
      { type: 'connect', id: '', endpoint: '', ackData: false },
    )
    assert.equal(decodePacket('1::/chat').endpoint, '/chat')
    assert.equal(decodePacket('2::').type, 'heartbeat')
    assert.equal(decodePacket('0::').type, 'disconnect')
  })

  test('decodes pushed event packets', () => {
    const packet = decodePacket('5:::{"name":"joinProjectResponse","args":[{"publicId":"abc"}]}')
    assert.equal(packet.type, 'event')
    assert.equal(packet.name, 'joinProjectResponse')
    assert.deepEqual(packet.args, [{ publicId: 'abc' }])
    assert.equal(packet.id, '')
  })

  test('decodes an event that asked for an ack', () => {
    const packet = decodePacket('5:1+::{"name":"joinDoc","args":["doc-1"]}')
    assert.equal(packet.type, 'event')
    assert.equal(packet.id, '1')
    assert.equal(packet.ackData, true)
    assert.equal(packet.name, 'joinDoc')
    assert.deepEqual(packet.args, ['doc-1'])
  })

  test('decodes ack packets and their argument array', () => {
    const withArgs = decodePacket('6:::7+[["line"],{"version":3}]')
    assert.equal(withArgs.type, 'ack')
    assert.equal(withArgs.ackId, '7')
    assert.deepEqual(withArgs.args, [['line'], { version: 3 }])

    const bare = decodePacket('6:::7')
    assert.equal(bare.ackId, '7')
    assert.deepEqual(bare.args, [])
  })

  test('decodes error packets into reason and advice', () => {
    const unauthorized = decodePacket('7:::2+0')
    assert.equal(unauthorized.type, 'error')
    assert.equal(unauthorized.reason, 'unauthorized')
    assert.equal(unauthorized.advice, 'reconnect')
    assert.equal(unauthorized.raw, '2+0')

    const transport = decodePacket('7:::0')
    assert.equal(transport.reason, 'transport not supported')
    assert.equal(transport.advice, undefined)
  })

  test('decodes message and json packets', () => {
    const message = decodePacket('3:::hello there')
    assert.equal(message.type, 'message')
    assert.equal(message.data, 'hello there')

    const json = decodePacket('4:::{"a":1}')
    assert.equal(json.type, 'json')
    assert.deepEqual(json.data, { a: 1 })
  })

  test('drops unknown packet types and survives malformed json', () => {
    assert.equal(decodePacket('9::'), undefined)
    assert.equal(decodePacket('not a packet'), undefined)
    const broken = decodePacket('5:::{oops')
    assert.equal(broken.type, 'event')
    assert.equal(broken.name, undefined)
    assert.deepEqual(broken.args, [])
  })

  test('decodes batched payloads', () => {
    const first = '2::'
    const second = '5:::{"name":"a","args":[1]}'
    const batch = `\ufffd${first.length}\ufffd${first}\ufffd${second.length}\ufffd${second}`
    const packets = decodePayload(batch)
    assert.equal(packets.length, 2)
    assert.equal(packets[0].type, 'heartbeat')
    assert.equal(packets[1].name, 'a')
  })

  test('decodes a single unbatched payload', () => {
    const packets = decodePayload('1::')
    assert.equal(packets.length, 1)
    assert.equal(packets[0].type, 'connect')
  })
})

function pick(packet, keys = ['type', 'id', 'endpoint', 'ackData']) {
  const result = {}
  for (const key of keys) result[key] = packet[key]
  return result
}

// ---------------------------------------------------------------------------
// handshake parsing
// ---------------------------------------------------------------------------

describe('handshake parsing', () => {
  test('parses the socket.io 0.9 handshake body', () => {
    const handshake = parseHandshakeResponse('AbCdEf123456:60:60:websocket,xhr-polling\n')
    assert.equal(handshake.sid, 'AbCdEf123456')
    assert.equal(handshake.heartbeatTimeoutMs, 60_000)
    assert.equal(handshake.closeTimeoutMs, 60_000)
    assert.deepEqual(handshake.transports, ['websocket', 'xhr-polling'])
  })

  test('rejects bodies that are not a 0.9 handshake', () => {
    for (const body of ['', '<html>login</html>', 'abc:0:0:websocket', 'noseparator:60']) {
      assert.throws(
        () => parseHandshakeResponse(body),
        (error) => error.code === 'E_TRANSPORT',
        `expected E_TRANSPORT for ${JSON.stringify(body)}`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// RFC6455 framing
// ---------------------------------------------------------------------------

describe('websocket framing', () => {
  test('masks small client frames', () => {
    const frame = encodeWebSocketFrame('hi')
    assert.equal(frame[0], 0x81)
    assert.equal(frame[1], 0x80 | 2)
    assert.equal(frame.length, 2 + 4 + 2)
    const parsed = parseClientFrame(frame)
    assert.equal(parsed.frame.masked, true)
    assert.equal(parsed.frame.opcode, 1)
    assert.equal(parsed.frame.payload.toString('utf8'), 'hi')
  })

  test('uses the 16 bit length form for medium payloads', () => {
    const text = 'x'.repeat(300)
    const frame = encodeWebSocketFrame(text)
    assert.equal(frame[0], 0x81)
    assert.equal(frame[1] & 0x7f, 126)
    assert.equal(frame.readUInt16BE(2), 300)
    assert.equal(parseClientFrame(frame).frame.payload.toString('utf8'), text)
  })

  test('uses the 64 bit length form for large payloads', () => {
    const text = 'y'.repeat(70_000)
    const frame = encodeWebSocketFrame(text)
    assert.equal(frame[1] & 0x7f, 127)
    assert.equal(Number(frame.readBigUInt64BE(2)), 70_000)
    const payload = parseClientFrame(frame).frame.payload
    assert.equal(payload.length, 70_000)
    assert.equal(payload.toString('utf8'), text)
  })

  test('encodes control frames with an explicit opcode', () => {
    const frame = encodeWebSocketFrame('bye', { opcode: 8 })
    assert.equal(frame[0] & 0x0f, 8)
    assert.equal(parseClientFrame(frame).frame.payload.toString('utf8'), 'bye')
    const fragmented = encodeWebSocketFrame('part', { fin: false })
    assert.equal(fragmented[0] & 0x80, 0)
  })

  test('parses a server frame split across chunk boundaries', () => {
    const frame = serverFrame('5:::{"name":"joinProjectResponse","args":[{"publicId":"abc"}]}')
    for (let split = 1; split < frame.length; split += 1) {
      const parser = new WebSocketFrameParser()
      const first = parser.push(frame.subarray(0, split))
      const second = parser.push(frame.subarray(split))
      assert.equal(first.length, 0, `no frame before split ${split} completes`)
      assert.equal(second.length, 1, `exactly one frame at split ${split}`)
      assert.equal(second[0].opcode, 1)
      assert.equal(second[0].fin, true)
      assert.equal(
        second[0].payload.toString('utf8'),
        '5:::{"name":"joinProjectResponse","args":[{"publicId":"abc"}]}',
      )
    }
  })

  test('parses several frames delivered in one chunk', () => {
    const parser = new WebSocketFrameParser()
    const frames = parser.push(
      Buffer.concat([serverFrame('1::'), serverFrame('2::'), serverFrame('x'.repeat(130))]),
    )
    assert.equal(frames.length, 3)
    assert.equal(frames[0].payload.toString('utf8'), '1::')
    assert.equal(frames[2].payload.length, 130)
    assert.equal(parser.bufferedBytes, 0)
  })

  test('parses large 64 bit server frames', () => {
    const text = 'z'.repeat(80_000)
    const parser = new WebSocketFrameParser()
    const frames = parser.push(serverFrame(text))
    assert.equal(frames.length, 1)
    assert.equal(frames[0].payload.length, 80_000)
  })

  test('computes the Sec-WebSocket-Accept example from RFC 6455', () => {
    assert.equal(acceptKeyFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})

// ---------------------------------------------------------------------------
// LegacyOverleafSocket against the fake server
// ---------------------------------------------------------------------------

describe('LegacyOverleafSocket', () => {
  test('connects through the websocket upgrade and resolves joinProjectResponse', async () => {
    const fake = await withServer({
      joinResult: { publicId: 'public-42', project: { name: 'Fake Project' } },
    })
    const debug = []
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-1',
      ...CREDENTIALS,
      onDebug: (message) => debug.push(message),
    })
    try {
      assert.equal(socket.socketId, 'FAKE-SID-1')
      assert.equal(socket.projectId, 'proj-1')
      assert.equal(socket.closed, false)
      assert.deepEqual(socket.payload, {
        publicId: 'public-42',
        project: { name: 'Fake Project' },
      })
      assert.deepEqual(socket.joinProjectResult, {
        payload: { publicId: 'public-42', project: { name: 'Fake Project' } },
        socketId: 'FAKE-SID-1',
      })

      const handshake = fake.state.requests.find((request) => !request.upgraded)
      assert.match(handshake.url, /^\/socket\.io\/1\/\?projectId=proj-1&t=\d+$/)
      assert.equal(handshake.headers.cookie, CREDENTIALS.cookie)

      const upgrade = fake.state.requests.find((request) => request.upgraded)
      assert.equal(upgrade.url, '/socket.io/1/websocket/FAKE-SID-1')
      assert.equal(upgrade.headers.cookie, CREDENTIALS.cookie)
      assert.equal(upgrade.headers.origin, fake.baseUrl.replace(/\/$/, ''))
      assert.equal(upgrade.headers['sec-websocket-version'], '13')
      assert.equal(
        Buffer.from(upgrade.headers['sec-websocket-key'], 'base64').length,
        16,
      )

      const join = fake.state.packets.find((packet) => packet.name === 'joinProject')
      assert.equal(join.args[0].project_id, 'proj-1')
      assert.equal(join.args[0].user_id, null)
      assert.match(join.args[0].client_now, /^\d{4}-\d\d-\d\dT/)
      assert.equal(join.ackRequested, true)

      assert.ok(debug.some((line) => line.includes('joinProject completed via event:joinProjectResponse')))
    } finally {
      socket.close()
    }
    assert.equal(socket.closed, true)
  })

  test('connects when the server pushes 1:: and joinProjectResponse by itself', async () => {
    const fake = await withServer({
      autoConnect: true,
      autoJoin: true,
      joinResult: { publicId: 'auto-1', project: { name: 'Auto Joined' } },
    })
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-auto',
      ...CREDENTIALS,
    })
    try {
      assert.deepEqual(socket.payload, { publicId: 'auto-1', project: { name: 'Auto Joined' } })
      assert.equal(socket.joinProjectResult.socketId, 'FAKE-SID-1')
      assert.deepEqual(
        fake.state.packets,
        [],
        'the client must not replay 1:: / joinProject the server already handled',
      )
      assert.equal(fake.state.requests.filter((request) => request.upgraded).length, 1)
    } finally {
      socket.close()
    }
  })

  test('retries a refused upgrade with the same sid instead of giving up', async () => {
    const fake = await withServer({ rejectUpgrades: 2, joinResult: { publicId: 'after-retry' } })
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-retry',
      ...CREDENTIALS,
    })
    try {
      assert.deepEqual(socket.payload, { publicId: 'after-retry' })
      const upgrades = fake.state.requests.filter((request) => request.upgraded)
      assert.equal(upgrades.length, 3, 'two refusals, then the accepted upgrade')
      assert.deepEqual(new Set(upgrades.map((request) => request.url)), new Set([
        '/socket.io/1/websocket/FAKE-SID-1',
      ]))
      assert.equal(
        fake.state.requests.filter((request) => !request.upgraded).length,
        1,
        'a refused upgrade does not cost a new handshake',
      )
    } finally {
      socket.close()
    }
  })

  test('accepts an ack-style joinProject reply', async () => {    const fake = await withServer({ joinMode: 'ack', joinResult: { publicId: 'acked' } })
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-2',
      ...CREDENTIALS,
    })
    try {
      assert.deepEqual(socket.payload, { publicId: 'acked' })
    } finally {
      socket.close()
    }
  })

  test('turns a 7:: error frame during connect into an error that keeps the raw frame', async () => {
    const fake = await withServer({ joinMode: 'error' })
    await assert.rejects(
      LegacyOverleafSocket.connect({
        baseUrl: fake.baseUrl,
        projectId: 'proj-3',
        ...CREDENTIALS,
      }),
      (error) => {
        assert.equal(error.code, 'E_TRANSPORT')
        assert.match(error.message, /7:::2\+0/)
        assert.match(error.hint ?? '', /unauthorized/)
        return true
      },
    )
    assert.equal(
      fake.state.requests.filter((request) => request.upgraded).length,
      1,
      'an authorization error is final, not a retryable upgrade refusal',
    )
  })

  test('rejects a non socket.io 0.9 handshake body', async () => {
    const fake = await withServer({ handshake: '<html>login</html>' })
    await assert.rejects(
      LegacyOverleafSocket.connect({
        baseUrl: fake.baseUrl,
        projectId: 'proj-4',
        ...CREDENTIALS,
      }),
      (error) => error.code === 'E_TRANSPORT' && /handshake returned an unexpected body/.test(error.message),
    )
  })

  test('rejects an invalid Sec-WebSocket-Accept header', async () => {
    const fake = await withServer({ acceptOverride: 'wrong-value' })
    await assert.rejects(
      LegacyOverleafSocket.connect({
        baseUrl: fake.baseUrl,
        projectId: 'proj-5',
        ...CREDENTIALS,
      }),
      (error) => error.code === 'E_TRANSPORT' && /Sec-WebSocket-Accept/.test(error.message),
    )
  })

  test('times out when the server never answers the connect packet', async () => {
    const fake = await withServer({ silent: true })
    await assert.rejects(
      LegacyOverleafSocket.connect({
        baseUrl: fake.baseUrl,
        projectId: 'proj-6',
        ...CREDENTIALS,
        timeoutMs: 400,
      }),
      (error) => error.code === 'E_TIMEOUT',
    )
  })

  test('rejects connect when the abort signal fires', async () => {
    const fake = await withServer({ silent: true })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      LegacyOverleafSocket.connect({
        baseUrl: fake.baseUrl,
        projectId: 'proj-7',
        ...CREDENTIALS,
        signal: controller.signal,
      }),
      (error) => error.code === 'E_TRANSPORT' && /cancelled/.test(error.message),
    )
  })

  test('delivers pushed events to on(), onArgs() and onAny() and unsubscribes', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-8',
      ...CREDENTIALS,
    })
    const seen = []
    const raw = []
    const any = []
    const off = socket.on('clientTracking', (payload) => seen.push(payload))
    socket.onArgs('clientTracking', (args) => raw.push(args))
    socket.onAny((event, args) => any.push([event, args]))
    try {
      socket.emit('pushBack', [])
      await waitFor(() => seen.length === 1)
      assert.deepEqual(seen[0], { clients: [] })
      assert.deepEqual(raw[0], [{ clients: [] }])
      assert.equal(any[0][0], 'clientTracking')
      assert.deepEqual(any[0][1], [{ clients: [] }])

      off()
      socket.emit('pushBack', [])
      await waitFor(() => any.length === 2)
      assert.equal(seen.length, 1, 'the removed listener must not fire again')
    } finally {
      socket.close()
    }
  })

  test('emitWithAck resolves with the ack argument array', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-9',
      ...CREDENTIALS,
    })
    try {
      const args = await socket.emitWithAck('joinDoc', ['doc-1', { encodeRanges: true }], 2_000)
      assert.deepEqual(args, [['first line', 'second line'], { version: 7, encodeRanges: true }])
      const sent = fake.state.packets.find((packet) => packet.name === 'joinDoc')
      assert.equal(sent.ackRequested, true)
      assert.deepEqual(sent.args, ['doc-1', { encodeRanges: true }])
    } finally {
      socket.close()
    }
  })

  test('emitWithAck times out with E_TIMEOUT', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-10',
      ...CREDENTIALS,
    })
    try {
      await assert.rejects(
        socket.emitWithAck('neverAnswered', [], 150),
        (error) => error.code === 'E_TIMEOUT' && /neverAnswered/.test(error.message),
      )
    } finally {
      socket.close()
    }
  })

  test('close() is idempotent and rejects pending acks', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-11',
      ...CREDENTIALS,
    })
    const pending = socket.emitWithAck('neverAnswered', [], 5_000)
    socket.close()
    socket.close()
    assert.equal(socket.closed, true)
    await assert.rejects(pending, (error) => error.code === 'E_TRANSPORT')
    assert.throws(() => socket.emit('pushBack', []), (error) => error.code === 'E_TRANSPORT')
    // A joined socket keeps reporting its project after close.
    assert.equal(socket.projectId, 'proj-11')
  })

  test('echoes server heartbeats and answers ping frames with pong', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-12',
      ...CREDENTIALS,
    })
    try {
      fake.send('2::')
      await waitFor(() => fake.state.packets.some((packet) => packet.type === 2))
      fake.sendRaw(serverFrame('hi', 9))
      await waitFor(() => fake.state.frames.some((frame) => frame.opcode === 10))
      const pong = fake.state.frames.find((frame) => frame.opcode === 10)
      assert.equal(pong.payload.toString('utf8'), 'hi')
      assert.equal(socket.closed, false)
    } finally {
      socket.close()
    }
  })

  test('closes when the server sends a close frame', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: fake.baseUrl,
      projectId: 'proj-13',
      ...CREDENTIALS,
    })
    assert.equal(socket.closed, false)
    fake.sendRaw(serverFrame(Buffer.alloc(0), 8))
    await waitFor(() => socket.closed)
  })

  test('supports a sub-path baseUrl', async () => {
    const fake = await withServer({})
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: `http://127.0.0.1:${fake.port}/overleaf/`,
      projectId: 'proj-14',
      ...CREDENTIALS,
    })
    try {
      assert.match(fake.state.requests[0].url, /^\/overleaf\/socket\.io\/1\/\?/)
      const upgrade = fake.state.requests.find((request) => request.upgraded)
      assert.equal(upgrade.url, '/overleaf/socket.io/1/websocket/FAKE-SID-1')
      assert.equal(upgrade.headers.origin, `http://127.0.0.1:${fake.port}`)
    } finally {
      socket.close()
    }
  })

  test('rejects constructor-level misconfiguration with E_CONFIG', async () => {
    await assert.rejects(
      LegacyOverleafSocket.connect({ baseUrl: '', projectId: 'p', cookie: 'c=1' }),
      (error) => error.code === 'E_CONFIG',
    )
    await assert.rejects(
      LegacyOverleafSocket.connect({ baseUrl: 'ftp://example.test/', projectId: 'p', cookie: 'c=1' }),
      (error) => error.code === 'E_CONFIG',
    )
    await assert.rejects(
      LegacyOverleafSocket.connect({
        baseUrl: 'http://127.0.0.1:1/',
        projectId: '',
        cookie: 'c=1',
      }),
      (error) => error.code === 'E_CONFIG',
    )
    await assert.rejects(
      LegacyOverleafSocket.connect({ baseUrl: 'http://127.0.0.1:1/', projectId: 'p', cookie: '' }),
      (error) => error.code === 'E_CONFIG',
    )
  })
})

// ---------------------------------------------------------------------------
// detectSocketProtocol
// ---------------------------------------------------------------------------

describe('detectSocketProtocol', () => {
  test("reports 'legacy' for a server that answers the 0.9 handshake", async () => {
    const fake = await withServer({})
    assert.equal(
      await detectSocketProtocol(fake.baseUrl, { cookie: 'a=1', timeoutMs: 2_000 }),
      'legacy',
    )
    const request = fake.state.requests[0]
    assert.match(request.url, /^\/socket\.io\/1\/\?t=\d+$/)
    assert.equal(request.headers.cookie, 'a=1')
  })

  test("reports 'legacy' under a sub-path baseUrl", async () => {
    const fake = await withServer({})
    assert.equal(
      await detectSocketProtocol(`http://127.0.0.1:${fake.port}/overleaf/`, { timeoutMs: 2_000 }),
      'legacy',
    )
    assert.match(fake.state.requests[0].url, /^\/overleaf\/socket\.io\/1\/\?t=\d+$/)
  })

  test("falls back to 'v4' for a 404 or an unreachable host", async () => {
    const fake = await withServer({ handshakeStatus: 404 })
    assert.equal(await detectSocketProtocol(fake.baseUrl, { timeoutMs: 2_000 }), 'v4')
    assert.equal(await detectSocketProtocol('http://127.0.0.1:1/', { timeoutMs: 500 }), 'v4')
    assert.equal(await detectSocketProtocol('not-a-url'), 'v4')
    assert.equal(await detectSocketProtocol('ftp://example.test/'), 'v4')
  })

  test("falls back to 'v4' when the abort signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    assert.equal(
      await detectSocketProtocol('http://127.0.0.1:1/', { signal: controller.signal }),
      'v4',
    )
  })
})

// ---------------------------------------------------------------------------

function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('timed out waiting for condition'))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}
