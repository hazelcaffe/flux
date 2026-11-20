import { sha1 } from "@noble/hashes/legacy";
import {
    asError,
    ByteReader,
    type ByteSocket,
    base64,
    concat,
    deferred,
    encoder,
    randomBytes,
} from "./bytes.js";
import type { Flux } from "./client.js";
import { authority, encodeHead, headerTokens, readHead } from "./http.js";

export interface WebSocketOptions {
    headers?: HeadersInit;
    handshakeTimeoutMs?: number;
    closeTimeoutMs?: number;
    maxMessageBytes?: number;
}

export interface WispWebSocketEventMap {
    open: Event;
    message: MessageEvent<string | ArrayBuffer | Blob>;
    close: CloseEvent;
    error: Event;
}

export function websocketAccept(key: string): string {
    return base64(sha1(encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)));
}

export function encodeFrame(opcode: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
    const extra = data.length < 126 ? 0 : data.length <= 65_535 ? 2 : 8;
    const header = new Uint8Array(2 + extra + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | (extra === 0 ? data.length : extra === 2 ? 126 : 127);
    const view = new DataView(header.buffer);
    if (extra === 2) view.setUint16(2, data.length);
    if (extra === 8) view.setBigUint64(2, BigInt(data.length));
    const mask = randomBytes(4);
    header.set(mask, 2 + extra);
    const payload = data.map((byte, index) => byte ^ (mask[index % 4] ?? 0));
    return concat(header, payload);
}

function closeEvent(code: number, reason: string, wasClean: boolean): CloseEvent {
    if (typeof CloseEvent !== "undefined")
        return new CloseEvent("close", { code, reason, wasClean });
    return Object.assign(new Event("close"), { code, reason, wasClean }) as CloseEvent;
}

function validCloseCode(code: number): boolean {
    return (
        code >= 1000 &&
        code < 5000 &&
        ![1004, 1005, 1006, 1015].includes(code) &&
        !(code >= 1016 && code < 3000)
    );
}

export class WispWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly #url: string;
    readonly ready: Promise<void>;
    private state = 0;
    private selectedProtocol = "";
    private pendingBytes = 0;
    private binary: BinaryType = "blob";
    private socket: ByteSocket | undefined;
    private readonly opening = deferred<void>();
    private readonly aborter = new AbortController();
    private readonly limit: number;
    private writes = Promise.resolve();
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    private closeSent = false;
    readonly #handlers = new Map<string, EventListener>();
    readonly #listeners = new Map<string, EventListener>();

    constructor(
        private readonly client: Flux,
        url: string | URL,
        protocols: string | string[] = [],
        private readonly options?: WebSocketOptions,
    ) {
        super();
        let target: URL;
        try {
            target = new URL(
                url,
                client.options.baseUrl ??
                    (typeof document !== "undefined"
                        ? document.baseURI
                        : typeof location !== "undefined"
                          ? location.href
                          : undefined),
            );
        } catch {
            throw new DOMException("Invalid WebSocket URL", "SyntaxError");
        }
        if (target.protocol === "http:") target.protocol = "ws:";
        if (target.protocol === "https:") target.protocol = "wss:";
        if (
            !["ws:", "wss:"].includes(target.protocol) ||
            target.href.includes("#") ||
            target.username ||
            target.password
        ) {
            throw new DOMException("Invalid WebSocket URL", "SyntaxError");
        }
        const requested = typeof protocols === "string" ? [protocols] : [...protocols].map(String);
        if (
            new Set(requested).size !== requested.length ||
            requested.some((protocol) => !/^[!#$%&'*+.^_`|~\w-]+$/u.test(protocol))
        ) {
            throw new DOMException("Invalid or duplicate WebSocket subprotocol", "SyntaxError");
        }
        this.#url = target.href;
        this.ready = this.opening.promise;
        this.limit =
            options?.maxMessageBytes ?? client.options.maxWebSocketMessageBytes ?? 16 * 1024 * 1024;
        // Always defer events so callers can install handlers after construction.
        queueMicrotask(() => {
            void this.run(target, requested);
        });
    }

    get url(): string {
        return this.#url;
    }

    // Register the handler as an EventTarget listener at assignment time. This
    // preserves registration order, target/currentTarget and stopImmediatePropagation.
    private setHandler(type: string, callback: EventListener | null): void {
        if (typeof callback !== "function") {
            const listener = this.#listeners.get(type);
            if (listener) super.removeEventListener(type, listener);
            this.#listeners.delete(type);
            this.#handlers.delete(type);
            return;
        }
        this.#handlers.set(type, callback);
        if (!this.#listeners.has(type)) {
            const listener: EventListener = (event) => this.#handlers.get(type)?.call(this, event);
            this.#listeners.set(type, listener);
            super.addEventListener(type, listener);
        }
    }

    get onopen(): WebSocket["onopen"] {
        return this.#handlers.get("open") ?? null;
    }
    set onopen(callback: WebSocket["onopen"]) {
        this.setHandler("open", callback);
    }
    get onerror(): WebSocket["onerror"] {
        return this.#handlers.get("error") ?? null;
    }
    set onerror(callback: WebSocket["onerror"]) {
        this.setHandler("error", callback);
    }
    get onclose(): WebSocket["onclose"] {
        return (this.#handlers.get("close") as WebSocket["onclose"]) ?? null;
    }
    set onclose(callback: WebSocket["onclose"]) {
        this.setHandler("close", callback as EventListener | null);
    }
    get onmessage(): WebSocket["onmessage"] {
        return (this.#handlers.get("message") as WebSocket["onmessage"]) ?? null;
    }
    set onmessage(callback: WebSocket["onmessage"]) {
        this.setHandler("message", callback as EventListener | null);
    }

    get readyState(): number {
        return this.state;
    }
    get protocol(): string {
        return this.selectedProtocol;
    }
    get extensions(): string {
        return "";
    }
    get bufferedAmount(): number {
        return this.pendingBytes;
    }
    get binaryType(): BinaryType {
        return this.binary;
    }
    set binaryType(value: BinaryType) {
        if (value === "blob" || value === "arraybuffer") this.binary = value;
    }

    override addEventListener<K extends keyof WispWebSocketEventMap>(
        type: K,
        callback: ((this: WispWebSocket, event: WispWebSocketEventMap[K]) => void) | null,
        options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ): void {
        super.addEventListener(type, callback, options);
    }

    override removeEventListener<K extends keyof WispWebSocketEventMap>(
        type: K,
        callback: ((this: WispWebSocket, event: WispWebSocketEventMap[K]) => void) | null,
        options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ): void {
        super.removeEventListener(type, callback, options);
    }

    private async run(url: URL, protocols: string[]): Promise<void> {
        if (this.state !== 0) return;
        const timer = setTimeout(
            () => this.fail(new Error("WebSocket handshake timed out")),
            this.options?.handshakeTimeoutMs ?? 15_000,
        );
        try {
            const socket = await this.client.openSocket(url, this.aborter.signal);
            this.socket = socket;
            if (this.state !== 0) {
                socket.close();
                return;
            }
            const key = base64(randomBytes(16));
            const headers = new Headers(this.options?.headers);
            for (const name of [
                "content-length",
                "transfer-encoding",
                "sec-websocket-extensions",
                "sec-websocket-protocol",
            ])
                headers.delete(name);
            headers.set("host", authority(url));
            headers.set("upgrade", "websocket");
            headers.set("connection", "Upgrade");
            headers.set("sec-websocket-key", key);
            headers.set("sec-websocket-version", "13");
            if (!headers.has("origin") && typeof location !== "undefined") {
                headers.set("origin", location.origin);
            }
            if (protocols.length) headers.set("sec-websocket-protocol", protocols.join(", "));
            await socket.write(encodeHead("GET", url, headers));
            const reader = new ByteReader(socket.readable);
            const head = await readHead(reader, this.client.options.maxHeaderBytes);
            if (
                head.status !== 101 ||
                head.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
                !headerTokens(head.headers.get("connection")).includes("upgrade") ||
                head.headers.get("sec-websocket-accept") !== websocketAccept(key)
            ) {
                throw new TypeError("Invalid WebSocket upgrade response");
            }
            const selected = head.headers.get("sec-websocket-protocol") ?? "";
            if (
                (protocols.length
                    ? !protocols.includes(selected)
                    : head.headers.has("sec-websocket-protocol")) ||
                head.headers.has("sec-websocket-extensions")
            ) {
                throw new TypeError("Server selected an unoffered WebSocket protocol or extension");
            }
            if (this.state !== 0) return;
            clearTimeout(timer);
            this.selectedProtocol = selected;
            this.state = 1;
            this.opening.resolve();
            this.dispatchEvent(new Event("open"));
            await this.receive(reader);
        } catch (error) {
            this.fail(asError(error));
        } finally {
            clearTimeout(timer);
        }
    }

    private async receive(reader: ByteReader): Promise<void> {
        let fragments: Uint8Array[] = [];
        let length = 0;
        let messageOpcode = 0;
        while (this.state !== 3) {
            const head = await reader.exact(2);
            const first = head[0] ?? 0;
            const second = head[1] ?? 0;
            const fin = Boolean(first & 0x80);
            const opcode = first & 15;
            if (first & 0x70 || second & 0x80 || ![0, 1, 2, 8, 9, 10].includes(opcode))
                throw new TypeError("Invalid server WebSocket frame");
            let size = second & 0x7f;
            if (size === 126) {
                const bytes = await reader.exact(2);
                size = new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0);
                if (size < 126) throw new TypeError("Non-canonical WebSocket length");
            } else if (size === 127) {
                const bytes = await reader.exact(8);
                const big = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
                if (big > BigInt(Number.MAX_SAFE_INTEGER) || big <= 65_535n)
                    throw new RangeError("Invalid WebSocket length");
                size = Number(big);
            }
            const control = opcode >= 8;
            if (control && (!fin || size > 125))
                throw new TypeError("Invalid WebSocket control frame");
            if (size > this.limit || (!control && length + size > this.limit))
                throw new RangeError("WebSocket message exceeds configured limit");
            const payload = await reader.exact(size);
            if (opcode === 8) {
                if (size === 1) throw new TypeError("Invalid WebSocket close payload");
                const code = size
                    ? new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0)
                    : 1005;
                if (size && !validCloseCode(code))
                    throw new TypeError("Invalid WebSocket close code");
                const reason = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                    payload.subarray(2),
                );
                this.state = 2;
                if (!this.closeSent) {
                    this.closeSent = true;
                    await this.frame(8, payload);
                } else await this.writes;
                this.finish(code, reason, true);
                return;
            }
            if (opcode === 9) {
                await this.frame(10, payload);
                continue;
            }
            if (opcode === 10) continue;
            if (opcode === 0 ? !messageOpcode : Boolean(messageOpcode))
                throw new TypeError("Invalid WebSocket fragmentation");
            if (opcode !== 0) messageOpcode = opcode;
            if (payload.length) {
                if (fragments.length >= 16_384)
                    throw new RangeError("Too many WebSocket fragments");
                fragments.push(payload);
            }
            length += size;
            if (!fin) continue;
            const data = concat(...fragments);
            const message =
                messageOpcode === 1
                    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data)
                    : this.binaryType === "blob"
                      ? new Blob([data])
                      : data.buffer;
            fragments = [];
            length = 0;
            messageOpcode = 0;
            if (this.state === 1)
                this.dispatchEvent(
                    new MessageEvent("message", {
                        data: message,
                        origin: new URL(this.url).origin,
                    }),
                );
        }
    }

    private frame(opcode: number, data: Uint8Array): Promise<void> {
        if (!this.socket) return Promise.reject(new Error("WebSocket is not connected"));
        return this.socket.write(encodeFrame(opcode, data));
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (arguments.length === 0) throw new TypeError("WebSocket.send requires a message");
        if (typeof data === "symbol") throw new TypeError("Cannot convert Symbol to a string");
        if (
            !(data instanceof Blob) &&
            !(data instanceof ArrayBuffer) &&
            !ArrayBuffer.isView(data)
        ) {
            data = String(data);
        }
        if (this.state === 0)
            throw new DOMException("WebSocket is connecting", "InvalidStateError");
        const size =
            typeof data === "string"
                ? encoder.encode(data).length
                : data instanceof Blob
                  ? data.size
                  : data.byteLength;
        this.pendingBytes += size;
        if (this.state !== 1) return;
        if (size > this.limit || this.pendingBytes > this.limit) {
            this.state = 2;
            queueMicrotask(() =>
                this.fail(new RangeError("WebSocket send buffer exceeds configured limit")),
            );
            return;
        }
        // Copy synchronous inputs now: mutating a buffer after send must not change the frame.
        const snapshot =
            typeof data === "string"
                ? encoder.encode(data)
                : data instanceof Blob
                  ? data
                  : ArrayBuffer.isView(data)
                    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
                    : new Uint8Array(data).slice();
        this.writes = this.writes
            .then(async () => {
                const payload =
                    snapshot instanceof Blob
                        ? new Uint8Array(await snapshot.arrayBuffer())
                        : snapshot;
                await this.frame(typeof data === "string" ? 1 : 2, payload);
            })
            .catch((error: unknown) => this.fail(asError(error)))
            .finally(() => {
                this.pendingBytes -= size;
            });
    }

    close(code?: number, reason = ""): void {
        if (code !== undefined) code &= 0xffff;
        if (
            code !== undefined &&
            code !== 1000 &&
            (code < 3000 || code > 4999 || !Number.isInteger(code))
        )
            throw new DOMException("Invalid close code", "InvalidAccessError");
        const text = encoder.encode(reason);
        if (text.length > 123)
            throw new DOMException("Close reason exceeds 123 UTF-8 bytes", "SyntaxError");
        if (this.state >= 2) return;
        if (this.state === 0) {
            this.state = 2;
            this.aborter.abort();
            queueMicrotask(() => this.fail(new Error("WebSocket closed while connecting")));
            return;
        }
        this.state = 2;
        const payload =
            code !== undefined || reason ? new Uint8Array(2 + text.length) : new Uint8Array();
        if (payload.length) {
            new DataView(payload.buffer).setUint16(0, code ?? 1000);
            payload.set(text, 2);
        }
        this.closeSent = true;
        this.writes = this.writes
            .then(() => this.frame(8, payload))
            .catch((error: unknown) => this.fail(asError(error)));
        this.closeTimer = setTimeout(
            () => this.finish(1006, "", false),
            this.options?.closeTimeoutMs ?? 5000,
        );
    }

    private fail(error: Error): void {
        if (this.state === 3) return;
        this.opening.reject(error);
        this.finish(1006, "", false, error);
    }

    private finish(code: number, reason: string, clean: boolean, error?: Error): void {
        if (this.state === 3) return;
        this.state = 3;
        clearTimeout(this.closeTimer);
        this.aborter.abort();
        this.socket?.close();
        if (error) {
            const event = new Event("error");
            this.dispatchEvent(
                this.options ? Object.assign(event, { error, message: error.message }) : event,
            );
        }
        this.dispatchEvent(closeEvent(code, reason, clean));
    }
}

export interface WispWebSocketConstructor {
    new (url: string | URL, protocols?: string | string[]): WispWebSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
}

export function createWebSocketClass(client: Flux): WispWebSocketConstructor {
    return class WebSocket extends WispWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
            if (arguments.length === 0) throw new TypeError("WebSocket requires a URL");
            super(client, url, protocols);
        }
    };
}
