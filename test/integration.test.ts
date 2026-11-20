import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Flux, type FluxOptions, FluxTransport } from "../src/index.js";
import { fixture } from "./fixture.js";

let servers: Awaited<ReturnType<typeof fixture>>;
const clients: Flux[] = [];
beforeAll(async () => {
    servers = await fixture();
});
afterEach(() => {
    for (const client of clients.splice(0)) client.close();
});
afterAll(async () => {
    await servers.close();
});
function client(options: Partial<FluxOptions> = {}) {
    const instance = new Flux({
        wisp_server: servers.wispUrl,
        tls: { ca: [servers.cert] },
        ...options,
    });
    clients.push(instance);
    return instance;
}

describe("Flux lifecycle", () => {
    it("connects eagerly with callbacks and notifies onload after the Wisp handshake", async () => {
        const loaded = Promise.withResolvers<void>();
        const errors: Error[] = [];
        const flux = client({ onload: loaded.resolve, onerror: (error) => errors.push(error) });
        await loaded.promise;
        expect(flux.ready).toBe(true);
        flux.close();
        expect(errors).toEqual([]);
    });

    it("reports connection errors and allows a later retry", async () => {
        const errored = Promise.withResolvers<Error>();
        let attempts = 0;
        const flux = client({
            onerror: errored.resolve,
            webSocketFactory: (url) => {
                if (++attempts === 1) throw new Error("Wisp factory failure");
                return new WebSocket(url);
            },
        });
        expect((await errored.promise).message).toBe("Wisp factory failure");
        expect(flux.ready).toBe(false);
        await flux.init();
        expect(flux.ready).toBe(true);
    });
});

