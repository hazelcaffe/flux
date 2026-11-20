import {
    BasicConstraintsExtension,
    X509Certificate as Certificate,
    ExtendedKeyUsageExtension,
    SubjectAlternativeNameExtension,
} from "@peculiar/x509";
import {
    loadX509FromPem,
    makeTLSClient,
    setCryptoImplementation,
    type TLSConnectionOptions,
    type X509Certificate,
} from "@reclaimprotocol/tls";
import { pureJsCrypto } from "@reclaimprotocol/tls/purejs-crypto";
import {
    asError,
    ByteQueue,
    type ByteSocket,
    concat,
    deferred,
    queueStream,
    randomBytes,
} from "./bytes.js";

export interface TLSOptions {
    /** Verification is on by default. Never disable this in production. */
    verifyServerCertificate?: boolean;
    /** PEM roots added to Reclaim's bundled Mozilla trust store. */
    ca?: string[];
    supportedProtocolVersions?: TLSConnectionOptions["supportedProtocolVersions"];
    cipherSuites?: TLSConnectionOptions["cipherSuites"];
    handshakeTimeoutMs?: number;
    maxBufferedBytes?: number;
    /** AIA is disabled by default, avoiding unproxied requests and recursive TLS handshakes. */
    fetchCertificateBytes?: (url: string) => Promise<Uint8Array>;
}

// Reclaim's pure-JS backend has an insecure fallback RNG. Never use that fallback.
// Its crypto provider is process-global, so all clients deliberately use the same backend.
export function configureCrypto(): void {
    randomBytes(1); // fail closed on platforms without a CSPRNG
    setCryptoImplementation({ ...pureJsCrypto, randomBytes });
}

export function matchesDNSName(host: string, pattern: string): boolean {
    const normalized = host.toLowerCase().replace(/\.$/u, "");
    const name = pattern.toLowerCase().replace(/\.$/u, "");
    if (!name.includes("*")) return normalized === name;
    if (!name.startsWith("*.") || name.indexOf("*", 1) !== -1) return false;
    const suffix = name.slice(2);
    const labels = normalized.split(".");
    // Never let a wildcard match a TLD, multiple labels or an IDN A-label.
    return (
        suffix.includes(".") &&
        labels.length === name.split(".").length &&
        !labels[0]?.startsWith("xn--") &&
        normalized.endsWith(`.${suffix}`)
    );
}

function checkCertificates(host: string, certificates: X509Certificate[]): void {
    const chain = certificates.map((cert) => new Certificate(cert.serialiseToPem()));
    const leaf = chain[0];
    if (!leaf) throw new Error("Server supplied an empty certificate chain");
    const san = leaf.getExtension(SubjectAlternativeNameExtension);
    const names =
        san?.names.items.filter((entry) => entry.type === "dns").map((entry) => entry.value) ?? [];
    const ip = host.includes(":") || /^\d+(\.\d+){3}$/u.test(host);
    // Reclaim currently checks DNS/CN only. Fail closed for IP literals rather than
    // accidentally accept a CN that merely looks like an IP address.
    if (ip) throw new Error("Verified TLS to IP literals is not supported; use a DNS hostname");
    const candidates = san ? names : leaf.subjectName.getField("CN");
    if (!candidates.some((name) => matchesDNSName(host, name))) {
        throw new Error(`Certificate hostname mismatch for ${host}`);
    }
    const eku = leaf.getExtension(ExtendedKeyUsageExtension);
    if (eku && !eku.usages.includes("1.3.6.1.5.5.7.3.1") && !eku.usages.includes("2.5.29.37.0")) {
        throw new Error("Certificate is not valid for TLS server authentication");
    }
    for (let i = 1; i < chain.length; i++) {
        const constraints = chain[i]?.getExtension(BasicConstraintsExtension);
        if (!constraints?.ca) throw new Error("Issuer certificate is not a CA");
        if (constraints.pathLength !== undefined && i - 1 > constraints.pathLength) {
            throw new Error("Certificate chain exceeds CA path-length constraint");
        }
    }
}

const quietLogger = {
    info() {},
    debug() {},
    trace() {},
    warn() {},
    error() {},
};

