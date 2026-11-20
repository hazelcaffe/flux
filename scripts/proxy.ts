import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

// Local development only. Opt in to a restricted demo on this machine's tailnet interface.
const tailnet = process.env.FLUX_TAILSCALE_IP;
if (
    tailnet &&
    !networkInterfaces().tailscale0?.some(
        ({ address, family }) => family === "IPv4" && address === tailnet,
    )
) {
    throw new Error("FLUX_TAILSCALE_IP must be an IPv4 address assigned to tailscale0");
}
const host = tailnet || "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
const origin = `http://${host}:${port}`;
const assets = new Map<string, { bytes: Buffer; type: string }>();
if (tailnet) {
    const directory = resolve(import.meta.dirname, "../demo-dist");
    const index = readFileSync(resolve(directory, "index.html"), "utf8").replace(
        'value="ws://127.0.0.1:4000/wisp/"',
        `value="ws://${host}:${port}/wisp/"`,
    );
    assets.set("/", { type: "text/html; charset=utf-8", bytes: Buffer.from(index) });
    for (const name of readdirSync(resolve(directory, "assets"))) {
        if (!/^[\w-]+\.(?:js|css)$/u.test(name)) continue;
        const type = name.endsWith(".js") ? "text/javascript" : "text/css";
        assets.set(`/assets/${name}`, {
            type,
            bytes: readFileSync(resolve(directory, "assets", name)),
        });
    }
    Object.assign(wisp.options, {
        hostname_whitelist: [/^example\.com$/iu, /^echo\.websocket\.org$/iu],
        port_whitelist: [80, 443],
        allow_direct_ip: false,
        allow_udp_streams: false,
        allow_private_ips: false,
        allow_loopback_ips: false,
        stream_limit_total: 12,
    });
}
const server = createServer((request, response) => {
    if (tailnet) {
        const asset = assets.get(request.url ?? "");
        if (!asset || (request.method !== "GET" && request.method !== "HEAD")) {
            response.writeHead(404).end();
            return;
        }
        response
            .writeHead(200, {
                "Content-Type": asset.type,
                "Content-Length": asset.bytes.length,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://${host}:${port}; base-uri 'none'; frame-ancestors 'none'`,
            })
            .end(request.method === "HEAD" ? undefined : asset.bytes);
        return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Flux development Wisp proxy\n");
});
server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/wisp/") {
        socket.destroy();
        return;
    }
    const browserOrigin = request.headers.origin;
    if (
        browserOrigin &&
        (tailnet
            ? browserOrigin !== origin
            : !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(browserOrigin))
    ) {
        socket.destroy();
        return;
    }
    wisp.routeRequest(request, socket, head);
});
server.listen(port, host, () => {
    if (tailnet) console.log(`Tailnet playground: ${origin}/`);
    console.log(`Development proxy: ws://${host}:${port}/wisp/`);
});
process.once("SIGINT", () => {
    server.close();
    process.exit(0);
});
