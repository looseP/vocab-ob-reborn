import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const projectRoot = resolve(import.meta.dirname, "../..");
const cli = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
const generator = resolve(projectRoot, "scripts/generate-openapi-client.ts");

function temporaryFile(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "vocab-openapi-client-test-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generate-openapi-client", () => {
  it("emits a recursive JsonValue alias without an illegal self-referencing interface member", () => {
    const output = temporaryFile("openapi.ts");
    const result = spawnSync(process.execPath, [cli, generator, output], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const generated = readFileSync(output, "utf8");
    expect(generated).toContain("export type JsonValue = string | number | boolean | null | JsonValue[]");
    expect(generated).toContain("JsonValue: JsonValue;");
    expect(generated).not.toContain("JsonValue: string | number | boolean | null | components");
  });

  it("fails closed when the OpenAPI JsonValue component shape drifts", () => {
    const original = readFileSync(resolve(projectRoot, "docs/api/openapi.json"), "utf8");
    const document = JSON.parse(original) as { components: { schemas: { JsonValue: unknown } } };
    document.components.schemas.JsonValue = { type: "object" };
    const schemaPath = temporaryFile("openapi.json");
    writeFileSync(schemaPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    const output = temporaryFile("openapi.ts");

    const result = spawnSync(process.execPath, [cli, generator, output], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, OPENAPI_SCHEMA_PATH: schemaPath },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("JsonValue component no longer matches");
  });
});
