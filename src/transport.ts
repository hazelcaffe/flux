import type {
    ProxyTransport,
    RawHeaders,
    TransferrableResponse,
    WebSocketDataType,
} from "@mercuryworkshop/proxy-transports";
import { Flux, type FluxOptions } from "./client.js";

/** Ready-to-use @mercuryworkshop/proxy-transports transport. */
export class FluxTransport implements ProxyTransport {
    readonly client: Flux;

    constructor(options: FluxOptions | string) {
        this.client = new Flux(typeof options === "string" ? { wisp_server: options } : options);
    }

    get ready(): boolean {
        return this.client.ready;
    }
    init = (): Promise<void> => this.client.init();

    connect = (
        url: URL,
        protocols: string[],
        requestHeaders: RawHeaders,
        onopen: (protocol: string, extensions: string) => void,
        onmessage: (data: WebSocketDataType) => void,
        onclose: (code: number, reason: string) => void,
        onerror: (error: string) => void,
    ): [(data: WebSocketDataType) => void, (code: number, reason: string) => void] => {
        const ws = this.client.connectWebSocket(url, protocols, { headers: requestHeaders });
        ws.binaryType = "arraybuffer";
        ws.onopen = () => onopen(ws.protocol, ws.extensions);
        ws.onmessage = (event) => onmessage(event.data);
        ws.onclose = (event) => onclose(event.code, event.reason);
        ws.onerror = (event) =>
            onerror("message" in event ? String(event.message) : "WebSocket connection failed");
        return [(data) => ws.send(data), (code, reason) => ws.close(code, reason)];
    };

    request = async (
        remote: URL,
        method: string,
        body: BodyInit | null,
        headers: RawHeaders,
        signal: AbortSignal | undefined,
    ): Promise<TransferrableResponse> => {
        const response = await this.client.request(remote, {
            method,
            body,
            headers,
            redirect: "manual",
            duplex: "half",
            ...(signal ? { signal } : {}),
        });
        return {
            body: response.body ?? new ArrayBuffer(0),
            headers: response.rawHeaders,
            status: response.status,
            statusText: response.statusText,
        };
    };

    close(): void {
        this.client.close();
    }
}

export default FluxTransport;
