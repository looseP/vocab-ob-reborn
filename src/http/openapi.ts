import { z, type ZodType } from "zod";
import { apiErrorResponseSchema, apiOperations, type ApiOperation } from "./operations";

type JsonObject = Record<string, unknown>;

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/$/, "") || "/";
}

function pathParameters(path: string): JsonObject[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
    in: "path",
    name: match[1],
    required: true,
    schema: { type: "string" },
  }));
}

function jsonSchema(schema: ZodType, io: "input" | "output"): JsonObject {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io });
}

function requestBody(operation: ApiOperation): JsonObject | undefined {
  if (!operation.request?.body) return undefined;
  return {
    required: true,
    content: {
      "application/json": {
        schema: jsonSchema(operation.request.body, "input"),
      },
    },
  };
}

function responseContent(schema: ZodType, mediaType: string): JsonObject {
  return { content: { [mediaType]: { schema: jsonSchema(schema, "output") } } };
}

function errorResponse(description: string): JsonObject {
  return { description, ...responseContent(apiErrorResponseSchema, "application/json") };
}

function operationResponses(operation: ApiOperation): JsonObject {
  const responses: JsonObject = {
    [operation.response.status]: operation.response.status === 204
      ? { description: "No Content" }
      : { description: "Success", ...responseContent(operation.response.schema, operation.response.mediaType) },
  };
  if (operation.path.startsWith("/api/")) {
    responses["400"] = errorResponse("Invalid request");
    responses["401"] = errorResponse("Authentication required");
    responses["403"] = errorResponse("Forbidden");
    responses["404"] = errorResponse("Not found");
    responses["409"] = errorResponse("Conflict");
    responses["413"] = errorResponse("Payload too large");
    responses["422"] = errorResponse("Business rule rejected");
    responses["500"] = errorResponse("Internal server error");
  }
  if (operation.path === "/api/auth/session" && operation.method === "post") {
    responses["415"] = errorResponse("Unsupported media type");
    responses["429"] = errorResponse("Rate limited");
  }
  if (operation.path.startsWith("/api/l2/")) {
    responses["503"] = errorResponse("Upstream or budget unavailable");
  }
  if (operation.path === "/readyz") {
    responses["503"] = { description: "Not ready", ...responseContent(operation.response.schema, "application/json") };
  }
  if (operation.path === "/metrics") {
    responses["401"] = { description: "Unauthorized", ...responseContent(z.string(), "text/plain") };
    responses["503"] = { description: "Metrics unavailable", ...responseContent(z.string(), "text/plain") };
  }
  return responses;
}

function queryParameters(operation: ApiOperation): JsonObject[] {
  if (!operation.request?.query) return [];
  const schema = jsonSchema(operation.request.query, "input") as {
    properties?: Record<string, JsonObject>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({
    in: "query",
    name,
    required: required.has(name),
    schema: value,
  }));
}

export function generateOpenApiDocument(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const operation of apiOperations) {
    const path = openApiPath(operation.path);
    const parameters = [...pathParameters(operation.path), ...queryParameters(operation)];
    const body = requestBody(operation);
    paths[path] ??= {};
    paths[path][operation.method] = {
      operationId: operation.operationId,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      responses: operationResponses(operation),
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Vocab Observatory API", version: "0.1.0" },
    paths,
  };
}

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
