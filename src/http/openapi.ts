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

function responseHeaders(operation: ApiOperation, status: number): JsonObject | undefined {
  const headers = operation.responseHeaders?.[status];
  if (!headers || headers.length === 0) return undefined;
  return Object.fromEntries(headers.map((header) => [header.name, {
    description: header.description,
    "x-required": true,
    schema: header.schema,
  }]));
}

function errorResponse(description: string, headers?: JsonObject): JsonObject {
  return { description, ...(headers ? { headers } : {}), ...responseContent(apiErrorResponseSchema, "application/json") };
}

function operationResponses(operation: ApiOperation): JsonObject {
  const responses: JsonObject = {
    [operation.response.status]: operation.response.status === 204
      ? { description: "No Content", ...(responseHeaders(operation, operation.response.status) ? { headers: responseHeaders(operation, operation.response.status) } : {}) }
      : {
        description: "Success",
        ...(responseHeaders(operation, operation.response.status) ? { headers: responseHeaders(operation, operation.response.status) } : {}),
        ...responseContent(operation.response.schema, operation.response.mediaType),
      },
  };
  if (operation.path.startsWith("/api/")) {
    responses["400"] = errorResponse("Invalid request");
    responses["401"] = operation.auth === "owner"
      ? errorResponse("Authentication required", {
        "WWW-Authenticate": {
          description: "Bearer authentication challenge.",
          "x-required": true,
          schema: { type: "string" },
        },
      })
      : errorResponse("Authentication required");
    responses["403"] = errorResponse("Forbidden");
    responses["404"] = errorResponse("Not found");
    responses["409"] = errorResponse("Conflict");
    responses["413"] = errorResponse("Payload too large");
    responses["422"] = errorResponse("Business rule rejected");
    responses["500"] = errorResponse("Internal server error");
  }
  if (operation.path === "/api/auth/session" && operation.method === "post") {
    responses["415"] = errorResponse("Unsupported media type");
    responses["429"] = errorResponse("Rate limited", responseHeaders(operation, 429));
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

function operationSecurity(operation: ApiOperation): JsonObject[] {
  if (operation.auth === "public") return [];
  if (operation.auth === "optionalSession") return [{}, { sessionCookie: [], csrfToken: [] }];
  if (operation.auth === "metrics") return [{ metricsBearerAuth: [] }];
  if (operation.csrf === "sessionMutation") {
    return [{ bearerAuth: [] }, { sessionCookie: [], csrfToken: [] }];
  }
  return [{ bearerAuth: [] }, { sessionCookie: [] }];
}

function requestHeaderParameters(operation: ApiOperation): JsonObject[] {
  return (operation.requestHeaders ?? []).map((header) => ({
    in: "header",
    name: header.name,
    required: header.required,
    description: header.description,
    schema: header.schema,
  }));
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
    const parameters = [...pathParameters(operation.path), ...queryParameters(operation), ...requestHeaderParameters(operation)];
    const body = requestBody(operation);
    paths[path] ??= {};
    paths[path][operation.method] = {
      operationId: operation.operationId,
      security: operationSecurity(operation),
      "x-auth-policy": operation.auth,
      "x-csrf-policy": operation.csrf,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      responses: operationResponses(operation),
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Vocab Observatory API", version: "0.1.0" },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
        metricsBearerAuth: { type: "http", scheme: "bearer" },
        sessionCookie: { type: "apiKey", in: "cookie", name: "vocab_session" },
      },
    },
    paths,
  };
}

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
