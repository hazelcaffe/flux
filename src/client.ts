import { asError, ByteReader, type ByteSocket, deferred } from "./bytes.js";
import { createFetch } from "./fetch.js";
import {
    authority,
    encodeHead,
    hostname,
    type RawHeaders,
    readBody,
    readHead,
    WispResponse,
    writeRequestBody,
} from "./http.js";
import { bindHTTPSession } from "./session.js";
import { type TLSOptions, TLSSocket } from "./tls.js";
import { bindTLSSocket } from "./tls-socket.js";
import { createWebSocketClass, type WebSocketOptions, WispWebSocket } from "./websocket.js";
import { WispClient, type WispOptions, type WispStream } from "./wisp.js";

const brotliFormat = "brotli" as CompressionFormat;
let brotli: boolean | undefined;

function supportsBrotli(): boolean {
    if (brotli === undefined) {
        try {
            new DecompressionStream(brotliFormat);
            brotli = true;
        } catch {
            brotli = false;
        }
    }
    return brotli;
}

export interface FluxOptions extends WispOptions {
    wisp_server: string | URL;
    /** Called after the Wisp handshake, including after a reconnect. */
    onload?: () => void;
    /** Reports failures of the Wisp connection. Individual requests reject separately. */
    onerror?: (error: Error) => void;
    tls?: TLSOptions;
    baseUrl?: string;
    requestTimeoutMs?: number;
    maxRedirects?: number;
    maxHeaderBytes?: number;
    maxResponseBytes?: number;
    maxRequestBytes?: number;
    maxWebSocketMessageBytes?: number;
}

export interface FetchOptions extends RequestInit {
    /** Node requires this option when passing a streaming request body. */
    duplex?: "half";
    timeoutMs?: number;
    decompress?: boolean;
}

/** @internal Per-session HTTP hooks, applied to each hop including redirects. */
export interface RequestScope {
    acquire?(signal: AbortSignal): Promise<() => void>;
    prepare?(url: URL, headers: Headers, credentials: RequestCredentials): void;
    receive?(url: URL, headers: RawHeaders, credentials: RequestCredentials): void;
}

export class Flux {
    readonly wisp: WispClient;
    readonly fetch: typeof globalThis.fetch;
    readonly WebSocket: ReturnType<typeof createWebSocketClass>;
    readonly TLSSocket: ReturnType<typeof bindTLSSocket>;
    readonly HTTPSession: ReturnType<typeof bindHTTPSession>;
    private readonly active = new Set<ByteSocket>();
    private readonly lifetime = new AbortController();
    private disposed = false;

    constructor(readonly options: FluxOptions) {
        this.wisp = new WispClient(options.wisp_server, options, options);
        this.fetch = createFetch(this.request, () => this.options.baseUrl);
        this.WebSocket = createWebSocketClass(this);
        this.TLSSocket = bindTLSSocket(this);
        this.HTTPSession = bindHTTPSession(this);
        if (options.onload || options.onerror) void this.init().catch(() => {});
    }

    get ready(): boolean {
        return this.wisp.ready;
    }
    init(): Promise<void> {
        return this.wisp.connect();
    }

    async connectTCP(host: string, port: number, signal?: AbortSignal): Promise<WispStream> {
        if (this.disposed) throw new Error("Client is closed");
        const stream = await this.wisp.open(host, port, "tcp", signal);
        this.track(stream);
        return stream;
    }

    private track(socket: ByteSocket): void {
        this.active.add(socket);
        void socket.closed.catch(() => {}).finally(() => this.active.delete(socket));
    }

