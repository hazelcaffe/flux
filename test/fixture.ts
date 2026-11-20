import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHTTP, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHTTPS } from "node:https";
import { type AddressInfo, createServer as createTCP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { WebSocketServer } from "ws";

const port = (server: { address(): AddressInfo | string | null }): number =>
    (server.address() as AddressInfo).port;

export async function fixture() {
    const temporary = join(tmpdir(), "opencode");
    mkdirSync(temporary, { recursive: true });
    const directory = mkdtempSync(join(temporary, "flux-cert-"));
    execFileSync(
        "openssl",
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            join(directory, "key.pem"),
            "-out",
            join(directory, "cert.pem"),
            "-days",
            "2",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
        ],
        { stdio: "ignore" },
    );
    const key = readFileSync(join(directory, "key.pem"));
    const cert = readFileSync(join(directory, "cert.pem"), "utf8");
    function ecLeaf(name: string, san: string) {
        const keyFile = `${name}.key`;
        const certFile = `${name}.pem`;
        const csrFile = `${name}.csr`;
        const extFile = `${name}.ext`;
        writeFileSync(
            join(directory, extFile),
            `subjectAltName=DNS:${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`,
        );
        const options = { cwd: directory, stdio: "ignore" as const };
        execFileSync(
            "openssl",
            [
                "req",
                "-new",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:secp384r1",
                "-nodes",
                "-keyout",
                keyFile,
                "-out",
                csrFile,
                "-subj",
                "/CN=localhost",
            ],
            options,
        );
        execFileSync(
            "openssl",
            [
                "x509",
                "-req",
                "-in",
                csrFile,
                "-CA",
                "cert.pem",
                "-CAkey",
                "key.pem",
                "-CAcreateserial",
                "-out",
                certFile,
                "-days",
                "2",
                "-extfile",
                extFile,
            ],
            options,
        );
        return {
            key: readFileSync(join(directory, keyFile)),
            cert: readFileSync(join(directory, certFile)),
        };
    }
    let cacheProbe = 0;
    const handler = async (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/no-cors-headers") {
            response.setHeader("access-control-allow-origin", "*");
            response.setHeader("access-control-expose-headers", "x-visible");
        }
        response.setHeader("x-visible", "yes");
        response.setHeader("x-hidden", "no");
        if (url.pathname === "/cookie-redirect") {
            response.writeHead(302, {
                location: "/echo",
                "set-cookie": [
                    "demo=1; Path=/; HttpOnly",
                    "secure=1; Path=/; Secure",
                    "wrong-path=1; Path=/elsewhere",
                ],
            });
            response.end();
            return;
        }
        if (url.pathname === "/cache-probe") {
            response.setHeader("cache-control", "public, max-age=3600");
            response.end(String(++cacheProbe));
            return;
        }
        if (url.pathname === "/redirect") {
            response.writeHead(302, { location: "/json" });
            response.end();
            return;
        }
        if (url.pathname === "/loop") {
            response.writeHead(302, { location: "/loop" });
            response.end();
            return;
        }
        if (url.pathname === "/redirect307") {
            response.writeHead(307, { location: "/echo" });
            response.end();
            return;
        }
        if (url.pathname === "/redirect303") {
            response.writeHead(303, { location: "/echo" });
            response.end();
            return;
        }
        if (url.pathname === "/redirect-other") {
            response.writeHead(302, { location: `http://127.0.0.1:${port(http)}/echo` });
            response.end();
            return;
        }
        if (url.pathname === "/slow") {
            request.on("close", () => clearTimeout(timer));
            const timer = setTimeout(() => response.end("late"), 3000);
            return;
        }
        if (url.pathname === "/slow-body") {
            response.writeHead(200);
            response.write("first");
            const timer = setTimeout(() => response.end("late"), 3000);
            response.on("close", () => clearTimeout(timer));
            return;
        }
        if (url.pathname === "/empty") {
            response.writeHead(204);
            response.end();
            return;
        }
        if (["/br", "/gzip", "/deflate"].includes(url.pathname)) {
            const encoding = url.pathname.slice(1);
            response.writeHead(200, { "content-encoding": encoding });
            response.end(
                (encoding === "br"
                    ? brotliCompressSync
                    : encoding === "gzip"
                      ? gzipSync
                      : deflateSync)("compressed hello ".repeat(1000)),
            );
            return;
        }
        if (url.pathname === "/chunked") {
            response.writeHead(200, { trailer: "X-Checksum", "set-cookie": ["a=1", "b=2"] });
            response.write("hello ");
            response.addTrailers({ "X-Checksum": "ok" });
            response.end("world");
            return;
        }
        if (url.pathname === "/echo") {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            response.setHeader("content-type", "application/json");
            response.end(
                JSON.stringify({
                    method: request.method,
                    headers: request.headers,
                    body: Buffer.concat(chunks).toString(),
                }),
            );
            return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, path: url.pathname }));
    };
    const http = createHTTP((request, response) => {
        void handler(request, response);
    });
    const https = createHTTPS({ key, cert, minVersion: "TLSv1.2" }, (request, response) => {
        void handler(request, response);
    });
    const tls12 = createHTTPS(
        { key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" },
        (request, response) => {
            void handler(request, response);
        },
    );
    const ec = ecLeaf("ec", "localhost");
    const ec13 = createHTTPS({ ...ec, minVersion: "TLSv1.3" }, (request, response) => {
        void handler(request, response);
    });
    const ec12 = createHTTPS(
        { ...ec, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", ecdhCurve: "prime256v1" },
        (request, response) => {
            void handler(request, response);
        },
    );
    const wrongName = createHTTPS(ecLeaf("wrong", "not-localhost.test"), (request, response) => {
        void handler(request, response);
    });
    const echoWS = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => protocols.values().next().value ?? false,
    });
    for (const server of [http, https])
        server.on("upgrade", (request, socket, head) =>
            echoWS.handleUpgrade(request, socket, head, (ws) => {
                ws.on("message", (data, binary) => ws.send(data, { binary }));
                if (request.url === "/fragment") {
                    ws.send("frag", { fin: false });
                    ws.ping("ping");
                    ws.send("mented", { fin: true });
                }
                if (request.url === "/server-close") ws.close(1000, "bye");
            }),
        );
    const proxy = createHTTP();
    logging.set_level(logging.NONE);
    wisp.options.allow_loopback_ips = true;
    wisp.options.allow_private_ips = true;
    wisp.options.hostname_whitelist = [/^(?:localhost|127\.0\.0\.1|wrong\.test)$/u];
    wisp.options.send_buffer_size = 4;
    proxy.on("upgrade", wisp.routeRequest);
    const tcp = createTCP((socket) => socket.on("data", (data) => socket.write(data)));
    const raw = createTCP((socket) =>
        socket.once("data", (data) => {
            const path = data.toString().split(" ")[1];
            if (path === "/truncated")
                socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");
            else if (path === "/ambiguous")
                socket.end(
                    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
                );
            else if (path === "/bad-chunk")
                socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nnope\r\n");
            else if (path === "/latin")
                socket.end(
                    Buffer.from(
                        "HTTP/1.1 200 OK\r\nX-Name: caf\xe9\r\nContent-Length: 2\r\n\r\nok",
                        "latin1",
                    ),
                );
            else socket.end("HTTP/1.1 200 OK\r\n\r\nclose-delimited");
        }),
    );
    const allServers = [http, https, tls12, ec13, ec12, wrongName, proxy, tcp, raw];
    for (const server of allServers) {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
    }
    const udp = createSocket("udp4");
    udp.on("message", (data, info) => udp.send(data, info.port, info.address));
    udp.bind(0, "127.0.0.1");
    await once(udp, "listening");
    return {
        cert,
        wispUrl: `ws://127.0.0.1:${port(proxy)}/wisp/`,
        httpUrl: `http://localhost:${port(http)}`,
        httpsUrl: `https://localhost:${port(https)}`,
        tls12Url: `https://localhost:${port(tls12)}`,
        ec12Url: `https://localhost:${port(ec12)}`,
        ec13Url: `https://localhost:${port(ec13)}`,
        wrongNameUrl: `https://localhost:${port(wrongName)}`,
        rawUrl: `http://localhost:${port(raw)}`,
        tcpPort: port(tcp),
        udpPort: port(udp),
        tlsPort: port(https),
        async close() {
            for (const ws of echoWS.clients) ws.terminate();
            echoWS.close();
            udp.close();
            for (const server of allServers) {
                server.close();
                if ("closeAllConnections" in server) server.closeAllConnections();
            }
            rmSync(directory, { recursive: true });
        },
    };
}
