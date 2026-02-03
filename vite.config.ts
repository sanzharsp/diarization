import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/diarization": {
        target: "http://127.0.0.1:7800",
        changeOrigin: true
      }
    }
  }
});