    async connectTLS(
        host: string,
        port = 443,
        options: TLSOptions = {},
        signal?: AbortSignal,
    ): Promise<TLSSocket> {
        const stream = await this.connectTCP(host, port, signal);
        const abort = () => stream.close(asError(signal?.reason));
        signal?.addEventListener("abort", abort, { once: true });
        try {
            if (signal?.aborted) {
                abort();
                signal.throwIfAborted();
            }
            const socket = await TLSSocket.connect(stream, host, {
                ...this.options.tls,
                ...options,
            });
            if (signal?.aborted) {
                socket.close(asError(signal.reason));
                signal.throwIfAborted();
            }
            this.track(socket);
            return socket;
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    }

    /** @internal */
    openSocket(url: URL, signal?: AbortSignal): Promise<ByteSocket> {
        const tls = url.protocol === "https:" || url.protocol === "wss:";
        const port = url.port ? Number(url.port) : tls ? 443 : 80;
        return tls
            ? this.connectTLS(hostname(url), port, {}, signal)
            : this.connectTCP(hostname(url), port, signal);
    }

    connectWebSocket(
        url: string | URL,
        protocols: string | string[] = [],
        options: WebSocketOptions = {},
    ): WispWebSocket {
        return new WispWebSocket(this, url, protocols, options);
    }

    /** Unfiltered HTTP(S) SDK API, including wire headers and trailers. */
    readonly request = async (
        input: string | URL | Request,
        init: FetchOptions = {},
    ): Promise<WispResponse> => this.requestWithScope(input, init);

    /** @internal */
    async requestWithScope(
        input: RequestInfo | URL,
        init: FetchOptions,
        scope?: RequestScope,
    ): Promise<WispResponse> {
        if (this.disposed) throw new Error("Client is closed");
        const source =
            typeof input === "string" && this.options.baseUrl
                ? new URL(input, this.options.baseUrl)
                : input;
        let request = new Request(source, init);
        if (request.integrity)
            throw new TypeError("Subresource integrity is not supported by this client");
        // Browser Request objects strip Fetch-forbidden headers such as Cookie and Origin.
        // Keep explicit proxy headers in an unguarded Headers object, retaining any body
        // Content-Type (e.g. the multipart boundary) synthesized by Request.
        let wireHeaders = new Headers(init.headers ?? request.headers);
        for (const [name, value] of request.headers) {
            if (!wireHeaders.has(name)) wireHeaders.set(name, value);
        }
        for (let redirects = 0; ; redirects++) {
            const url = new URL(request.url);
            if (!["http:", "https:"].includes(url.protocol))
                throw new TypeError("Fetch supports only HTTP(S) URLs");
            if (url.username || url.password)
                throw new TypeError("Fetch URLs cannot contain credentials");
            request.signal.throwIfAborted();
            const replay =
                request.body && request.redirect === "follow" ? request.clone() : undefined;
            let response: WispResponse;
            try {
                response = await this.perform(
                    request,
                    url,
                    wireHeaders,
                    init,
                    redirects > 0,
                    scope,
                );
            } catch (error) {
                void replay?.body?.cancel().catch(() => {});
                void request.body?.cancel().catch(() => {});
                throw error;
            }
            const location = response.headers.get("location");
            if (
                ![301, 302, 303, 307, 308].includes(response.status) ||
                !location ||
                request.redirect === "manual"
            ) {
                void replay?.body?.cancel().catch(() => {});
                return response;
            }
            await response.body?.cancel();
            if (request.redirect === "error")
                throw new TypeError("Redirect encountered with redirect: error");
            if (redirects >= (this.options.maxRedirects ?? 20)) {
                void replay?.body?.cancel().catch(() => {});
                throw new TypeError("Too many redirects");
            }
            let target: URL;
            try {
                target = new URL(location, url);
                if (
                    !["http:", "https:"].includes(target.protocol) ||
                    target.username ||
                    target.password
                ) {
                    throw new TypeError("Invalid redirect destination");
                }
            } catch (error) {
                void replay?.body?.cancel().catch(() => {});
                throw error;
            }
            const headers = new Headers(wireHeaders);
            headers.delete("host");
            if (target.origin !== url.origin) {
                for (const name of ["authorization", "proxy-authorization", "cookie"])
                    headers.delete(name);
            }
            let method = request.method;
            let body = replay?.body ?? null;
            if (
                ((response.status === 301 || response.status === 302) && method === "POST") ||
                (response.status === 303 && method !== "HEAD")
            ) {
                method = "GET";
                void body?.cancel().catch(() => {});
                body = null;
                for (const name of [
                    "content-type",
                    "content-length",
                    "content-encoding",
                    "content-language",
                    "content-location",
                ])
                    headers.delete(name);
            }
            const next: FetchOptions = {
                method,
                headers,
                body,
                signal: request.signal,
                redirect: request.redirect,
                mode: request.mode === "navigate" ? "same-origin" : request.mode,
                credentials: request.credentials,
                duplex: "half",
            };
            try {
                request = new Request(target, next);
                wireHeaders = headers;
            } catch (error) {
                void body?.cancel().catch(() => {});
                throw error;
            }
        }
    }

    private async perform(
        request: Request,
        url: URL,
        wireHeaders: Headers,
        init: FetchOptions,
        redirected: boolean,
        scope?: RequestScope,
    ): Promise<WispResponse> {
        const aborter = new AbortController();
        const uploadAborter = new AbortController();
        const signal = AbortSignal.any([request.signal, this.lifetime.signal]);
        const abort = () => aborter.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const timeout = init.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
        const timer =
            timeout > 0
                ? setTimeout(
                      () => aborter.abort(new DOMException("Request timed out", "TimeoutError")),
                      timeout,
                  )
                : undefined;
        const trailers = deferred<RawHeaders>();
        let socket: ByteSocket | undefined;
        let release: (() => void) | undefined;
        let cleaned = false;
        const cleanup = (error?: Error) => {
            if (cleaned) return;
            cleaned = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            aborter.signal.removeEventListener("abort", onAbort);
            socket?.close(error);
            release?.();
            uploadAborter.abort(error);
            if (error) trailers.reject(error);
            else trailers.resolve([]);
        };
        const onAbort = () => cleanup(asError(aborter.signal.reason));
        aborter.signal.addEventListener("abort", onAbort, { once: true });
        try {
            aborter.signal.throwIfAborted();
            if (scope?.acquire) {
                release = await scope.acquire(aborter.signal);
                if (cleaned) release();
                aborter.signal.throwIfAborted();
            }
            socket = await this.openSocket(url, aborter.signal);
            if (cleaned) socket.close(asError(aborter.signal.reason));
            aborter.signal.throwIfAborted();
            const headers = new Headers(wireHeaders);
            for (const name of [
                "content-length",
                "transfer-encoding",
                "connection",
                "upgrade",
                "expect",
                "trailer",
                "proxy-connection",
            ])
                headers.delete(name);
            headers.set("host", authority(url));
            headers.set("connection", "close");
            scope?.prepare?.(url, headers, request.credentials);
            if (!headers.has("accept")) headers.set("accept", "*/*");
            if (!headers.has("accept-encoding"))
                headers.set(
                    "accept-encoding",
                    init.decompress === false
                        ? "identity"
                        : supportsBrotli()
                          ? "gzip, deflate, br"
                          : "gzip, deflate",
                );
            if (request.body) headers.set("transfer-encoding", "chunked");
            else if (["POST", "PUT", "PATCH"].includes(request.method))
                headers.set("content-length", "0");
            await socket.write(encodeHead(request.method, url, headers));
            void writeRequestBody(
                socket,
                request,
                this.options.maxRequestBytes ?? 64 * 1024 * 1024,
                uploadAborter.signal,
            ).catch((error: unknown) => cleanup(asError(error)));
            const reader = new ByteReader(socket.readable);
            const head = await readHead(reader, this.options.maxHeaderBytes);
            if (head.status === 101) throw new TypeError("Unexpected HTTP upgrade in fetch");
            scope?.receive?.(url, head.rawHeaders, request.credentials);
            const noBody = request.method === "HEAD" || [204, 205, 304].includes(head.status);
            let body: ReadableStream<Uint8Array> | null = null;
            if (noBody) cleanup();
            else {
                const iterator = readBody(
                    reader,
                    head,
                    this.options.maxResponseBytes ?? 256 * 1024 * 1024,
                    trailers.resolve,
                    this.options.maxHeaderBytes ?? 65_536,
                );
                body = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        try {
                            aborter.signal.throwIfAborted();
                            const { value, done } = await iterator.next();
                            if (done) {
                                controller.close();
                                cleanup();
                            } else controller.enqueue(value);
                        } catch (error) {
                            controller.error(
                                aborter.signal.aborted ? aborter.signal.reason : error,
                            );
                            cleanup(asError(error));
                        }
                    },
                    cancel() {
                        cleanup();
                        void iterator.return(undefined).catch(() => {});
                    },
                });
                const encodings =
                    head.headers
                        .get("content-encoding")
                        ?.split(",")
                        .map((value) => value.trim().toLowerCase())
                        .reverse() ?? [];
                if (init.decompress !== false) {
                    for (const encoding of encodings) {
                        if (encoding === "identity") continue;
                        if (
                            encoding !== "gzip" &&
                            encoding !== "deflate" &&
                            !(encoding === "br" && supportsBrotli())
                        )
                            throw new TypeError(`Unsupported content encoding: ${encoding}`);
                        const decompressor = new DecompressionStream(
                            encoding === "br" ? brotliFormat : (encoding as CompressionFormat),
                        );
                        const writer = decompressor.writable.getWriter();
                        body = body.pipeThrough({
                            readable: decompressor.readable,
                            writable: new WritableStream<Uint8Array>({
                                write: (chunk) => writer.write(chunk.slice()),
                                close: () => writer.close(),
                                abort: (reason: unknown) => writer.abort(reason),
                            }),
                        });
                    }
                    let decodedBytes = 0;
                    const limit = this.options.maxResponseBytes ?? 256 * 1024 * 1024;
                    body = body.pipeThrough(
                        new TransformStream<Uint8Array, Uint8Array>({
                            transform(chunk, controller) {
                                decodedBytes += chunk.length;
                                if (decodedBytes > limit)
                                    throw new RangeError(
                                        "Decoded response exceeds configured limit",
                                    );
                                controller.enqueue(chunk);
                            },
                        }),
                    );
                }
            }
            return new WispResponse(body, {
                ...head,
                url: url.href,
                redirected,
                trailers: trailers.promise,
            });
        } catch (error) {
            cleanup(asError(error));
            if (aborter.signal.aborted) throw aborter.signal.reason;
            throw error;
        }
    }

    close(): void {
        this.disposed = true;
        this.lifetime.abort(new DOMException("Flux client is closed", "AbortError"));
        for (const socket of this.active) socket.close();
        this.active.clear();
        this.wisp.close();
    }
}
