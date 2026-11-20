import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ByteQueue, ByteReader, concat, encoder, randomBytes } from "../src/bytes.js";
import { bodyLength, readBody, readHead } from "../src/http.js";
import { matchesDNSName } from "../src/tls.js";
import { encodeFrame, websocketAccept } from "../src/websocket.js";
import { encodePacket, WispClient } from "../src/wisp.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const close of cleanup.splice(0)) close();
});

function bufferCount(count: number): Uint8Array {
    const value = new Uint8Array(4);
    new DataView(value.buffer).setUint32(0, count, true);
    return value;
}

async function server(onConnection: (socket: WebSocket) => void) {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", onConnection);
    await once(wss, "listening");
    cleanup.push(() => {
        for (const socket of wss.clients) socket.terminate();
        wss.close();
    });
    const client = new WispClient(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, {
        connectTimeoutMs: 100,
    });
    cleanup.push(() => client.close());
    return client;
}

function reader(text: string | Uint8Array, fragment = false): ByteReader {
    const bytes = typeof text === "string" ? encoder.encode(text) : text;
    return new ByteReader(
        new ReadableStream({
            start(controller) {
                if (fragment) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                else controller.enqueue(bytes);
                controller.close();
            },
        }),
    );
}

describe("Wisp framing and lifecycle", () => {
    it("encodes little-endian stream identifiers", () => {
        expect(encodePacket(2, 0x12345678, new Uint8Array([9]))).toEqual(
            new Uint8Array([2, 0x78, 0x56, 0x34, 0x12, 9]),
        );
    });
    it("waits for the server's v1 handshake", async () => {
        const client = await server((socket) => {
            setTimeout(() => socket.send(encodePacket(3, 0, bufferCount(4))), 20);
        });
        expect(client.ready).toBe(false);
        await client.connect();
        expect(client.ready).toBe(true);
    });
    it.each([
        new Uint8Array([1]),
        encodePacket(2, 0, new Uint8Array()),
        encodePacket(3, 1, bufferCount(1)),
        encodePacket(3, 0, bufferCount(0)),
    ])("rejects malformed initial packets %#", async (packet) => {
        const client = await server((socket) => socket.send(packet));
        await expect(client.connect()).rejects.toThrow();
    });
    it("times out a silent Wisp endpoint", async () => {
        const client = await server(() => {});
        await expect(client.connect()).rejects.toThrow("timed out");
    });
    it("aborts a stream waiting on the Wisp handshake without aborting other waiters", async () => {
        const client = await server((socket) => {
            setTimeout(() => socket.send(encodePacket(3, 0, bufferCount(4))), 35);
        });
        const aborter = new AbortController();
        const interrupted = client.open("example.com", 80, "tcp", aborter.signal);
        const surviving = client.open("example.com", 80);
        aborter.abort();
        await expect(interrupted).rejects.toMatchObject({ name: "AbortError" });
        (await surviving).close();
        expect(client.ready).toBe(true);
    });
    it("obeys CONTINUE credits and wakes blocked writes on close", async () => {
        let resume: (() => void) | undefined;
        let first: (() => void) | undefined;
        const seen = new Promise<void>((resolve) => {
            first = resolve;
        });
        let packets = 0;
        const client = await server((socket) => {
            socket.send(encodePacket(3, 0, bufferCount(1)));
            socket.on("message", (data) => {
                const packet = new Uint8Array(data as Buffer);
                const id = new DataView(packet.buffer, packet.byteOffset).getUint32(1, true);
                if (packet[0] === 1)
                    resume = () => socket.send(encodePacket(3, id, bufferCount(1)));
                if (packet[0] === 2) {
                    packets++;
                    first?.();
                }
            });
        });
        const stream = await client.open("example.com", 80);
        let complete = false;
        const write = stream.write(new Uint8Array(32_768)).then(() => {
            complete = true;
        });
        await seen;
        expect(packets).toBe(1);
        expect(complete).toBe(false);
        resume?.();
        await write;
        const blocked = stream.write(new Uint8Array([1]));
        stream.close();
        await expect(blocked).rejects.toThrow("closed");
    });
    it("reconnects after upstream disconnection", async () => {
        let connections = 0;
        let close: (() => void) | undefined;
        const client = await server((socket) => {
            connections++;
            socket.send(encodePacket(3, 0, bufferCount(4)));
            close = () => socket.close();
        });
        const stream = await client.open("example.com", 80);
        close?.();
        await expect(stream.closed).rejects.toThrow();
        await client.connect();
        expect(connections).toBe(2);
    });
    it("surfaces server reason codes and isolates closed streams", async () => {
        const client = await server((socket) => {
            socket.send(encodePacket(3, 0, bufferCount(4)));
            socket.on("message", (data) => {
                const packet = new Uint8Array(data as Buffer);
                if (packet[0] !== 1) return;
                const id = new DataView(packet.buffer, packet.byteOffset).getUint32(1, true);
                socket.send(encodePacket(4, id, new Uint8Array([0x48])));
            });
        });
        const stream = await client.open("blocked.example", 80);
        await expect(stream.closed).rejects.toMatchObject({ reason: 0x48 });
        expect(client.ready).toBe(true);
    });
    it("validates Wisp URLs and target addresses", async () => {
        expect(() => new WispClient("https://example.com/")).toThrow();
        expect(() => new WispClient("wss://example.com/wisp")).toThrow();
        const client = new WispClient("ws://127.0.0.1/");
        await expect(client.open("x\0", 80)).rejects.toThrow();
        await expect(client.open("example.com", 0)).rejects.toThrow();
        client.close();
        await expect(client.connect()).rejects.toThrow("closed");
    });
});

