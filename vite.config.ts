import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
    build: {
        target: "esnext",
        sourcemap: true,
        license: { fileName: "THIRD_PARTY_LICENSES.md" },
        lib: {
            entry: {
                index: resolve(import.meta.dirname, "src/index.ts"),
                transport: resolve(import.meta.dirname, "src/transport.ts"),
                "pure-js": resolve(import.meta.dirname, "src/pure-js.ts"),
            },
            formats: ["es"],
            fileName: (_format, name) => `${name}.js`,
        },
    },
});
