import { defineConfig } from "vite";

export default defineConfig({
    build: {
        target: "esnext",
        outDir: "demo-dist",
        sourcemap: true,
        license: { fileName: "THIRD_PARTY_LICENSES.md" },
        rollupOptions: {
            output: {
                manualChunks: (id) => {
                    if (id.includes("root-cas.js")) return "ca-roots";
                    if (id.includes("node_modules")) return "crypto";
                },
            },
        },
    },
});
