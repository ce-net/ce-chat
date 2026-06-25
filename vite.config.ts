import { defineConfig } from "vite";

// ce-chat: a Vite + TS single-page app that talks ONLY to its local CE node over
// the same-origin mesh rail (@ce-net/sdk `connectNode` -> `window.__ceNode` bridge or
// the same-origin `/ce` reverse proxy). In dev, Vite stands in for the `ce-app serve`
// layer and proxies `/ce/*` to the local node at 127.0.0.1:8844 so the browser stays
// same-origin (strict CSP `connect-src 'self'`) and can stream SSE / POST without CORS.
export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      "/ce": {
        target: "http://127.0.0.1:8844",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ce/, ""),
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