describe("HTTP over real wisp-js", () => {
    it("fetches HTTP and preserves URL and clone metadata", async () => {
        const response = await client().fetch(`${servers.httpUrl}/json`);
        const copy = response.clone();
        expect(response.url).toBe(`${servers.httpUrl}/json`);
        expect(copy.url).toBe(response.url);
        expect(await response.json()).toEqual({ ok: true, path: "/json" });
        expect(await copy.json()).toEqual({ ok: true, path: "/json" });
    });
    it("multiplexes concurrent requests over one Wisp connection", async () => {
        const session = client();
        const results = await Promise.all(
            Array.from({ length: 12 }, async (_, index) =>
                (await session.fetch(`${servers.httpUrl}/${index}`)).json(),
            ),
        );
        expect(results).toHaveLength(12);
        expect(session.ready).toBe(true);
    });
    it("streams chunked responses, duplicate headers and trailers", async () => {
        const response = await client().request(`${servers.httpUrl}/chunked`);
        expect(
            response.rawHeaders.filter(([name]) => name.toLowerCase() === "set-cookie"),
        ).toHaveLength(2);
        expect(await response.text()).toBe("hello world");
        expect(await response.trailers).toEqual([["X-Checksum", "ok"]]);
    });
    it.each(["gzip", "deflate"])("decompresses %s", async (encoding) => {
        const response = await client().fetch(`${servers.httpUrl}/${encoding}`);
        expect(await response.text()).toBe("compressed hello ".repeat(1000));
    });
    it("advertises and decodes Brotli only when the runtime supports it", async () => {
        let supported = true;
        try {
            new DecompressionStream("brotli" as CompressionFormat);
        } catch {
            supported = false;
        }
        const session = client();
        const echo = await (await session.fetch(`${servers.httpUrl}/echo`)).json();
        expect(echo.headers["accept-encoding"].split(", ").includes("br")).toBe(supported);
        const response = session.fetch(`${servers.httpUrl}/br`);
        if (supported) expect(await (await response).text()).toBe("compressed hello ".repeat(1000));
        else await expect(response).rejects.toThrow("Unsupported content encoding");
    });
    it("can return compressed bytes untouched", async () => {
        const response = await client().request(`${servers.httpUrl}/gzip`, { decompress: false });
        expect(new Uint8Array(await response.arrayBuffer()).slice(0, 2)).toEqual(
            new Uint8Array([31, 139]),
        );
    });
    it("uploads form and streaming bodies with Wisp flow control", async () => {
        const session = client();
        const response = await session.fetch(`${servers.httpUrl}/echo`, {
            method: "POST",
            body: new URLSearchParams({ message: "hello world" }),
        });
        expect(await response.json()).toMatchObject({
            method: "POST",
            body: "message=hello+world",
        });
        let sent = 0;
        const stream = new ReadableStream({
            pull(controller) {
                if (sent++ === 12) {
                    controller.close();
                    return;
                }
                controller.enqueue(new TextEncoder().encode("x".repeat(16_384)));
            },
        });
        const upload = await session.request(`${servers.httpUrl}/echo`, {
            method: "POST",
            body: stream,
            duplex: "half",
        });
        expect((await upload.json()).body).toHaveLength(12 * 16_384);
    });
    it("follows redirects, supports manual/error modes and limits loops", async () => {
        const session = client({ maxRedirects: 2 });
        const response = await session.fetch(`${servers.httpUrl}/redirect`);
        expect(response.redirected).toBe(true);
        expect(response.url).toBe(`${servers.httpUrl}/json`);
        await response.text();
        const manual = await session.fetch(`${servers.httpUrl}/redirect`, { redirect: "manual" });
        expect(manual).toMatchObject({ type: "opaqueredirect", status: 0, body: null });
        expect(manual.headers.get("location")).toBeNull();
        const raw = await session.request(`${servers.httpUrl}/redirect`, { redirect: "manual" });
        expect(raw.status).toBe(302);
        await raw.body?.cancel();
        await expect(
            session.fetch(`${servers.httpUrl}/redirect`, { redirect: "error" }),
        ).rejects.toThrow("Redirect");
        await expect(session.fetch(`${servers.httpUrl}/loop`)).rejects.toThrow(
            "Too many redirects",
        );
    });
    it("replays 307 bodies and rewrites 303 to GET", async () => {
        const session = client();
        const preserved = await session.fetch(`${servers.httpUrl}/redirect307`, {
            method: "POST",
            body: "replay",
        });
        expect(await preserved.json()).toMatchObject({ method: "POST", body: "replay" });
        const rewritten = await session.fetch(`${servers.httpUrl}/redirect303`, {
            method: "POST",
            body: "drop",
        });
        expect(await rewritten.json()).toMatchObject({ method: "GET", body: "" });
    });
    it("strips credentials across origins", async () => {
        const response = await client().fetch(`${servers.httpUrl}/redirect-other`, {
            headers: { Authorization: "secret", Cookie: "secret=1" },
        });
        const data = await response.json();
        expect(data.headers.authorization).toBeUndefined();
        expect(data.headers.cookie).toBeUndefined();
    });
    it("handles HEAD, 204 and close-delimited bodies", async () => {
        const session = client();
        expect(
            (await session.fetch(`${servers.httpUrl}/json`, { method: "HEAD" })).body,
        ).toBeNull();
        expect((await session.fetch(`${servers.httpUrl}/empty`)).body).toBeNull();
        expect(await (await session.fetch(servers.rawUrl)).text()).toBe("close-delimited");
    });
    it.each(["truncated", "ambiguous", "bad-chunk"])("rejects %s response bodies", async (path) => {
        await expect(
            (async () => (await client().fetch(`${servers.rawUrl}/${path}`)).text())(),
        ).rejects.toThrow();
    });
    it("cancels pending requests and streaming bodies", async () => {
        const session = client();
        const abort = new AbortController();
        const pending = session.fetch(`${servers.httpUrl}/slow`, { signal: abort.signal });
        setTimeout(() => abort.abort(), 30);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        const bodyAbort = new AbortController();
        const response = await session.fetch(`${servers.httpUrl}/slow-body`, {
            signal: bodyAbort.signal,
        });
        bodyAbort.abort();
        await expect(response.text()).rejects.toThrow();
    });
    it("enforces deadlines and decoded response limits", async () => {
        await expect(
            client().request(`${servers.httpUrl}/slow`, { timeoutMs: 30 }),
        ).rejects.toMatchObject({ name: "TimeoutError" });
        const response = await client({ maxResponseBytes: 1000 }).fetch(`${servers.httpUrl}/gzip`);
        await expect(response.text()).rejects.toThrow("Decoded response");
    });
});

