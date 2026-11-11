import { defineConfig } from "spacefast/config";

export default defineConfig({
  "name": "Next move",
  "runtime": {
    "kind": "zero",
    "server": "server/index.ts",
    "client": "client/index.tsx"
  }
});
