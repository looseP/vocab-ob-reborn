import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = resolve(projectRoot, process.env.OPENAPI_SCHEMA_PATH ?? "docs/api/openapi.json");
const EXPECTED_JSON_VALUE_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: { $ref: "#/components/schemas/JsonValue" } },
    { type: "object", additionalProperties: { $ref: "#/components/schemas/JsonValue" } },
  ],
};
const outputArgument = process.argv.find((argument, index) => index > 1 && argument !== "--");
const outputPath = resolve(projectRoot, outputArgument ?? "src/frontend/api/generated/openapi.ts");

const document = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  components?: { schemas?: { JsonValue?: unknown } };
};
if (JSON.stringify(document.components?.schemas?.JsonValue) !== JSON.stringify(EXPECTED_JSON_VALUE_SCHEMA)) {
  throw new Error("OpenAPI JsonValue component no longer matches the supported recursive JSON schema.");
}
const ast = await openapiTS(pathToFileURL(schemaPath));

const raw = astToString(ast);
const componentsMarker = "export interface components {\n    schemas: {\n        JsonValue:";
const jsonValuePattern = /JsonValue: string \| number \| boolean \| null \| components\["schemas"\]\["JsonValue"\]\[\] \| \{\n            \[key: string\]: components\["schemas"\]\["JsonValue"\];\n        \};/;
if (!raw.includes(componentsMarker) || !jsonValuePattern.test(raw)) {
  throw new Error("Generated OpenAPI types do not contain the expected recursive JsonValue shape.");
}
const generated = raw.replace(
  componentsMarker,
  "export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };\nexport interface components {\n    schemas: {\n        JsonValue:",
).replace(jsonValuePattern, "JsonValue: JsonValue;");
if (!generated.includes("export type JsonValue =") || !generated.includes("JsonValue: JsonValue;")) {
  throw new Error("Failed to normalize the recursive JsonValue client type.");
}

writeFileSync(outputPath, generated, "utf8");
console.log(`Wrote ${outputPath}`);
