declare module "@mercuryworkshop/wisp-js/server" {
    import type { IncomingMessage } from "node:http";
    import type { Duplex } from "node:stream";
    export const server: {
        routeRequest(request: IncomingMessage, socket: Duplex, head: Buffer): void;
        options: {
            allow_private_ips: boolean;
            allow_loopback_ips: boolean;
            hostname_whitelist: RegExp[];
            dns_method: "lookup" | "resolve" | ((hostname: string) => Promise<string>);
            wisp_version: number;
            send_buffer_size: number;
            allow_direct_ip: boolean;
            allow_udp_streams: boolean;
            port_whitelist: number[];
            stream_limit_total: number;
        };
    };
    export const logging: { set_level(level: number): void; NONE: number };
}
