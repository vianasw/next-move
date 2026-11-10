import { defineConfig } from "spacefast/config";

export default defineConfig({
  "name": "Nextmove",
  "runtime": {
    "kind": "zero",
    "server": "server/index.ts",
    "client": "client/index.tsx"
  }
});
