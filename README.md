# Flux

[![CI](https://github.com/hazelcaffe/flux/actions/workflows/ci.yml/badge.svg)](https://github.com/hazelcaffe/flux/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Flux is a pure-JavaScript HTTP(S) and WebSocket client that runs in modern browsers, workers, and Node.js 22+. It multiplexes connections over [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) and handles TLS 1.2 and 1.3 in the client using [Reclaim TLS](https://github.com/reclaimprotocol/tls). There is no WebAssembly to load. The Wisp server can see where you connect, but it does not terminate the destination's HTTPS or WSS connection.

## Contents

- [Features](#features)
- [Installation and building](#installation-and-building)
- [JavaScript API](#javascript-api)
  - [Creating a client](#creating-a-client)
  - [Making HTTP requests](#making-http-requests)
  - [Creating HTTP sessions](#creating-http-sessions)
  - [Connecting WebSockets](#connecting-websockets)
  - [Using TLS, TCP, and UDP sockets](#using-tls-tcp-and-udp-sockets)
  - [Using the proxy transport](#using-the-proxy-transport)
  - [Client configuration](#client-configuration)
- [Wisp server and playground](#wisp-server-and-playground)
- [Compatibility and security](#compatibility-and-security)
- [Project structure](#project-structure)
- [License](#license)

## Features

- Wisp v1 (protocol 1.2): multiplexed TCP/UDP, upload flow control, stream errors, reconnect after connection loss.
- TLS 1.2 and 1.3, implemented in JS by Reclaim; pure-JS crypto, **no WASM, no Node TLS/net in the SDK**.
- AES-GCM and ChaCha20-Poly1305, ECDHE, X25519/P-256/P-384. Certificate verification enabled by default, bundled Mozilla roots and additional PEM roots.
- HTTP/1.1: streaming requests/responses, chunked framing, informational responses, trailers, duplicate raw headers, gzip/deflate and optional Brotli, redirects, abort signals and deadlines.
- Fetch signature with native `Response` body helpers, byte streams and BYOB readers, clone support, immutable response-header methods, and opaque manual redirects.
- WebSocket-shaped API: `EventTarget`, handler properties, text/Blob/ArrayBuffer messages, subprotocols, masking, fragmentation, ping/pong, close handshake, `binaryType`, `bufferedAmount`.
- Callback-based TLS sockets, typed raw byte streams, independent HTTP sessions, and a built-in `@mercuryworkshop/proxy-transports` adapter.
- Strict TypeScript ESNext, Vite library + playground builds, pnpm, Biome (four spaces, double quotes, semicolons), Vitest, Playwright, and CI.

## Installation and building

Prerequisites: Node.js 22+ and the pnpm version pinned in [`package.json`](package.json). Integration tests also require OpenSSL on `PATH`.

```sh
git clone https://github.com/hazelcaffe/flux.git
cd flux
pnpm install
pnpm build
pnpm pack
```

Install the generated `skylvi-flux-0.1.0.tgz` in your application with `pnpm add /path/to/skylvi-flux-0.1.0.tgz`. It installs as `@skylvi/flux`; this project is not yet published to npm. The build in `dist/` includes ESM, TypeScript declarations, source maps, and third-party license notices. It bundles the patched TLS engine so consumers do not need Flux's pnpm patch configuration.

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
pnpm build:demo   # Builds the static browser playground into demo-dist/
```

## JavaScript API

### Creating a client

```ts
import { Flux } from "@skylvi/flux";

const client = new Flux({
    wisp_server: "ws://127.0.0.1:4000/wisp/",
    onload: () => console.log("[flux] connected"),
    onerror: (error) => console.error("[flux] Wisp connection failed:", error),
});

try {
    const response = await client.fetch("https://example.com/");
    console.log(await response.text());
} finally {
    client.close();
}
```

The example assumes the [local Wisp server](#wisp-server-and-playground) is running. Replace `wisp_server` with your own endpoint as needed. Setting `onload` or `onerror` starts the connection immediately; otherwise it opens on first use or when you call `await client.init()`. `client.ready` reflects the Wisp handshake, and `onload` also fires after a reconnect. `onerror` reports Wisp connection failures. Destination errors are reported by individual requests and sockets.

`client.fetch` and `new client.WebSocket(...)` do not replace browser globals. **Flux does not enforce CORS or cache HTTP responses.**

### Making HTTP requests

```ts
import { Flux } from "@skylvi/flux";

const client = new Flux({
    wisp_server: "wss://your-proxy.example/wisp/",
    baseUrl: "https://api.example.com/",
});

const response = await client.fetch("/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer …" },
    body: JSON.stringify({ message: "Hello" }),
    signal: AbortSignal.timeout(10_000),
});

console.log(response.url, response.redirected);
for await (const chunk of response.body!) {
    console.log(chunk); // Uint8Array
}
client.close();
```

`client.fetch` uses the platform Fetch signature: `string`, `URL`, or `Request` input and `RequestInit` options, returning `Promise<Response>`. Standard body types are serialized through the platform's `Request`. On Node, set `duplex: "half"` on a `Request` with a streaming upload (or use `client.request`, whose option type includes it). HTTP uploads use chunked transfer encoding; Flux manages framing and connection headers.

`redirect: "follow"`, `"manual"`, and `"error"` are supported. A manual redirect returns an `opaqueredirect` response rather than exposing its status or location. Cross-origin responses are readable without a CORS grant. `mode` and `cache` do not enable browser CORS or caching inside Flux, though the host platform's `Request` constructor still applies its own input validation.

#### Raw requests

Use `client.request(url, options)` when you need explicit HTTP proxy behavior, such as non-filtered redirects, custom wire headers, duplicate response headers, or trailers. It uses the same Wisp connection and returns `WispResponse`. The playground and built-in transport use this path.

Extra raw request options:

| Option       | Default                | Behavior                                                                         |
| ------------ | ---------------------- | -------------------------------------------------------------------------------- |
| `timeoutMs`  | client default, 30,000 | Per-hop deadline, including streamed network body consumption. `0` disables it.  |
| `decompress` | `true`                 | Decode gzip, deflate, and Brotli where supported; set `false` for encoded bytes. |

301/302 rewrite POST to GET; 303 rewrites non-HEAD to GET; 307/308 replay the body. Cross-origin redirects strip Authorization, Proxy-Authorization, and Cookie. Replay uses `Request.clone()` and may buffer up to the configured request-size limit. Cancel or consume returned bodies to promptly release their resources.

Like native fetch, decoded responses retain the origin's Content-Encoding and Content-Length headers. `rawHeaders` always represents the wire headers, not the decoded byte count. `trailers` resolves when wire framing completes; cancellation resolves it to an empty list, and network/framing failures reject it. A decompression error can occur after wire trailers have been received.

### Creating HTTP sessions

```ts
const session = new client.HTTPSession({
    baseUrl: "https://example.com/",
    headers: { Accept: "text/html" },
    cookies: true,
    maxConnections: 8,
    requestTimeoutMs: 10_000,
});

try {
    console.log(await (await session.fetch("/")).text());
    // A JSON snapshot can be passed as cookieJar to another session.
    const snapshot = session.exportCookies();
    // Treat snapshot as a secret; it may contain authentication cookies.
} finally {
    session.close();
}
```

Sessions share the parent Wisp connection but have independent defaults, concurrency limits (50 active HTTP exchanges by default), and cancellation. Closing one aborts its active and queued requests without closing the parent. Defaults apply to every initial destination; don't set a session-wide Authorization header if you also use that session for unrelated origins. `session.request()` is the raw equivalent of `session.fetch()`.

Cookies are off by default. A session jar is independent of the browser and other sessions; it applies domain, path, expiration, and Secure restrictions on each redirect hop. `credentials: "omit"` prevents the jar from sending or storing cookies for that request. `cookieJar` restores the private JSON format returned by `exportCookies()`; it's not a browser-session or browser-cookie import.

### Connecting WebSockets

```ts
const ws = new client.WebSocket("wss://echo.websocket.org/");
ws.onopen = () => ws.send("hello from Flux");
ws.addEventListener("message", (event) => {
    console.log(event.data);
    if (event.data === "hello from Flux") ws.close(1000, "done");
});
ws.onclose = (event) => console.log(event.code, event.reason, event.wasClean);
ws.onerror = (event) => console.error(event);
```

The constructor accepts `http(s)` URLs by converting them to `ws(s)`. Default `binaryType` is `"blob"`; set `"arraybuffer"` to receive binary frames as `ArrayBuffer`. `await ws.ready` is an optional way to wait for the connection instead of using `onopen`. Close codes supplied by applications must be 1000 or 3000–4999. For custom handshake headers or detailed error events, use the SDK extension `client.connectWebSocket(url, protocols?, options?)`.

WebSocket options: `headers`, `handshakeTimeoutMs` (15,000), `closeTimeoutMs` (5,000), `maxMessageBytes` (16 MiB or client default). No permessage-deflate is negotiated.

### Using TLS, TCP, and UDP sockets

```ts
const socket = new client.TLSSocket("example.com", 443);
socket.onmessage = (bytes) => console.log(new TextDecoder().decode(bytes));
socket.onerror = console.error;
await socket.ready;
await socket.send(
    new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"),
);
await socket.closed;
```

`new client.TLSSocket(host, port?, tlsOptions?)` begins a verified TLS handshake. Set `onopen`, `onmessage(bytes)`, `onerror(error)`, and `onclose` immediately after construction, or await `ready` before sending. Incoming chunks are delivered to `onmessage` as they arrive; use `connectTLS()` instead if you want to read from a stream at your own pace. `metadata` describes the negotiated connection once open. Call `close()` to stop early, including during the handshake.

```ts
const stream = await client.connectTLS("example.com", 443);
console.log(stream.metadata); // version, cipherSuite, keyType, selectedAlpn
await stream.write(
    new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"),
);
const reader = stream.readable.getReader();
console.log(await reader.read());
await reader.cancel();

const tcp = await client.connectTCP("example.com", 80);
const udp = await client.wisp.open("dns.example.com", 53, "udp");
// One UDP write/read chunk represents one datagram, including empty datagrams.
udp.close();
tcp.close();
```

The stream-based sockets implement `ByteSocket`: `readable: ReadableStream<Uint8Array>`, `write(bytes): Promise<void>`, `closed: Promise<void>`, and `close(error?): void`. `closed` rejects on failure. `close()` immediately tears down the socket; it is not a TCP half-close or a graceful TLS close-notify API. The exported `TLSSocket.connect(customByteSocket, host, tlsOptions)` also supports custom byte transports. Stream-based TLS 1.3 sockets expose `updateTrafficKeys()`.

Wisp has no destination-connect acknowledgment, so `connectTCP` means CONNECT has been sent; unreachable/blocked destinations fail asynchronously through `readable` and `closed`. Existing streams are **not** silently replayed on disconnection. New operations can reconnect the Wisp connection until `client.close()` permanently disposes the client. A browser-native WebSocket or an injected `webSocketFactory` carries Wisp packets.

### Using the proxy transport

```ts
import { FluxTransport } from "@skylvi/flux";
import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";

const transport = new FluxTransport({
    wisp_server: "wss://your-proxy.example/wisp/",
}) satisfies ProxyTransport;

try {
    await transport.init();
    const response = await transport.request(
        new URL("https://example.com/"),
        "GET",
        null,
        [],
        undefined,
    );
    console.log(response.status, await new Response(response.body).text());
} finally {
    transport.close();
}
```

Implements the published `ProxyTransport` interface directly: `init`, `ready`, `request`, `connect`. `request` returns a streaming `TransferrableResponse` and leaves redirects manual so the consuming framework controls them. `connect` returns `[send, close]` and invokes the standard WebSocket transport callbacks. The concrete class adds `client` and `close()`.

### Client configuration

| Option                     | Default          | Meaning                                                   |
| -------------------------- | ---------------- | --------------------------------------------------------- |
| `wisp_server`              | required         | `ws://` / `wss://` proxy URL; pathname must end with `/`. |
| `baseUrl`                  | none             | Resolve relative fetch and WebSocket URLs.                |
| `webSocketFactory`         | global WebSocket | `(url: string) => WebSocket` for custom Wisp carriers.    |
| `connectTimeoutMs`         | 15,000           | Wisp connection + initial CONTINUE deadline.              |
| `requestTimeoutMs`         | 30,000           | Per-hop HTTP deadline.                                    |
| `maxRedirects`             | 20               | Redirect follow limit.                                    |
| `maxHeaderBytes`           | 65,536           | Response header/trailer block limit.                      |
| `maxRequestBytes`          | 64 MiB           | Uploaded body limit per request.                          |
| `maxResponseBytes`         | 256 MiB          | Both encoded and decoded response limits.                 |
| `maxBufferedBytes`         | 16 MiB           | Wisp per-stream unread receive queue.                     |
| `maxPacketBytes`           | 16 MiB           | Incoming Wisp message limit.                              |
| `maxWebSocketMessageBytes` | 16 MiB           | Message and queued-send limit.                            |
| `tls`                      | see below        | TLS defaults for this client.                             |

TLS options are `verifyServerCertificate` (true), `ca` (additional PEM roots), `supportedProtocolVersions` (`["TLS1_3", "TLS1_2"]` upstream default), `cipherSuites` (modern AEAD suites), `handshakeTimeoutMs` (15,000), `maxBufferedBytes` (16 MiB plaintext), and `fetchCertificateBytes` (optional AIA callback). Raw `connectTLS` accepts per-connection overrides.

The pure-JS backend requires **secure `crypto.getRandomValues`**, not WASM or `crypto.subtle`. It replaces Reclaim's fallback random-byte function. A checked-in pnpm patch also corrects P-384 certificate signatures and tightens TLS handshake and record handling. `@skylvi/flux/pure-js` is an alias plus `configureCrypto()` for explicit initialization. The packaged SDK has its own bundled Reclaim provider; when consuming workspace source, do not replace the shared Reclaim provider while SDK connections are active.

## Wisp server and playground

Run these from the clone in separate terminals:

```sh
pnpm dev:proxy    # Wisp endpoint: ws://127.0.0.1:4000/wisp/
pnpm dev          # Open the Vite URL printed in the terminal
```

The development server uses `wisp-js`, binds to loopback, and accepts browser origins on localhost. The playground exposes `globalThis.Flux` and `globalThis.FluxTransport` for testing in DevTools. Normal package imports do not set these globals.

For a restricted Tailscale demo, run `pnpm build:demo` and then `FLUX_TAILSCALE_IP=$(tailscale ip -4) PORT=4174 pnpm dev:proxy`. The same IP and port serve the playground at `/` and Wisp at `/wisp/`. This mode permits TCP to `example.com` and `echo.websocket.org` on ports 80 and 443. **Do not expose the development proxy publicly.** Use an authenticated, restricted Wisp server for production. HTTPS pages generally need a `wss://` carrier to avoid mixed-content blocking.

## Compatibility and security

- **HTTP/1.1 only**, advertised via ALPN. No HTTP/2, HTTP/3, HTTP connection pooling, HTTP proxy CONNECT, SOCKS, client certificates/mTLS, TLS 0-RTT, or session resumption API. Sessions limit active connections; they do not cache TCP connections.
- Wisp v1 only; works with Wisp v1 and v2 servers that accept v1 clients. Wisp v2-only extensions/authentication require a future implementation.
- The Fetch and WebSocket instance APIs are **not fully WHATWG-conformant**. CORS enforcement, browser cookies, caching, CSP destination policy, referrer processing, and service workers are not supported. Non-empty `integrity` is rejected. Relative URLs require a browser context or `baseUrl`.
- WebSocket events dispatched by JavaScript are not trusted browser events (`isTrusted` is `false`), and Flux sockets are not instances of the browser's native `WebSocket` class. Fetch response and header views are implemented in JavaScript over platform objects; their internal slots and property descriptors can differ from native results.
- `client.request`, `client.connectWebSocket`, and `FluxTransport` are explicit proxy APIs, not browser origin-policy enforcement. Apply your own destination and credential policy when using them.
- Uses modern Web APIs: Request, Response, Headers, Streams, TextEncoder/Decoder, EventTarget, Blob, WebSocket, `Promise.withResolvers`, and `crypto.getRandomValues`. Compression additionally needs `DecompressionStream`. Browsers must supply these features; the ESNext build does not polyfill them. Node.js 22+ supplies them.
- Verified TLS currently requires DNS hostnames, not IP-literal URLs. Reclaim's certificate-chain and cryptographic implementation remains a security dependency. HelloRetryRequest, revocation, certificate transparency, full RFC 5280 policy/name-constraints processing and browser-equivalent trust policy are **not** provided.
- AIA fetching is off by default to avoid direct-network certificate requests, CORS failures and recursive TLS handshakes. Servers should send their intermediate chain. Supply a deliberate bounded `fetchCertificateBytes` callback when necessary; do not recursively call the same TLS request from it.
- Brotli is advertised only when the runtime provides `DecompressionStream("brotli")`. Unsolicited unsupported encodings throw unless `decompress: false` is set.
- Wisp v1 cannot pause downstream traffic. A slow consumer that exceeds receive bounds fails the stream instead of buffering indefinitely. UDP is message-oriented, has no delivery guarantees, and cannot preserve datagrams larger than the configured buffer limits.
- Flux is tested end to end against `wisp-js` and in Chromium, but has not been independently security-audited. See [SECURITY.md](SECURITY.md) before deploying.

## Project structure

```text
src/wisp.ts        Wisp framing, multiplexing, flow control
src/tls.ts         Reclaim TLS integration, RNG hardening, certificate checks
src/http.ts        HTTP parser, request encoding, response type
src/client.ts      Fetch orchestration, redirects, decoding, lifecycle
src/session.ts     HTTP session defaults, cookie jars, connection limits
src/tls-socket.ts  Callback-based TLS socket API
src/websocket.ts   RFC 6455 handshake, framing, browser-style API
src/transport.ts   ProxyTransport adapter
demo/              Browser playground
scripts/proxy.ts   Development-only upstream Wisp server
test/              Unit/protocol and real-server integration tests
test/browser/      Chromium test with WebAssembly disabled
```

## License

Original Flux code is licensed under the [GNU Affero General Public License, version 3 only](LICENSE) (`AGPL-3.0-only`). Dependencies retain their own licenses; see [NOTICE](NOTICE) and the third-party license report in the build output. The development proxy uses LGPL-licensed `wisp-js`, which is not part of the runtime library.
