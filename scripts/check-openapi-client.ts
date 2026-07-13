import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const committed = resolve("src/frontend/api/generated/openapi.ts");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "vocab-openapi-client-"));
const generated = join(temporaryDirectory, "openapi.ts");
const cli = resolve("node_modules/tsx/dist/cli.mjs");
const generator = resolve("scripts/generate-openapi-client.ts");

try {
  const result = spawnSync(process.execPath, [cli, generator, generated], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const normalize = (value: string) => value.replace(/\r\n/g, "\n");
  if (normalize(readFileSync(generated, "utf8")) !== normalize(readFileSync(committed, "utf8"))) {
    console.error("Generated OpenAPI client types are stale. Run npm run api:client:generate.");
    process.exit(1);
  }
  console.log("OpenAPI client types match docs/api/openapi.json.");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