describe("HTTP sessions", () => {
    it("merges defaults, accepts relative URLs and leaves the main client independent", async () => {
        const flux = client();
        const session = new flux.HTTPSession({
            baseUrl: servers.httpUrl,
            headers: { "x-default": "set", "x-override": "old" },
        });
        const sibling = new flux.HTTPSession({ baseUrl: servers.httpUrl });
        const response = await session.fetch("/echo", { headers: { "x-override": "new" } });
        expect((await response.json()).headers).toMatchObject({
            "x-default": "set",
            "x-override": "new",
        });
        session.close();
        await expect(session.fetch("/echo")).rejects.toMatchObject({ name: "AbortError" });
        const outside = await sibling.fetch("/echo");
        expect((await outside.json()).headers["x-default"]).toBeUndefined();
        sibling.close();
    });

    it("keeps cookies private, scopes them on redirects, and can restore a snapshot", async () => {
        const flux = client();
        const session = new flux.HTTPSession({ baseUrl: servers.httpUrl, cookies: true });
        const redirected = await session.fetch("/cookie-redirect");
        expect(redirected.redirected).toBe(true);
        expect((await redirected.json()).headers.cookie).toBe("demo=1");
        const snapshot = session.exportCookies();
        const restored = new flux.HTTPSession({ baseUrl: servers.httpUrl, cookieJar: snapshot });
        expect((await (await restored.fetch("/echo")).json()).headers.cookie).toBe("demo=1");
        expect(
            (await (await restored.fetch("/echo", { credentials: "omit" })).json()).headers.cookie,
        ).toBeUndefined();
        expect(
            (await (await session.fetch("/redirect-other")).json()).headers.cookie,
        ).toBeUndefined();
        const privateResponse = await flux.fetch(`${servers.httpUrl}/echo`);
        expect((await privateResponse.json()).headers.cookie).toBeUndefined();
        session.close();
        restored.close();
    });

    it("bounds active exchanges and releases the slot when a response is cancelled", async () => {
        const flux = client();
        const session = new flux.HTTPSession({ baseUrl: servers.httpUrl, maxConnections: 1 });
        const streaming = await session.request("/slow-body");
        await expect(
            session.fetch("/json", { signal: AbortSignal.timeout(35) }),
        ).rejects.toMatchObject({ name: "TimeoutError" });
        await streaming.body?.cancel();
        expect(await (await session.fetch("/json")).json()).toMatchObject({ ok: true });
        session.close();
    });

    it("closes active and queued requests without disconnecting other sessions", async () => {
        const flux = client();
        const session = new flux.HTTPSession({ baseUrl: servers.httpUrl, maxConnections: 1 });
        const streaming = await session.fetch("/slow-body");
        const pending = session.fetch("/slow");
        session.close();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await expect(streaming.text()).rejects.toMatchObject({ name: "AbortError" });
        expect(await (await flux.fetch(`${servers.httpUrl}/json`)).json()).toMatchObject({
            ok: true,
        });
    });
});

