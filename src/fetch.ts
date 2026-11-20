import type { FetchOptions } from "./client.js";
import type { WispResponse } from "./http.js";

const redirectStatuses = [301, 302, 303, 307, 308];
const forbiddenRequestHeaders = new Set([
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
    "x-http-method",
    "x-http-method-override",
    "x-method-override",
]);

function immutable(headers: Headers): Headers {
    const reject = () => {
        throw new TypeError("Headers are immutable");
    };
    for (const method of ["append", "delete", "set"]) {
        Object.defineProperty(headers, method, { value: reject });
    }
    return headers;
}

function opaqueRedirect(url: string): Response {
    // Response.error gives us native empty body and status-0 semantics, which
    // cannot be created by passing a status to the Response constructor.
    return Object.defineProperties(Response.error(), {
        type: { get: () => "opaqueredirect" },
        url: { get: () => url },
        clone: { value: () => opaqueRedirect(url) },
    });
}

function byteStream(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
    if (!body) return null;
    const reader = body.getReader();
    return new ReadableStream({
        type: "bytes",
        async pull(controller: ReadableByteStreamController) {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    reader.releaseLock();
                    controller.close();
                    controller.byobRequest?.respond(0);
                } else {
                    controller.enqueue(value.slice());
                }
            } catch (error) {
                reader.releaseLock();
                controller.error(error);
            }
        },
        async cancel(reason: unknown) {
            try {
                await reader.cancel(reason);
            } finally {
                reader.releaseLock();
            }
        },
    });
}

class FetchResponse extends Response {
    constructor(
        body: ReadableStream<Uint8Array> | null,
        init: ResponseInit,
        private readonly metadata: { url: string; redirected: boolean },
    ) {
        super(body, init);
        immutable(this.headers);
    }

    override get type(): ResponseType {
        return "basic";
    }
    override get url(): string {
        return this.metadata.url;
    }
    override get redirected(): boolean {
        return this.metadata.redirected;
    }

    override clone(): Response {
        const clone = super.clone();
        return new FetchResponse(clone.body, clone, this.metadata);
    }
}

function filtered(response: WispResponse): Response {
    const headers = new Headers();
    for (const [name, value] of response.headers) {
        if (name === "set-cookie" || name === "set-cookie2") continue;
        headers.append(name, value);
    }
    const url = new URL(response.url);
    url.hash = "";
    return new FetchResponse(
        byteStream(response.body),
        {
            status: response.status,
            statusText: response.statusText,
            headers,
        },
        { url: url.href, redirected: response.redirected },
    );
}

/** Bind a Fetch-shaped function to Flux without modifying globalThis.fetch. */
export function createFetch(
    perform: (request: Request, init: FetchOptions) => Promise<WispResponse>,
    baseUrl?: () => string | URL | undefined,
    defaultHeaders?: () => HeadersInit,
): typeof globalThis.fetch {
    return async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const base = baseUrl?.();
        const source = typeof input === "string" && base ? new URL(input, base) : input;
        let request: Request;
        if (defaultHeaders) {
            const headers = new Headers(defaultHeaders());
            for (const [name, value] of new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
            )) {
                headers.set(name, value);
            }
            request = new Request(source, { ...init, headers });
        } else {
            request = new Request(source, init);
        }
        request.signal.throwIfAborted();
        const headers = new Headers(request.headers);
        for (const name of [...headers.keys()]) {
            if (forbiddenRequestHeaders.has(name) || /^(proxy|sec)-/u.test(name))
                headers.delete(name);
        }
        try {
            const response = await perform(request, { headers });
            if (request.redirect === "manual" && redirectStatuses.includes(response.status)) {
                await response.body?.cancel();
                const url = new URL(response.url);
                url.hash = "";
                return opaqueRedirect(url.href);
            }
            return filtered(response);
        } catch (error) {
            request.signal.throwIfAborted();
            if (
                error instanceof DOMException &&
                ["AbortError", "TimeoutError"].includes(error.name)
            )
                throw error;
            if (error instanceof TypeError) throw error;
            throw new TypeError("Failed to fetch over Wisp", { cause: error });
        }
    };
}
