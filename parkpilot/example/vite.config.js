import { defineConfig } from "vite";
import { handleApi } from "./server/api.mjs";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 43123,
    strictPort: true,
  },
  plugins: [
    {
      name: "parkpilot-api",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/api/")) return next();
          handleApi(req, res);
        });
      },
    },
  ],
});
