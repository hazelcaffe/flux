import { asError, deferred } from "./bytes.js";
import type { Flux } from "./client.js";
import type { TLSOptions, TLSSocket } from "./tls.js";

/** A callback-based TLS connection. Use Flux.connectTLS for a readable byte stream. */
export class FluxTLSSocket {
    readonly ready: Promise<void>;
    readonly closed: Promise<void>;
    onopen: (() => void) | null = null;
    onmessage: ((bytes: Uint8Array) => void) | null = null;
    onerror: ((error: Error) => void) | null = null;
    onclose: (() => void) | null = null;
    private readonly opening = deferred<void>();
    private readonly done = deferred<void>();
    private readonly aborter = new AbortController();
    private connection: TLSSocket | undefined;
    private negotiated: TLSSocket["metadata"] | undefined;
    private ended = false;

    constructor(client: Flux, host: string, port = 443, options: TLSOptions = {}) {
        this.ready = this.opening.promise;
        this.closed = this.done.promise;
        queueMicrotask(() => {
            void this.run(client, host, port, options);
        });
    }

    get metadata(): TLSSocket["metadata"] | undefined {
        return this.negotiated;
    }

    async send(bytes: Uint8Array): Promise<void> {
        if (this.ended) throw new Error("TLS socket is closed");
        const snapshot = this.connection ? bytes : bytes.slice();
        if (!this.connection) await this.ready;
        const socket = this.connection;
        if (!socket || this.ended) throw new Error("TLS socket is closed");
        try {
            await socket.write(snapshot);
        } catch (error) {
            this.finish(asError(error));
            throw error;
        }
    }

    close(): void {
        this.finish();
    }

    private async run(
        client: Flux,
        host: string,
        port: number,
        options: TLSOptions,
    ): Promise<void> {
        if (this.ended) return;
        try {
            const socket = await client.connectTLS(host, port, options, this.aborter.signal);
            if (this.ended) {
                socket.close();
                return;
            }
            this.connection = socket;
            this.negotiated = socket.metadata;
            this.opening.resolve();
            this.notify(() => this.onopen?.());
            const reader = socket.readable.getReader();
            try {
                while (!this.ended) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!this.ended) this.notify(() => this.onmessage?.(value));
                }
            } finally {
                reader.releaseLock();
            }
            this.finish();
        } catch (error) {
            this.finish(asError(error));
        }
    }

    private finish(error?: Error): void {
        if (this.ended) return;
        this.ended = true;
        const reason = error ?? new DOMException("TLS socket closed", "AbortError");
        this.aborter.abort(reason);
        this.opening.reject(reason);
        this.connection?.close(error);
        this.connection = undefined;
        if (error) this.done.reject(error);
        else this.done.resolve();
        queueMicrotask(() => {
            if (error) this.notify(() => this.onerror?.(error));
            this.notify(() => this.onclose?.());
        });
    }

    private notify(callback: () => void): void {
        try {
            callback();
        } catch (error) {
            queueMicrotask(() => {
                throw error;
            });
        }
    }
}

export interface FluxTLSSocketConstructor {
    new (host: string, port?: number, options?: TLSOptions): FluxTLSSocket;
}

/** @internal */
export function bindTLSSocket(client: Flux): FluxTLSSocketConstructor {
    return class extends FluxTLSSocket {
        constructor(host: string, port?: number, options?: TLSOptions) {
            super(client, host, port, options);
        }
    };
}