/** TLS record processing is entirely JS; the supplied socket only carries ciphertext. */
export class TLSSocket implements ByteSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly closed: Promise<void>;
    private readonly done = deferred<void>();
    private readonly handshake = deferred<void>();
    private readonly queue: ByteQueue;
    private readonly engine: ReturnType<typeof makeTLSClient>;
    private ended = false;
    private writes: Promise<void> = Promise.resolve();

    private constructor(
        private readonly socket: ByteSocket,
        host: string,
        options: TLSOptions,
    ) {
        configureCrypto();
        this.closed = this.done.promise;
        this.queue = new ByteQueue(options.maxBufferedBytes);
        this.readable = queueStream(this.queue, () => this.close());
        this.engine = makeTLSClient({
            host: host.toLowerCase().replace(/\.$/u, ""),
            verifyServerCertificate: options.verifyServerCertificate ?? true,
            ...(options.ca ? { rootCAs: options.ca.map(loadX509FromPem) } : {}),
            ...(options.supportedProtocolVersions
                ? { supportedProtocolVersions: options.supportedProtocolVersions }
                : {}),
            cipherSuites: options.cipherSuites ?? [
                "TLS_AES_128_GCM_SHA256",
                "TLS_AES_256_GCM_SHA384",
                "TLS_CHACHA20_POLY1305_SHA256",
                "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
                "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
                "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
                "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
                "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
                "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
            ],
            namedCurves: ["SECP256R1", "SECP384R1", "X25519"],
            signatureAlgorithms: [
                "RSA_PSS_RSAE_SHA256",
                "ECDSA_SECP256R1_SHA256",
                "ECDSA_SECP384R1_SHA384",
                "RSA_PKCS1_SHA256",
                "RSA_PKCS1_SHA384",
                "RSA_PKCS1_SHA512",
            ],
            applicationLayerProtocols: ["http/1.1"],
            logger: quietLogger,
            fetchCertificateBytes:
                options.fetchCertificateBytes ??
                (async () => {
                    throw new Error(
                        "Server omitted an intermediate certificate; provide fetchCertificateBytes to enable AIA",
                    );
                }),
            write: ({ header, content }) => socket.write(concat(header, content)),
            onHandshake: () => this.handshake.resolve(),
            onRecvCertificates: ({ certificates }) => {
                if (options.verifyServerCertificate !== false)
                    checkCertificates(host, certificates);
            },
            onApplicationData: (data) => {
                try {
                    this.queue.push(data.slice());
                } catch (error) {
                    this.close(asError(error));
                }
            },
            onTlsEnd: (error) => this.close(error),
        });
    }

    static async connect(
        socket: ByteSocket,
        host: string,
        options: TLSOptions = {},
    ): Promise<TLSSocket> {
        let tls: TLSSocket;
        try {
            tls = new TLSSocket(socket, host, options);
        } catch (error) {
            socket.close(asError(error));
            throw error;
        }
        const timer = setTimeout(
            () => tls.close(new Error("TLS handshake timed out")),
            options.handshakeTimeoutMs ?? 15_000,
        );
        void tls.receive();
        try {
            await tls.engine.startHandshake();
            await tls.handshake.promise;
            return tls;
        } catch (error) {
            tls.close(asError(error));
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    private async receive(): Promise<void> {
        const reader = this.socket.readable.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                await this.engine.handleReceivedBytes(value);
            }
            // Without close_notify a close-delimited HTTPS body could be truncated.
            if (!this.ended) this.close(new Error("TLS connection ended without close_notify"));
        } catch (error) {
            this.close(asError(error));
        } finally {
            reader.releaseLock();
        }
    }

    get metadata(): ReturnType<ReturnType<typeof makeTLSClient>["getMetadata"]> {
        return this.engine.getMetadata();
    }

    write(data: Uint8Array): Promise<void> {
        const copy = data.slice();
        const operation = this.writes.then(async () => {
            if (this.ended) throw new Error("TLS socket is closed");
            await this.handshake.promise;
            await this.engine.write(copy);
        });
        this.writes = operation.catch(() => {});
        return operation;
    }

    updateTrafficKeys(): Promise<void> {
        const operation = this.writes.then(() => this.engine.updateTrafficKeys());
        this.writes = operation.catch(() => {});
        return operation;
    }

    close(error?: Error): void {
        if (this.ended) return;
        this.ended = true;
        this.handshake.reject(error ?? new Error("TLS socket closed before handshake completed"));
        this.queue.end(error);
        this.socket.close(error);
        void this.engine.end(error).catch(() => {});
        if (error) this.done.reject(error);
        else this.done.resolve();
    }
}
