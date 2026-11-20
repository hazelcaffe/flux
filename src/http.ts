import { type ByteReader, type ByteSocket, encoder } from "./bytes.js";

export type RawHeaders = [string, string][];
export interface ResponseHead {
    status: number;
    statusText: string;
    headers: Headers;
    rawHeaders: RawHeaders;
}

function validHeaderValue(value: string): boolean {
    return Array.from(value).every((char) => {
        const code = char.charCodeAt(0);
        return code === 9 || (code >= 32 && code <= 255 && code !== 127);
    });
}

export async function readHeaders(reader: ByteReader, maxBytes = 65_536): Promise<RawHeaders> {
    const headers: RawHeaders = [];
    let size = 0;
    for (;;) {
        const line = await reader.line(maxBytes);
        size += encoder.encode(line).length + 2;
        if (size > maxBytes) throw new RangeError("HTTP headers exceed configured limit");
        if (!line) return headers;
        const colon = line.indexOf(":");
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/gu, "");
        if (colon < 1 || !/^[!#$%&'*+.^_`|~\w-]+$/u.test(name) || !validHeaderValue(value)) {
            throw new TypeError("Malformed HTTP header");
        }
        headers.push([name, value]);
    }
}

export async function readHead(reader: ByteReader, maxBytes = 65_536): Promise<ResponseHead> {
    for (let interim = 0; interim < 16; interim++) {
        const statusLine = await reader.line(maxBytes);
        const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: ([\t\x20-\x7e\x80-\xff]*))?$/u.exec(
            statusLine,
        );
        if (!match) throw new TypeError(`Invalid HTTP status line: ${statusLine.slice(0, 100)}`);
        const rawHeaders = await readHeaders(reader, maxBytes);
        const status = Number(match[1]);
        if (status >= 200 || status === 101) {
            return {
                status,
                statusText: match[2] ?? "",
                rawHeaders,
                headers: new Headers(rawHeaders),
            };
        }
    }
    throw new TypeError("Too many informational HTTP responses");
}

export function headerTokens(value: string | null): string[] {
    return value?.split(",").map((token) => token.trim().toLowerCase()) ?? [];
}

export function bodyLength(head: ResponseHead): { chunked: boolean; length?: number } {
    const lengths = head.rawHeaders.filter(([name]) => name.toLowerCase() === "content-length");
    const encoding = head.headers.get("transfer-encoding");
    if (encoding !== null) {
        if (lengths.length || encoding.toLowerCase() !== "chunked") {
            throw new TypeError("Ambiguous or unsupported HTTP transfer encoding");
        }
        return { chunked: true };
    }
    if (!lengths.length) return { chunked: false };
    const values = lengths.flatMap(([, value]) => value.split(",").map((part) => part.trim()));
    if (!values.every((value) => /^\d+$/u.test(value) && value === values[0])) {
        throw new TypeError("Conflicting or invalid Content-Length headers");
    }
    const length = Number(values[0]);
    if (!Number.isSafeInteger(length))
        throw new RangeError("Content-Length exceeds safe integer range");
    return { chunked: false, length };
}

export async function* readBody(
    reader: ByteReader,
    head: ResponseHead,
    maxBytes: number,
    onTrailers: (trailers: RawHeaders) => void,
    maxHeaderBytes: number,
): AsyncGenerator<Uint8Array> {
    const framing = bodyLength(head);
    let total = 0;
    const count = (size: number) => {
        total += size;
        if (total > maxBytes) throw new RangeError("Response body exceeds configured limit");
    };
    if (framing.chunked) {
        for (;;) {
            const line = await reader.line(8192);
            if (!/^[\da-f]+(?:;[^\r\n]*)?$/iu.test(line))
                throw new TypeError("Invalid HTTP chunk size");
            const length = Number.parseInt(line.split(";")[0] ?? "", 16);
            if (!Number.isSafeInteger(length)) throw new RangeError("HTTP chunk is too large");
            if (!length) {
                const trailers = await readHeaders(reader, maxHeaderBytes);
                if (
                    trailers.some(([name]) =>
                        ["content-length", "transfer-encoding", "host"].includes(
                            name.toLowerCase(),
                        ),
                    )
                ) {
                    throw new TypeError("Forbidden HTTP trailer field");
                }
                onTrailers(trailers);
                return;
            }
            count(length);
            let remaining = length;
            while (remaining) {
                const chunk = await reader.exact(Math.min(remaining, 65_536));
                remaining -= chunk.length;
                yield chunk;
            }
            const ending = await reader.exact(2);
            if (ending[0] !== 13 || ending[1] !== 10)
                throw new TypeError("Invalid HTTP chunk delimiter");
        }
    }
    if (framing.length !== undefined) {
        count(framing.length);
        let remaining = framing.length;
        while (remaining) {
            const chunk = await reader.exact(Math.min(remaining, 65_536));
            remaining -= chunk.length;
            yield chunk;
        }
    } else {
        for (;;) {
            const chunk = await reader.some();
            if (!chunk) break;
            count(chunk.length);
            yield chunk;
        }
    }
    onTrailers([]);
}

export function authority(url: URL): string {
    return url.host;
}

export function hostname(url: URL): string {
    return url.hostname.replace(/^\[|\]$/gu, "");
}

export function encodeHead(method: string, url: URL, headers: Headers): Uint8Array {
    const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`];
    for (const [name, value] of headers) {
        if (/[^\x21-\x7e]/u.test(name) || !validHeaderValue(value)) {
            throw new TypeError("HTTP header contains invalid characters");
        }
        lines.push(`${name}: ${value}`);
    }
    // HTTP headers are Latin-1 bytes, not UTF-8.
    return Uint8Array.from(`${lines.join("\r\n")}\r\n\r\n`, (char) => char.charCodeAt(0));
}

export async function writeRequestBody(
    socket: ByteSocket,
    request: Request,
    limit: number,
    signal: AbortSignal,
): Promise<void> {
    if (!request.body) return;
    const reader = request.body.getReader();
    const abort = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    let total = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            total += value.length;
            if (total > limit) throw new RangeError("Request body exceeds configured limit");
            if (!value.length) continue;
            await socket.write(encoder.encode(`${value.length.toString(16)}\r\n`));
            await socket.write(value);
            await socket.write(encoder.encode("\r\n"));
        }
        await socket.write(encoder.encode("0\r\n\r\n"));
    } finally {
        signal.removeEventListener("abort", abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export interface WispResponseInit extends ResponseInit {
    url: string;
    redirected: boolean;
    rawHeaders: RawHeaders;
    trailers: Promise<RawHeaders>;
}

export class WispResponse extends Response {
    readonly rawHeaders: RawHeaders;
    readonly trailers: Promise<RawHeaders>;
    private readonly responseUrl: string;
    private readonly wasRedirected: boolean;

    constructor(body: BodyInit | null, init: WispResponseInit) {
        super(body, init);
        this.rawHeaders = init.rawHeaders;
        this.trailers = init.trailers;
        this.responseUrl = init.url;
        this.wasRedirected = init.redirected;
    }

    override get url(): string {
        return this.responseUrl;
    }
    override get redirected(): boolean {
        return this.wasRedirected;
    }
    override get type(): ResponseType {
        return "basic";
    }

    override clone(): WispResponse {
        const copy = super.clone();
        return new WispResponse(copy.body, {
            status: this.status,
            statusText: this.statusText,
            headers: copy.headers,
            url: this.url,
            redirected: this.redirected,
            rawHeaders: this.rawHeaders.map(([name, value]) => [name, value]),
            trailers: this.trailers,
        });
    }
}
