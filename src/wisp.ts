import {
    abortable,
    asError,
    ByteQueue,
    type ByteSocket,
    concat,
    deferred,
    encoder,
    queueStream,
} from "./bytes.js";

export type WispStreamType = "tcp" | "udp";
export type WebSocketFactory = (url: string) => WebSocket;

export interface WispOptions {
    webSocketFactory?: WebSocketFactory;
    connectTimeoutMs?: number;
    maxBufferedBytes?: number;
    maxPacketBytes?: number;
}

interface WispLifecycle {
    onload?: () => void;
    onerror?: (error: Error) => void;
}

export class WispError extends Error {
    override readonly name = "WispError";
    constructor(
        message: string,
        readonly reason = 1,
        readonly streamId = 0,
    ) {
        super(message);
    }
}

export function encodePacket(
    type: number,
    id: number,
    payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
    const packet = new Uint8Array(5 + payload.length);
    packet[0] = type;
    new DataView(packet.buffer).setUint32(1, id, true);
    packet.set(payload, 5);
    return packet;
}

export class WispStream implements ByteSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly closed: Promise<void>;
    private readonly done = deferred<void>();
    private readonly queue: ByteQueue;
    private credits: number;
    private changed = deferred<void>();
    private ended = false;
    private writes: Promise<void> = Promise.resolve();

    constructor(
        readonly id: number,
        readonly type: WispStreamType,
        private readonly client: WispClient,
        credits: number,
        limit: number,
    ) {
        this.credits = credits;
        this.queue = new ByteQueue(limit);
        this.closed = this.done.promise;
        this.readable = queueStream(this.queue, () => this.close());
    }

    write(data: Uint8Array): Promise<void> {
        const copy = data.slice();
        const operation = this.writes.then(async () => {
            if (this.ended) throw new WispError("Stream is closed", 2, this.id);
            const size = this.type === "udp" ? Math.max(copy.length, 1) : 16_384;
            for (
                let offset = 0;
                offset < copy.length || (offset === 0 && this.type === "udp");
                offset += size
            ) {
                while (this.type === "tcp" && !this.credits && !this.ended) {
                    await this.changed.promise;
                }
                if (this.ended) throw new WispError("Stream is closed", 2, this.id);
                if (this.type === "tcp") this.credits--;
                await this.client.send(2, this.id, copy.subarray(offset, offset + size));
            }
        });
        this.writes = operation.catch(() => {});
        return operation;
    }

    /** @internal */
    receive(data: Uint8Array): void {
        try {
            this.queue.push(data);
        } catch (error) {
            this.close(asError(error));
        }
    }

    /** @internal */
    resume(credits: number): void {
        this.credits = credits;
        this.changed.resolve();
        this.changed = deferred<void>();
    }

    /** @internal */
    finish(error?: Error): void {
        if (this.ended) return;
        this.ended = true;
        this.queue.end(error);
        this.changed.resolve();
        this.client.remove(this.id);
        if (error) this.done.reject(error);
        else this.done.resolve();
    }

    close(error?: Error): void {
        if (this.ended) return;
        void this.client.send(4, this.id, new Uint8Array([error ? 0x81 : 2])).catch(() => {});
        this.finish(error);
    }
}

/** Wisp v1 (protocol 1.2), including TCP, UDP and per-stream upload flow control. */
export class WispClient {
    private socket: WebSocket | undefined;
    private connecting: Promise<void> | undefined;
    private readonly streams = new Map<number, WispStream>();
    private nextId = 1;
    private initialCredits = 0;
    private disposed = false;
    readonly url: string;

    constructor(
        url: string | URL,
        private readonly options: WispOptions = {},
        private readonly lifecycle: WispLifecycle = {},
    ) {
        const parsed = new URL(url);
        if (
            !["ws:", "wss:"].includes(parsed.protocol) ||
            parsed.hash ||
            parsed.username ||
            parsed.password
        ) {
            throw new TypeError(
                "Wisp URL must be a ws:// or wss:// URL without credentials or fragment",
            );
        }
        if (!parsed.pathname.endsWith("/")) throw new TypeError("Wisp URL must end in /");
        this.url = parsed.href;
    }

    get ready(): boolean {
        return this.socket?.readyState === 1 && this.initialCredits > 0;
    }

