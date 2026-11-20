# Security and trust model

This project has not received an independent security audit. Do not treat passing tests as a guarantee of correct TLS or browser-equivalent certificate verification.

## Network path

```text
Application → JS HTTP/WebSocket → Reclaim JS TLS → Wisp TCP stream
            → browser WebSocket → Wisp server → destination TCP server
```

HTTPS/WSS application bytes are encrypted before they leave the client. The Wisp operator still sees client IP, destination hostname/port, timing, sizes and connection metadata. HTTP/WS and UDP are not encrypted end-to-end by this library. Use `wss://` for the carrier in production; it protects metadata on the client-to-proxy link, not from the proxy operator.

All code executing in the same JavaScript environment may observe application plaintext and TLS state. This is not protection against malicious extensions, XSS, compromised dependencies, or a compromised endpoint.

## Crypto and certificates

- Reclaim is pinned to 0.1.5. Its pure-JS backend is used; the upstream `Math.random` random-byte fallback is replaced by `crypto.getRandomValues`. No insecure random fallback is allowed. Noble's asymmetric operations also require the platform CSPRNG.
- The bundled Reclaim engine includes the pinned patch in `patches/`. It adds handshake checks (including certificate-key possession before Finished) and fixes padded TLS 1.3 records and ECDSA verification. This is not a substitute for auditing the whole TLS implementation.
- Verification defaults to on. Reclaim verifies certificate signatures, validity and a path to its bundled/additional trust anchors. The SDK adds SAN-preferred hostname matching, single-label wildcard rules, server-auth EKU checks and basic CA/path-length checks on the supplied chain.
- These checks do not implement all of RFC 5280 or browser trust policy. In particular, revocation, CT, policy constraints, name constraints, and complete critical-extension processing are not implemented. Verified TLS to IP literals is rejected.
- AIA certificate retrieval is disabled unless explicitly supplied by the application. A custom callback must constrain schemes, size, time, redirects and destinations. It must not create an unbounded recursive TLS request.
- `verifyServerCertificate: false` exposes the connection to impersonation and MITM. It is for controlled testing only. Additional `ca` roots extend trust, not replace the Mozilla store.
- Reclaim's crypto provider is module-global. The package bundles its own copy, but direct workspace-source consumers share any Reclaim instance resolved by their bundler. Do not replace that provider while connections are active. Keep dependency notices and review security updates before changing the pinned version.
- `close()` resets the underlying stream; it does not send a graceful TLS close-notify. For incoming close-delimited TLS data, missing peer close-notify is treated as a truncation error. Fixed-length/chunked HTTP bodies have their own framing checks.

## Application and proxy policy

Flux does not enforce CORS or integrate with browser-managed cookies, CSP, or the cache. These APIs are not a security boundary for untrusted code. Applications must enforce their own destination and credential policies. Redirects strip common explicit credentials when crossing origins. Opt-in HTTP session cookie jars apply their own destination rules; snapshots may contain authentication secrets. TLS does not make a proxy safe to expose publicly.

The development proxy defaults to loopback, restricts browser origins and keeps upstream private-network destination blocks enabled. Opt-in tailnet mode binds specifically to the Tailscale interface and further restricts destinations, ports and streams. Neither mode is a production proxy. Untrusted Wisp users can still consume resources and originate traffic; production deployments need authentication, origin allowlists, network egress restrictions, DNS-rebinding defenses, stream/rate/byte limits, monitoring, and abuse handling. Never proxy unvalidated user-controlled URLs from a privileged network.

Incoming protocol buffers, headers, HTTP bodies, decoded bodies and WebSocket messages are bounded. There is no Wisp v1 receive-side flow-control extension; oversized queues fail closed. Limits bound individual operations, not total process memory across unlimited user-created clients/streams. Enforce application-wide concurrency quotas as well.

## Reporting

Do not post credentials, plaintext traffic, private keys or exploit details publicly. Contact the deploying application's maintainer privately for integration issues; report Reclaim cryptographic/certificate issues through the upstream Reclaim project's security policy. Before publishing this SDK, configure a dedicated private vulnerability-reporting channel for this repository.
