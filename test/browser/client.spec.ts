import { expect, test } from "@playwright/test";
import { fixture } from "../fixture.js";

let servers: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => {
    servers = await fixture();
});
test.afterAll(async () => {
    await servers.close();
});

test("playground exposes Flux and FluxTransport for console testing", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(
        async ({ wispServer, target }) => {
            const { Flux, FluxTransport } = globalThis as typeof globalThis &
                Pick<typeof import("../../src/index.js"), "Flux" | "FluxTransport">;
            const flux = new Flux({ wisp_server: wispServer });
            const transport = new FluxTransport({ wisp_server: wispServer });
            try {
                const url = new URL("/json", target);
                const response = await flux.fetch(url);
                const request = await transport.request(url, "HEAD", null, [], undefined);
                return { json: await response.json(), transportStatus: request.status };
            } finally {
                flux.close();
                transport.close();
            }
        },
        { wispServer: servers.wispUrl, target: servers.httpUrl },
    );
    expect(result).toEqual({ json: { ok: true, path: "/json" }, transportStatus: 200 });
});

test("Chromium: verified HTTPS, streaming uploads, gzip and WSS without WASM", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
        // Disable WASM before any SDK or demo module executes.
        Object.defineProperty(globalThis, "WebAssembly", { value: undefined, configurable: true });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Your TLS connection");
    const result = await page.evaluate(
        async ({ wispServer, ca, target }) => {
            const entry = "/dist/index.js";
            const { Flux } = (await import(entry)) as typeof import("../../src/index.js");
            const client = new Flux({ wisp_server: wispServer, tls: { ca: [ca] } });
            try {
                const response = await client.fetch(`${target}/json`);
                const json = await response.json();
                const compressed = await (await client.fetch(`${target}/gzip`)).text();
                const upload = await client.request(`${target}/echo`, {
                    method: "POST",
                    body: "browser upload",
                    headers: { Cookie: "demo=1", Origin: "https://example.test" },
                });
                const echoed = await upload.json();
                const socket = new client.WebSocket(target.replace("https:", "wss:"));
                const message = new Promise<unknown>((resolve, reject) => {
                    socket.onmessage = (event) => resolve(event.data);
                    socket.onerror = () => reject(new Error("WSS failed"));
                });
                await socket.ready;
                socket.send("browser websocket");
                const echo = await message;
                socket.close();
                return {
                    json,
                    compressed: compressed.length,
                    body: echoed.body,
                    cookie: echoed.headers.cookie,
                    origin: echoed.headers.origin,
                    echo,
                };
            } finally {
                client.close();
            }
        },
        { wispServer: servers.wispUrl, ca: servers.cert, target: servers.httpsUrl },
    );
    expect(result).toEqual({
        json: { ok: true, path: "/json" },
        compressed: 17_000,
        body: "browser upload",
        cookie: "demo=1",
        origin: "https://example.test",
        echo: "browser websocket",
    });
    expect(errors).toEqual([]);
});

test("Flux instance Fetch matches native browser responses for tested cases", async ({ page }) => {
    await page.goto(servers.httpUrl);
    const result = await page.evaluate(
        async ({ wispServer, target, entry }) => {
            const { Flux } = (await import(entry)) as typeof import("../../src/index.js");
            const client = new Flux({ wisp_server: wispServer });
            async function describeResponse(response: Response) {
                let immutable = false;
                try {
                    response.headers.set("x-added", "true");
                } catch (error) {
                    immutable = error instanceof TypeError;
                }
                const clone = response.clone();
                return {
                    type: response.type,
                    status: response.status,
                    url: response.url,
                    redirected: response.redirected,
                    setCookie: response.headers.get("set-cookie"),
                    hidden: response.headers.get("x-hidden"),
                    visible: response.headers.get("x-visible"),
                    immutable,
                    data: await response.text(),
                    clone: await clone.text(),
                };
            }
            async function sample(fetcher: typeof fetch) {
                const sameOrigin = await describeResponse(await fetcher("/chunked#test"));
                const manual = await describeResponse(
                    await fetcher("/redirect", { redirect: "manual" }),
                );
                const followed = await describeResponse(await fetcher("/redirect"));
                const response = await fetcher("/chunked");
                const reader = response.body?.getReader({ mode: "byob" });
                const chunks: string[] = [];
                if (reader) {
                    for (;;) {
                        const { done, value } = await reader.read(new Uint8Array(5));
                        if (done) break;
                        chunks.push(new TextDecoder().decode(value));
                    }
                }
                return {
                    sameOrigin,
                    manual,
                    followed,
                    byob: chunks.join(""),
                };
            }
            try {
                const cross = await client.fetch(`${target}/no-cors-headers`);
                const first = await (await client.fetch(`${target}/cache-probe`)).text();
                const second = await (await client.fetch(`${target}/cache-probe`)).text();
                return {
                    native: await sample(fetch.bind(globalThis)),
                    flux: await sample(client.fetch),
                    crossOrigin: {
                        status: cross.status,
                        header: cross.headers.get("x-hidden"),
                        body: await cross.json(),
                    },
                    cached: first === second,
                };
            } finally {
                client.close();
            }
        },
        {
            wispServer: servers.wispUrl,
            target: servers.httpUrl.replace("localhost", "127.0.0.1"),
            entry: "http://127.0.0.1:5173/dist/index.js",
        },
    );
    expect(result.flux).toEqual(result.native);
    expect(result.crossOrigin).toEqual({
        status: 200,
        header: "no",
        body: { ok: true, path: "/no-cors-headers" },
    });
    expect(result.cached).toBe(false);
});

test("Flux instance WebSocket matches native event-handler order and echo", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(
        async ({ wispServer, target }) => {
            const entry = "/dist/index.js";
            const { Flux } = (await import(entry)) as typeof import("../../src/index.js");
            const client = new Flux({ wisp_server: wispServer });
            function sample(Socket: typeof WebSocket) {
                return new Promise<object>((resolve, reject) => {
                    const ws = new Socket(target, ["echo"]);
                    const stateAtConstruction = ws.readyState;
                    const order: string[] = [];
                    let message = "";
                    let stateAtOpening = -1;
                    ws.addEventListener("open", () => order.push("first"));
                    ws.onopen = () => order.push("old");
                    ws.addEventListener("open", () => order.push("last"));
                    ws.onopen = function (event) {
                        stateAtOpening = ws.readyState;
                        order.push(event.currentTarget === this ? "handler" : "missing target");
                        ws.send("Flux echo");
                    };
                    ws.onmessage = (event) => {
                        message = String(event.data);
                        ws.close(1000, "done");
                    };
                    ws.onerror = () => reject(new Error("WebSocket failed"));
                    ws.onclose = (event) =>
                        resolve({
                            order,
                            message,
                            stateAtConstruction,
                            stateAtOpening,
                            code: event.code,
                            reason: event.reason,
                            wasClean: event.wasClean,
                            protocol: ws.protocol,
                            binaryType: ws.binaryType,
                        });
                });
            }
            try {
                return { native: await sample(WebSocket), flux: await sample(client.WebSocket) };
            } finally {
                client.close();
            }
        },
        { wispServer: servers.wispUrl, target: servers.httpUrl.replace("http:", "ws:") },
    );
    expect(result.flux).toEqual(result.native);
});
