import { CookieJar } from "tough-cookie";
import type { FetchOptions, Flux, RequestScope } from "./client.js";
import { createFetch } from "./fetch.js";
import type { WispResponse } from "./http.js";

export interface HTTPSessionOptions {
    baseUrl?: string | URL;
    headers?: HeadersInit;
    /** Opt into a private, in-memory cookie jar. */
    cookies?: boolean;
    /** Restore a trusted JSON snapshot from exportCookies(). */
    cookieJar?: string;
    /** Maximum active HTTP exchanges across all destinations in this session. */
    maxConnections?: number;
    /** Per-hop deadline, including time spent waiting for a connection slot. */
    requestTimeoutMs?: number;
}

class ConnectionSlots {
    private active = 0;
    private readonly pending = new Set<() => void>();

    constructor(private readonly limit: number) {}

    async acquire(signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();
        if (this.active < this.limit) return this.take();
        return new Promise((resolve, reject) => {
            const grant = () => {
                signal.removeEventListener("abort", abort);
                resolve(this.take());
            };
            const abort = () => {
                this.pending.delete(grant);
                reject(signal.reason);
            };
            this.pending.add(grant);
            signal.addEventListener("abort", abort, { once: true });
        });
    }

    private take(): () => void {
        this.active++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active--;
            const next = this.pending.values().next().value;
            if (next) {
                this.pending.delete(next);
                next();
            }
        };
    }
}

/** Independent HTTP defaults, cookie state and cancellation on a shared Flux connection. */
export class HTTPSession {
    baseUrl: string | URL | undefined;
    readonly headers: Headers;
    readonly fetch: typeof globalThis.fetch;
    private readonly aborter = new AbortController();
    private readonly jar: CookieJar | undefined;
    private readonly scope: RequestScope;

    constructor(
        private readonly client: Flux,
        private readonly options: HTTPSessionOptions = {},
    ) {
        this.baseUrl = options.baseUrl;
        this.headers = new Headers(options.headers);
        const limit = options.maxConnections ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new RangeError("maxConnections must be a positive integer");
        }
        const slots = new ConnectionSlots(limit);
        this.jar =
            options.cookieJar !== undefined
                ? CookieJar.deserializeSync(options.cookieJar)
                : options.cookies
                  ? new CookieJar(undefined, { allowSecureOnLocal: false })
                  : undefined;
        this.scope = {
            acquire: (signal) => slots.acquire(signal),
            prepare: (url, headers, credentials) => {
                if (!this.jar || credentials === "omit" || headers.has("cookie")) return;
                const cookies = this.jar
                    .getCookiesSync(url.href)
                    .filter((cookie) => !cookie.secure || url.protocol === "https:")
                    .map((cookie) => cookie.cookieString());
                if (cookies.length) headers.set("cookie", cookies.join("; "));
            },
            receive: (url, headers, credentials) => {
                if (!this.jar || credentials === "omit") return;
                for (const [name, value] of headers) {
                    if (name.toLowerCase() === "set-cookie") {
                        this.jar.setCookieSync(value, url.href, { ignoreError: true });
                    }
                }
            },
        };
        this.fetch = createFetch(
            (request, init) => this.run(request, init),
            () => this.baseUrl ?? client.options.baseUrl,
            () => this.headers,
        );
    }

    /** Raw HTTP request. Uses the same session jar and connection limit as fetch. */
    readonly request = async (
        input: RequestInfo | URL,
        init: FetchOptions = {},
    ): Promise<WispResponse> => {
        const headers = new Headers(this.headers);
        const requestHeaders = input instanceof Request ? input.headers : undefined;
        for (const [name, value] of new Headers(init.headers ?? requestHeaders)) {
            headers.set(name, value);
        }
        return this.run(input, { ...init, headers });
    };

    private async run(input: RequestInfo | URL, init: FetchOptions): Promise<WispResponse> {
        const signal = this.aborter.signal;
        signal.throwIfAborted();
        const requested = init.signal ?? (input instanceof Request ? input.signal : undefined);
        const base = this.baseUrl ?? this.client.options.baseUrl;
        const target = typeof input === "string" && base ? new URL(input, base) : input;
        const timeoutMs = init.timeoutMs ?? this.options.requestTimeoutMs;
        return this.client.requestWithScope(
            target,
            {
                ...init,
                signal: requested ? AbortSignal.any([signal, requested]) : signal,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            this.scope,
        );
    }

    /** Cookie snapshots may contain credentials; store them securely. */
    exportCookies(): string {
        const snapshot = this.jar?.serializeSync();
        return snapshot ? JSON.stringify(snapshot) : "";
    }

    close(): void {
        this.aborter.abort(new DOMException("HTTP session is closed", "AbortError"));
    }
}

export interface HTTPSessionConstructor {
    new (options?: HTTPSessionOptions): HTTPSession;
}

/** @internal */
export function bindHTTPSession(client: Flux): HTTPSessionConstructor {
    return class extends HTTPSession {
        constructor(options?: HTTPSessionOptions) {
            super(client, options);
        }
    };
}
