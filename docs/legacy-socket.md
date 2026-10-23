# Socket.IO 0.9 transport (`src/transport/legacy.ts`)

Zero-dependency client for Overleaf CE forks that still speak Socket.IO **0.9**
(`GET /socket.io/socket.io.js` → `Socket.IO.min.js build:0.9.17-overleaf-5`, e.g.
`https://latex.cstcloud.cn/`). Official overleaf.com uses engine.io 4 and stays on
`socket.io-client` in `src/transport/socket.ts`.

## Detect before connecting

```ts
const protocol = await detectSocketProtocol(baseUrl, { cookie }) // 'legacy' | 'v4'
```

It issues `GET <base>/socket.io/1/?t=<ms>` and treats a body matching
`/^[A-Za-z0-9_-]{6,}:\d+:\d+:/` as legacy; any error or other body means v4.

## Handshake and upgrade

1. `GET <base>/socket.io/1/?projectId=<id>&t=<ms>` + `Cookie` → `sid:60:60:websocket,xhr-polling`.
   Only the websocket transport works; the `xhr-polling` route of this fork does not.
2. `wss://<host><base>/socket.io/1/websocket/<sid>` with the same `Cookie`,
   `Origin: https://<host>`, `Sec-WebSocket-Version: 13`, random 16-byte key.
   The `101` must echo the correct `Sec-WebSocket-Accept`.
3. Roughly **1 in 3–4 upgrades is refused** behind the Caddy front end: the server
   sends `7:::1+0` (reason `client not handshaken`, advice `reconnect`) and closes.
   The same `sid` is still valid, so retry the upgrade with it (the client does up
   to 4 attempts per sid, then re-handshakes) instead of failing the connection.

## Join flow of this fork (differs from upstream 0.9)

On an accepted upgrade the server **does not wait for `1::` + `joinProject`**: it
pushes `1::` and then
`5:::{"name":"joinProjectResponse","args":[{publicId, project, permissionsLevel, protocolVersion}]}`
within ~30 ms, i.e. it auto-joins the `projectId` taken from the handshake query.
Each join allocates a new `publicId`. The client therefore (a) accepts a
`joinProjectResponse` that arrives before it sent anything, and (b) still falls
back to the documented flow (`1::`, then `5:::<ackId>+{"name":"joinProject",…}`
waiting for the event push) and answers the `1::` ack form when a server behaves
differently. `joinProject` carries no ack on this fork, so the response is only
observable as an event.

## Heartbeats

The server sends `2::` on its own and answers a client `2::` with `2::`. A 45 s
connection without any client heartbeat stayed open, so the client's 20 s `2::`
timer is a compatibility measure, not a requirement of this fork.

## `joinDoc` ack layout (read-only probe)

`emitWithAck('joinDoc', [docId, { encodeRanges: true }])` returns 6 arguments,
confirmed against the live server (948-line document):

| index | value | meaning |
| --- | --- | --- |
| 0 | `null` | error slot (always null on success) |
| 1 | `string[]` | document lines, one array element per line |
| 2 | `number` | document `version` (OT version to send with updates) |
| 3 | `unknown[]` | history/ranges placeholder, empty for a fresh load |
| 4 | `object` | empty object on this fork |
| 5 | `"sharejs-text-ot"` | OT type / engine marker |

The ack frame is large (up to ~100 KB), so the frame parser must handle 64-bit
lengths; it does.

## Errors

`socket.io` error frames are `7:::<reasonIndex>[+<adviceIndex>]` with reasons
`transport not supported` / `client not handshaken` / `unauthorized`. There is no
`E_SERVER` code in this repo, so errors surface as `OverleafSyncError('E_TRANSPORT',
'socket.io server error frame: <raw frame>', hint)`, keeping the raw frame and the
decoded reason/advice in the message and hint. `E_TIMEOUT` is used for budget and
ack timeouts, `E_CONFIG` for unusable options, and aborts report as cancelled.

## API

`LegacyOverleafSocket.connect({ baseUrl, cookie, projectId, timeoutMs?, signal?, onDebug? })`
resolves once the project is joined; `payload` / `joinProjectResult` expose the
response, `on`/`onArgs`/`onAny` subscribe to events, `emit` is fire-and-forget,
`emitWithAck` uses `5:::<id>+` / `6:::<id>+` and rejects on timeout or disconnect,
and `close()` is idempotent.
