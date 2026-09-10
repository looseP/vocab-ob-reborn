import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  BusinessRuleError,
  DbConnectionError,
  errorToResponse,
  isDbConnectionError,
  isConstraintViolation,
} from "@/errors";

describe("Error hierarchy", () => {
  it("NotFoundError maps to 404", () => {
    const err = new NotFoundError("Word", "aboard");
    expect(err.httpStatus).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("Word not found");
    expect(err.resourceType).toBe("Word");
    expect(err.identifier).toBe("aboard");
  });

  it("ValidationError maps to 422", () => {
    const err = new ValidationError("Invalid rating", "rating");
    expect(err.httpStatus).toBe(422);
    expect(err.field).toBe("rating");
  });

  it("ConflictError maps to 409", () => {
    const err = new ConflictError("Duplicate key");
    expect(err.httpStatus).toBe(409);
  });

  it("UnauthorizedError maps to 401", () => {
    expect(new UnauthorizedError("Unauthorized").httpStatus).toBe(401);
  });

  it("ForbiddenError maps to 403", () => {
    expect(new ForbiddenError("Forbidden").httpStatus).toBe(403);
  });

  it("BusinessRuleError maps to 422", () => {
    const err = new BusinessRuleError("Cannot answer suspended card");
    expect(err.httpStatus).toBe(422);
    expect(err.code).toBe("BUSINESS_RULE");
  });

  it("DbConnectionError maps to 503", () => {
    expect(new DbConnectionError("DB unavailable").httpStatus).toBe(503);
  });

  it("all errors extend AppError", () => {
    expect(new NotFoundError("X", "1")).toBeInstanceOf(AppError);
    expect(new ValidationError("x")).toBeInstanceOf(AppError);
    expect(new ConflictError("x")).toBeInstanceOf(AppError);
    expect(new BusinessRuleError("x")).toBeInstanceOf(AppError);
  });

  it("errors carry cause and meta", () => {
    const cause = new Error("root cause");
    const err = new ValidationError("msg", "field", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("errorToResponse", () => {
  it("maps AppError to correct status + body", () => {
    const { status, body } = errorToResponse(new NotFoundError("Word", "x"));
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toContain("Word not found");
  });

  it("maps unknown error to 500 without leaking internals", () => {
    const { status, body } = errorToResponse(new Error("secret SQL error"));
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL");
  });

  it("maps DB connection error to 503", () => {
    const dbErr = Object.assign(new Error("connection terminated"), { code: "57P03" });
    const { status, body } = errorToResponse(dbErr);
    expect(status).toBe(503);
    expect(body.code).toBe("DB_UNAVAILABLE");
  });
});

describe("isConstraintViolation", () => {
  it("returns true for every mapped SQLSTATE", () => {
    expect(isConstraintViolation({ code: "23503" })).toBe(true);
    expect(isConstraintViolation({ code: "23505" })).toBe(true);
    expect(isConstraintViolation({ code: "23502" })).toBe(true);
    expect(isConstraintViolation({ code: "23514" })).toBe(true);
    expect(isConstraintViolation({ code: "22P02" })).toBe(true);
  });

  it("returns false for non-constraint errors", () => {
    expect(isConstraintViolation({ code: "42501" })).toBe(false); // RLS — deliberately unmapped
    expect(isConstraintViolation({ code: "08006" })).toBe(false); // connection, not constraint
    expect(isConstraintViolation({ code: "" })).toBe(false);
    expect(isConstraintViolation({})).toBe(false);
    expect(isConstraintViolation({ code: 23505 })).toBe(false); // non-string code
    expect(isConstraintViolation(null)).toBe(false);
    expect(isConstraintViolation("23505")).toBe(false);
    expect(isConstraintViolation(undefined)).toBe(false);
  });

  it("does not resolve Object.prototype keys as SQLSTATEs", () => {
    // A plain MAP lookup would resolve inherited Object.prototype members
    // ("constructor", "toString", ...) and produce a malformed response;
    // the own-property guard must fall through to the 500 branch instead.
    expect(isConstraintViolation({ code: "toString" })).toBe(false);
    expect(isConstraintViolation({ code: "constructor" })).toBe(false);
    expect(isConstraintViolation({ code: "__proto__" })).toBe(false);
  });
});

describe("errorToResponse — SQLSTATE constraint mapping", () => {
  it.each([
    ["23503", 422, "FOREIGN_KEY_VIOLATION", "Referenced resource does not exist."],
    ["23505", 409, "CONFLICT", "Resource already exists."],
    ["23502", 400, "NOT_NULL_VIOLATION", "Required field is missing."],
    ["23514", 400, "CHECK_VIOLATION", "Value is not allowed."],
    ["22P02", 400, "INVALID_INPUT", "Invalid input format."],
  ])("maps %s to %i %s", (sqlstate, status, code, error) => {
    const pgError = Object.assign(new Error("db internals: detail / table / column"), {
      code: sqlstate,
      detail: "secret detail",
      constraint: "secret_constraint_name",
    });
    const res = errorToResponse(pgError);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error, code });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("keeps connection-state SQLSTATEs on the 503 branch, never as client errors", () => {
    // Order guard: isDbConnectionError must win over constraint mapping.
    const res = errorToResponse(Object.assign(new Error("connection terminated"), { code: "08003" }));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("DB_UNAVAILABLE");
  });

  it("falls through to 500 for unmapped SQLSTATEs and Object.prototype key names", () => {
    const unmapped = errorToResponse(Object.assign(new Error("rls denied"), { code: "42501" }));
    expect(unmapped.status).toBe(500);
    expect(unmapped.body.code).toBe("INTERNAL");
    expect(unmapped.body.error).toBe("Internal server error");

    const inherited = errorToResponse({ code: "toString" });
    expect(inherited.status).toBe(500);
    expect(inherited.body.code).toBe("INTERNAL");
  });
});

describe("isDbConnectionError", () => {
  it("detects SQLSTATE connection codes", () => {
    expect(isDbConnectionError({ code: "08006" })).toBe(true);
    expect(isDbConnectionError({ code: "57P03" })).toBe(true);
  });

  it("detects errno connection codes", () => {
    expect(isDbConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isDbConnectionError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("detects connection messages", () => {
    expect(isDbConnectionError({ message: "Connection terminated" })).toBe(true);
    expect(isDbConnectionError({ message: "connection refused" })).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isDbConnectionError({ code: "23505" })).toBe(false); // unique violation
    expect(isDbConnectionError({ message: "syntax error" })).toBe(false);
    expect(isDbConnectionError(null)).toBe(false);
    expect(isDbConnectionError("string")).toBe(false);
  });
});
