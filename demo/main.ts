import { Flux, FluxTransport, type WispWebSocket } from "../src/index.js";

// Expose constructors for testing from the playground console, not from package imports.
Object.assign(globalThis, { Flux, FluxTransport });

function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing UI element: ${id}`);
    return node as T;
}

let client: Flux | undefined;
let endpoint = "";
let requestAbort: AbortController | undefined;
let websocket: WispWebSocket | undefined;

function session(): Flux {
    const next = element<HTMLInputElement>("proxy").value;
    if (!client || endpoint !== next) {
        websocket?.close();
        client?.close();
        client = new Flux({ wisp_server: next });
        endpoint = next;
    }
    return client;
}

element("request-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    requestAbort?.abort();
    const abort = new AbortController();
    requestAbort = abort;
    const output = element("output");
    const status = element("status");
    const send = element<HTMLButtonElement>("send");
    send.disabled = true;
    output.textContent = "Opening Wisp stream and negotiating TLS…";
    status.textContent = "CONNECTING";
    const start = performance.now();
    try {
        const method = element<HTMLSelectElement>("method").value;
        const response = await session().request(element<HTMLInputElement>("target").value, {
            method,
            signal: abort.signal,
            ...(method === "POST" ? { body: element<HTMLTextAreaElement>("body").value } : {}),
        });
        status.textContent = `${response.status} / ${Math.round(performance.now() - start)} MS`;
        output.textContent = `${response.status} ${response.statusText}\n${response.url}\n\n${response.rawHeaders.map(([name, value]) => `${name}: ${value}`).join("\n")}\n\n`;
        const reader = response.body?.getReader();
        if (reader) {
            const decoder = new TextDecoder();
            let displayed = 0;
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (displayed < 100_000)
                    output.textContent += decoder.decode(value, { stream: true });
                displayed += value.length;
            }
            output.textContent += decoder.decode();
            if (displayed > 100_000)
                output.textContent += "\n[Display truncated at approximately 100 KB]";
        }
    } catch (error) {
        output.textContent =
            error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        status.textContent = "ERROR";
    } finally {
        send.disabled = false;
    }
});

element("cancel").addEventListener("click", () => requestAbort?.abort());
element("ws-form").addEventListener("submit", (event) => {
    event.preventDefault();
    websocket?.close();
    const output = element("ws-output");
    output.textContent = "Connecting…\n";
    try {
        const socket = session().connectWebSocket(element<HTMLInputElement>("ws-target").value);
        websocket = socket;
        socket.onopen = () => {
            output.textContent += "[open]\n";
        };
        socket.onmessage = (message) => {
            output.textContent += `← ${String(message.data)}\n`;
        };
        socket.onclose = (close) => {
            output.textContent += `[close ${close.code}] ${close.reason}\n`;
        };
        socket.onerror = () => {
            output.textContent += "[error] Connection failed.\n";
        };
    } catch (error) {
        output.textContent += String(error);
    }
});
element("ws-send-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const output = element("ws-output");
    if (websocket?.readyState !== 1) {
        output.textContent += "[not connected]\n";
        return;
    }
    const message = element<HTMLInputElement>("ws-message").value;
    websocket.send(message);
    output.textContent += `→ ${message}\n`;
});
element("ws-close").addEventListener("click", () => websocket?.close(1000, "Playground closed"));
window.addEventListener("pagehide", () => {
    requestAbort?.abort();
    client?.close();
});