    connect(): Promise<void> {
        if (this.disposed) return Promise.reject(new WispError("Client is closed"));
        if (this.connecting) return this.connecting;
        const ready = deferred<void>();
        this.connecting = ready.promise;
        let socket: WebSocket;
        try {
            socket = (this.options.webSocketFactory ?? ((url) => new WebSocket(url)))(this.url);
        } catch (error) {
            this.connecting = undefined;
            ready.reject(error);
            this.reportError(asError(error));
            return ready.promise;
        }
        this.socket = socket;
        socket.binaryType = "arraybuffer";
        const timer = setTimeout(
            () => fail(new WispError("Wisp handshake timed out")),
            this.options.connectTimeoutMs ?? 15_000,
        );
        const fail = (error: Error) => {
            clearTimeout(timer);
            ready.reject(error);
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.connecting = undefined;
            this.initialCredits = 0;
            for (const stream of [...this.streams.values()]) stream.finish(error);
            socket.close();
            this.reportError(error);
        };
        socket.addEventListener("error", () => fail(new WispError("Wisp WebSocket failed")));
        socket.addEventListener("close", () => fail(new WispError("Wisp WebSocket closed")));
        socket.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (this.socket !== socket) return;
            try {
                if (!(event.data instanceof ArrayBuffer))
                    throw new WispError("Expected binary Wisp packet");
                const packet = new Uint8Array(event.data);
                if (
                    packet.length < 5 ||
                    packet.length > (this.options.maxPacketBytes ?? 16 * 1024 * 1024)
                ) {
                    throw new WispError("Invalid Wisp packet length");
                }
                const type = packet[0];
                const id = new DataView(packet.buffer).getUint32(1, true);
                const payload = packet.subarray(5);
                if (!this.initialCredits) {
                    if (type !== 3 || id !== 0 || payload.length !== 4)
                        throw new WispError("Expected Wisp v1 CONTINUE handshake");
                    this.initialCredits = new DataView(
                        payload.buffer,
                        payload.byteOffset,
                        4,
                    ).getUint32(0, true);
                    if (!this.initialCredits)
                        throw new WispError("Invalid initial Wisp buffer size");
                    clearTimeout(timer);
                    ready.resolve();
                    queueMicrotask(() => {
                        if (!this.disposed && this.socket === socket) this.lifecycle.onload?.();
                    });
                    return;
                }
                const stream = this.streams.get(id);
                if (type === 4 && id === 0)
                    throw new WispError("Server closed Wisp connection", payload[0]);
                if (!stream) return; // late packets after local stream cancellation
                if (type === 2) stream.receive(payload.slice());
                else if (type === 3 && payload.length === 4 && stream.type === "tcp") {
                    stream.resume(
                        new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true),
                    );
                } else if (type === 4 && payload.length === 1) {
                    const reason = payload[0] ?? 1;
                    stream.finish(
                        reason === 2
                            ? undefined
                            : new WispError(
                                  `Remote stream closed (0x${reason.toString(16)})`,
                                  reason,
                                  id,
                              ),
                    );
                } else throw new WispError("Invalid Wisp stream packet", 1, id);
            } catch (error) {
                fail(asError(error));
            }
        });
        return ready.promise;
    }

    private reportError(error: Error): void {
        queueMicrotask(() => {
            if (!this.disposed) this.lifecycle.onerror?.(error);
        });
    }

    async open(
        host: string,
        port: number,
        type: WispStreamType = "tcp",
        signal?: AbortSignal,
    ): Promise<WispStream> {
        if (
            !host ||
            /[\s\0/]/u.test(host) ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65_535
        ) {
            throw new TypeError("Invalid destination hostname or port");
        }
        if (type !== "tcp" && type !== "udp") throw new TypeError("Invalid Wisp stream type");
        signal?.throwIfAborted();
        await abortable(this.connect(), signal);
        signal?.throwIfAborted();
        if (!this.ready) throw new WispError("Wisp connection closed while opening stream");
        let id = this.nextId;
        while (this.streams.has(id) || id === 0) id = (id + 1) >>> 0;
        this.nextId = (id + 1) >>> 0;
        const stream = new WispStream(
            id,
            type,
            this,
            this.initialCredits,
            this.options.maxBufferedBytes ?? 16 * 1024 * 1024,
        );
        this.streams.set(id, stream);
        const target = new Uint8Array(3);
        target[0] = type === "tcp" ? 1 : 2;
        new DataView(target.buffer).setUint16(1, port, true);
        try {
            await this.send(1, id, concat(target, encoder.encode(host)), signal);
        } catch (error) {
            stream.finish(asError(error));
            throw error;
        }
        return stream;
    }

    /** @internal */
    async send(type: number, id: number, payload: Uint8Array, signal?: AbortSignal): Promise<void> {
        const socket = this.socket;
        if (socket?.readyState !== 1) throw new WispError("Wisp is not connected");
        // The browser WebSocket API has no drain event. Bound queued uploads.
        while (socket.bufferedAmount > 1024 * 1024) {
            signal?.throwIfAborted();
            await new Promise<void>((resolve) => setTimeout(resolve, 4));
            if (socket.readyState !== 1) throw new WispError("Wisp closed during upload");
        }
        signal?.throwIfAborted();
        if (type === 2 && !this.streams.has(id)) throw new WispError("Stream is closed", 2, id);
        socket.send(encodePacket(type, id, payload));
    }

    /** @internal */
    remove(id: number): void {
        this.streams.delete(id);
    }

    close(): void {
        this.disposed = true;
        for (const stream of [...this.streams.values()]) stream.close();
        this.socket?.close();
    }
}
