import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeOpenApiDocument } from "../src/http/openapi";

const output = path.resolve(process.argv[2] ?? "docs/api/openapi.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, serializeOpenApiDocument(), "utf8");
console.log(`Wrote ${path.relative(process.cwd(), output)}`);