describe("pure-JS TLS through Wisp", () => {
    it("exposes a class-based socket with callbacks and verified TLS metadata", async () => {
        const flux = client();
        const socket = new flux.TLSSocket("localhost", servers.tlsPort);
        const chunk = Promise.withResolvers<Uint8Array>();
        const closed = Promise.withResolvers<void>();
        socket.onopen = () => {
            void socket
                .send(
                    new TextEncoder().encode(
                        "GET /json HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
                    ),
                )
                .catch(chunk.reject);
        };
        socket.onmessage = chunk.resolve;
        socket.onerror = chunk.reject;
        socket.onclose = closed.resolve;
        await socket.ready;
        expect(socket.metadata?.version).toBe("TLS1_3");
        expect(new TextDecoder().decode(await chunk.promise)).toContain("HTTP/1.1 200");
        socket.close();
        await socket.closed;
        await closed.promise;
    });

    it("reports handshake failure on both the callback and promise", async () => {
        const flux = client({ tls: {} });
        const socket = new flux.TLSSocket("localhost", servers.tlsPort);
        const failed = Promise.withResolvers<Error>();
        socket.onerror = failed.resolve;
        const error = await failed.promise;
        await expect(socket.ready).rejects.toBe(error);
        await expect(socket.closed).rejects.toBe(error);
    });

    it("closes before starting the handshake without reporting a network error", async () => {
        const flux = client();
        const socket = new flux.TLSSocket("localhost", servers.tlsPort);
        const errors: Error[] = [];
        socket.onerror = (error) => errors.push(error);
        socket.close();
        await expect(socket.ready).rejects.toMatchObject({ name: "AbortError" });
        await socket.closed;
        expect(errors).toEqual([]);
        expect(flux.ready).toBe(false);
    });
    it.each(["httpsUrl", "tls12Url", "ec13Url", "ec12Url"] as const)(
        "performs a verified %s handshake",
        async (url) => {
            const response = await client().fetch(`${servers[url]}/json`);
            expect(await response.json()).toMatchObject({ ok: true });
        },
    );
    it("rejects untrusted server certificates", async () => {
        await expect(client({ tls: {} }).fetch(servers.httpsUrl)).rejects.toThrow();
    });
    it("rejects a trusted leaf whose SAN does not match, even if its CN matches", async () => {
        await expect(client().request(servers.wrongNameUrl)).rejects.toThrow(
            "Certificate hostname mismatch",
        );
    });
    it("honors an explicit TLS version restriction", async () => {
        const session = client({
            tls: { ca: [servers.cert], supportedProtocolVersions: ["TLS1_2"] },
        });
        await expect(session.fetch(servers.ec13Url)).rejects.toThrow();
        const response = await session.fetch(servers.ec12Url);
        expect(response.status).toBe(200);
        await response.text();
    });
    it("rejects certificate name mismatches", async () => {
        await expect(
            client().request(servers.httpsUrl.replace("localhost", "127.0.0.1")),
        ).rejects.toThrow(/Certificate|IP literals/u);
    });
    it("only permits self-signed servers with an explicit insecure opt-out", async () => {
        const response = await client({ tls: { verifyServerCertificate: false } }).fetch(
            servers.httpsUrl,
        );
        expect(response.status).toBe(200);
        await response.text();
    });
    it("exposes raw TLS sockets and negotiated metadata", async () => {
        const socket = await client().connectTLS("localhost", servers.tlsPort);
        expect(socket.metadata.version).toBe("TLS1_3");
        await socket.write(
            new TextEncoder().encode(
                "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            ),
        );
        const reader = socket.readable.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("HTTP/1.1 200");
        await reader.cancel();
    });
});

describe("WebSocket compatibility", () => {
    it("is assignable to the platform WebSocket constructor type", () => {
        const WebSocket: typeof globalThis.WebSocket = client().WebSocket;
        expect(WebSocket.OPEN).toBe(1);
    });
    it.each([false, true])("echoes text and binary over TLS=%s", async (tls) => {
        const session = client();
        const url = (tls ? servers.httpsUrl : servers.httpUrl).replace(/^http/u, "ws");
        const ws = new session.WebSocket(url, ["echo"]);
        ws.binaryType = "arraybuffer";
        await ws.ready;
        expect(ws.protocol).toBe("echo");
        const text = new Promise<unknown>((resolve) =>
            ws.addEventListener("message", (event) => resolve(event.data), { once: true }),
        );
        ws.send("hello");
        expect(await text).toBe("hello");
        const binary = new Promise<unknown>((resolve) =>
            ws.addEventListener("message", (event) => resolve(event.data), { once: true }),
        );
        ws.send(new Uint8Array([1, 2, 3]));
        expect(new Uint8Array((await binary) as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
        const close = new Promise<CloseEvent>((resolve) =>
            ws.addEventListener("close", resolve, { once: true }),
        );
        ws.close(1000, "done");
        expect(await close).toMatchObject({ code: 1000, reason: "done", wasClean: true });
    });
    it("reassembles fragmented text with interleaved ping", async () => {
        const ws = client().connectWebSocket(`${servers.httpUrl.replace("http:", "ws:")}/fragment`);
        const result = new Promise<unknown>((resolve) => {
            ws.onmessage = (event) => resolve(event.data);
        });
        expect(await result).toBe("fragmented");
        ws.close();
    });
    it("supports server initiated close", async () => {
        const ws = client().connectWebSocket(
            `${servers.httpUrl.replace("http:", "ws:")}/server-close`,
        );
        const closed = new Promise<CloseEvent>((resolve) => {
            ws.onclose = resolve;
        });
        expect(await closed).toMatchObject({ code: 1000, reason: "bye", wasClean: true });
    });
    it("validates URLs, subprotocols, states, and close reasons synchronously", () => {
        const session = client();
        expect(() => new session.WebSocket("ftp://example.com")).toThrow();
        expect(() => new session.WebSocket("ws://example.com", ["x", "x"])).toThrow();
        const ws = new session.WebSocket(servers.httpUrl);
        expect(() => ws.send("too soon")).toThrow();
        expect(() => ws.close(1001)).toThrow();
        expect(() => ws.close(1000, "x".repeat(124))).toThrow();
        ws.close();
    });
});

describe("raw Wisp and proxy-transports SDK", () => {
    it("carries TCP and UDP traffic", async () => {
        const session = client();
        const tcp = await session.connectTCP("localhost", servers.tcpPort);
        const tcpReader = tcp.readable.getReader();
        await tcp.write(new TextEncoder().encode("tcp"));
        expect(new TextDecoder().decode((await tcpReader.read()).value)).toBe("tcp");
        tcp.close();
        const udp = await session.wisp.open("127.0.0.1", servers.udpPort, "udp");
        const udpReader = udp.readable.getReader();
        await udp.write(new TextEncoder().encode("udp"));
        expect(new TextDecoder().decode((await udpReader.read()).value)).toBe("udp");
        udp.close();
    });
    it("implements the published proxy-transports request interface", async () => {
        const transport = new FluxTransport({
            wisp_server: servers.wispUrl,
            tls: { ca: [servers.cert] },
        });
        clients.push(transport.client);
        await transport.init();
        expect(transport.ready).toBe(true);
        const response = await transport.request(
            new URL(`${servers.httpsUrl}/json`),
            "GET",
            null,
            [],
            undefined,
        );
        expect(response.status).toBe(200);
        expect(await new Response(response.body).json()).toMatchObject({ ok: true });
    });
    it("implements the proxy-transports WebSocket callbacks", async () => {
        const transport = new FluxTransport({
            wisp_server: servers.wispUrl,
            tls: { ca: [servers.cert] },
        });
        clients.push(transport.client);
        const result = Promise.withResolvers<unknown>();
        const closed = Promise.withResolvers<number>();
        const [send, close] = transport.connect(
            new URL(servers.httpsUrl.replace("https:", "wss:")),
            ["echo"],
            [],
            (protocol) => send(protocol),
            result.resolve,
            closed.resolve,
            result.reject,
        );
        expect(await result.promise).toBe("echo");
        close(1000, "done");
        expect(await closed.promise).toBe(1000);
    });
});
