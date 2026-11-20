export const encoder = new TextEncoder();

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export function randomBytes(size: number): Uint8Array<ArrayBuffer> {
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error(
            "A cryptographically secure crypto.getRandomValues implementation is required",
        );
    }
    const result = new Uint8Array(size);
    for (let i = 0; i < size; i += 65_536) {
        globalThis.crypto.getRandomValues(result.subarray(i, i + 65_536));
    }
    return result;
}

export function base64(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function deferred<T>() {
    const result = Promise.withResolvers<T>();
    // A connection may fail before a consumer starts awaiting its readiness.
    void result.promise.catch(() => {});
    return result;
}

/** Cancel one waiter without canceling a connection shared by other streams. */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    const interrupted = deferred<never>();
    const abort = () => interrupted.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([promise, interrupted.promise]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

/** A bounded receive queue. Wisp v1 has no downstream flow-control mechanism. */
export class ByteQueue {
    private chunks: Uint8Array[] = [];
    private size = 0;
    private ended = false;
    private error: Error | undefined;
    private wake = deferred<void>();

    constructor(private readonly limit = 16 * 1024 * 1024) {}

    push(chunk: Uint8Array): void {
        if (this.ended) return;
        if (this.size + chunk.length > this.limit || this.chunks.length >= 16_384) {
            throw new RangeError(`Receive buffer exceeded ${this.limit} bytes`);
        }
        this.chunks.push(chunk);
        this.size += chunk.length;
        this.wake.resolve();
    }

    end(error?: Error): void {
        if (this.ended) return;
        this.ended = true;
        this.error = error;
        this.wake.resolve();
    }

    async read(): Promise<Uint8Array | undefined> {
        while (!this.chunks.length) {
            if (this.error) throw this.error;
            if (this.ended) return;
            await this.wake.promise;
            this.wake = deferred<void>();
        }
        const chunk = this.chunks.shift();
        if (chunk) this.size -= chunk.length;
        return chunk;
    }
}

export interface ByteSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly closed: Promise<void>;
    write(data: Uint8Array): Promise<void>;
    close(error?: Error): void;
}

export function queueStream(queue: ByteQueue, cancel: () => void): ReadableStream<Uint8Array> {
    return new ReadableStream({
        async pull(controller) {
            try {
                const chunk = await queue.read();
                if (chunk) controller.enqueue(chunk);
                else controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
        cancel,
    });
}

/** Buffered reader shared by HTTP and WebSocket; preserves upgrade leftovers. */
export class ByteReader {
    private buffer: Uint8Array = new Uint8Array();
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

    constructor(stream: ReadableStream<Uint8Array>) {
        this.reader = stream.getReader();
    }

    private async fill(): Promise<boolean> {
        const { value, done } = await this.reader.read();
        if (done) return false;
        this.buffer = concat(this.buffer, value);
        return true;
    }

    async exact(size: number): Promise<Uint8Array> {
        if (size <= this.buffer.length) {
            const result = this.buffer.slice(0, size);
            this.buffer = this.buffer.subarray(size);
            return result;
        }
        // Large frames may arrive one Wisp packet at a time; avoid repeatedly copying
        // the whole accumulated payload on each read.
        const result = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            if (!this.buffer.length && !(await this.fill())) {
                throw new TypeError("Unexpected end of stream");
            }
            const width = Math.min(size - offset, this.buffer.length);
            result.set(this.buffer.subarray(0, width), offset);
            this.buffer = this.buffer.subarray(width);
            offset += width;
        }
        return result;
    }

    async some(max = 65_536): Promise<Uint8Array | undefined> {
        while (!this.buffer.length) {
            if (!(await this.fill())) return;
        }
        const result = this.buffer.slice(0, max);
        this.buffer = this.buffer.subarray(result.length);
        return result;
    }

    async line(limit = 65_536): Promise<string> {
        let scanned = 0;
        for (;;) {
            for (let i = scanned; i + 1 < this.buffer.length; i++) {
                if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
                    if (i > limit) throw new RangeError("HTTP line is too long");
                    // HTTP/1 field values are octets (Latin-1), not UTF-8.
                    const line = Array.from(this.buffer.subarray(0, i), (byte) =>
                        String.fromCharCode(byte),
                    ).join("");
                    this.buffer = this.buffer.subarray(i + 2);
                    return line;
                }
            }
            if (this.buffer.length > limit + 1) throw new RangeError("HTTP line is too long");
            scanned = Math.max(0, this.buffer.length - 1);
            if (!(await this.fill())) throw new TypeError("Unexpected end of HTTP headers");
        }
    }
}
