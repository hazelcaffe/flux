import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "test/browser",
    fullyParallel: false,
    workers: 1,
    use: { baseURL: "http://127.0.0.1:5173", headless: true },
    webServer: {
        command: "pnpm dev --port 5173 --strictPort",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: false,
    },
});