describe("HTTP parsing", () => {
    it("handles arbitrarily fragmented headers and informational responses", async () => {
        const input = reader(
            "HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
            true,
        );
        const head = await readHead(input);
        const chunks = [];
        for await (const chunk of readBody(input, head, 100, () => {}, 100)) chunks.push(chunk);
        expect(new TextDecoder().decode(concat(...chunks))).toBe("ok");
    });
    it("preserves Latin-1 header values", async () => {
        const head = await readHead(
            reader(
                Uint8Array.from(
                    Buffer.from("HTTP/1.1 200 OK\r\nX-Name: caf\xe9\r\n\r\n", "latin1"),
                ),
            ),
        );
        expect(head.headers.get("x-name")).toBe("café");
    });
    it.each([
        "HTTP/2 200 OK\r\n\r\n",
        "HTTP/1.1 200 OK\r\n bad: folded\r\n\r\n",
        "HTTP/1.1 200 OK\r\nmissing colon\r\n\r\n",
        "HTTP/1.1 200 OK\r\nX-Name: bad\0value\r\n\r\n",
    ])("rejects malformed headers %#", async (input) => {
        await expect(readHead(reader(input))).rejects.toThrow();
    });
    it.each(
        (
            [
                [
                    ["Content-Length", "1"],
                    ["Content-Length", "2"],
                ],
                [["Content-Length", "-1"]],
                [["Content-Length", "9007199254740992"]],
                [["Transfer-Encoding", "gzip, chunked"]],
                [
                    ["Transfer-Encoding", "chunked"],
                    ["Content-Length", "1"],
                ],
            ] as [string, string][][]
        ).map((rawHeaders) => ({ rawHeaders })),
    )("rejects ambiguous framing %#", ({ rawHeaders }) => {
        expect(() =>
            bodyLength({
                status: 200,
                statusText: "OK",
                rawHeaders,
                headers: new Headers(rawHeaders),
            }),
        ).toThrow();
    });
    it("bounds headers", async () => {
        await expect(
            readHead(reader(`HTTP/1.1 200 OK\r\nX: ${"a".repeat(100)}\r\n\r\n`), 50),
        ).rejects.toThrow();
    });
    it("rejects malformed chunks and forbidden trailers", async () => {
        for (const body of ["1\r\nxZZ", "0\r\nContent-Length: 1\r\n\r\n", "ffffffffffffffff\r\n"]) {
            const input = reader(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`);
            const head = await readHead(input);
            await expect(
                (async () => {
                    for await (const _chunk of readBody(input, head, 100, () => {}, 100)) {
                    }
                })(),
            ).rejects.toThrow();
        }
    });
});

describe("crypto and bounded buffers", () => {
    it("matches only complete DNS labels and SAN-legal wildcards", () => {
        expect(matchesDNSName("WWW.Example.COM", "*.example.com")).toBe(true);
        expect(matchesDNSName("example.com", "*.example.com")).toBe(false);
        expect(matchesDNSName("a.b.example.com", "*.example.com")).toBe(false);
        expect(matchesDNSName("bad.example.com", "bad.*.com")).toBe(false);
        expect(matchesDNSName("example.com", "*.com")).toBe(false);
        expect(matchesDNSName("xn--name.example.com", "*.example.com")).toBe(false);
    });
    it("computes the RFC 6455 sample handshake", () => {
        expect(websocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    });
    it.each([0, 125, 126, 65_535, 65_536])("masks client frames of %i bytes", (size) => {
        const payload = new Uint8Array(size).fill(65);
        const frame = encodeFrame(2, payload);
        const extra = size < 126 ? 0 : size <= 65_535 ? 2 : 8;
        const mask = frame.subarray(2 + extra, 6 + extra);
        expect((frame[1] ?? 0) & 0x80).toBe(0x80);
        expect(frame.subarray(6 + extra).map((byte, i) => byte ^ (mask[i % 4] ?? 0))).toEqual(
            payload,
        );
    });
    it("requires secure random bytes and handles the getRandomValues size limit", () => {
        const bytes = randomBytes(100_000);
        expect(bytes.length).toBe(100_000);
        expect(bytes.some((byte) => byte !== 0)).toBe(true);
    });
    it("bounds buffered bytes and preserves empty datagrams", async () => {
        const queue = new ByteQueue(4);
        queue.push(new Uint8Array());
        expect(await queue.read()).toEqual(new Uint8Array());
        expect(() => queue.push(new Uint8Array(5))).toThrow();
        queue.end(new Error("failed"));
        await expect(queue.read()).rejects.toThrow("failed");
    });
});
