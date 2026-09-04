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

describe("errorToResponse — DB constraint / invalid-input violations", () => {
  const cases = [
    { sqlstate: "23503", status: 422, code: "FOREIGN_KEY_VIOLATION" },
    { sqlstate: "23505", status: 409, code: "CONFLICT" },
    { sqlstate: "23502", status: 400, code: "NOT_NULL_VIOLATION" },
    { sqlstate: "23514", status: 400, code: "CHECK_VIOLATION" },
    { sqlstate: "22P02", status: 400, code: "INVALID_INPUT" },
  ];

  for (const { sqlstate, status, code } of cases) {
    it(`maps SQLSTATE ${sqlstate} to ${status} ${code}`, () => {
      const { status: actualStatus, body } = errorToResponse({ code: sqlstate });
      expect(actualStatus).toBe(status);
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });
  }

  it("does not reuse the DB-connection branch for 23505", () => {
    const { status, body } = errorToResponse({ code: "23505" });
    expect(status).toBe(409);
    expect(status).not.toBe(503);
    expect(body.code).toBe("CONFLICT");
    expect(body.code).not.toBe("DB_UNAVAILABLE");
  });

  it("still maps connection SQLSTATEs to 503 before the constraint branch", () => {
    const { status, body } = errorToResponse({ code: "08006" });
    expect(status).toBe(503);
    expect(body.code).toBe("DB_UNAVAILABLE");
  });

  it("keeps 42501 (insufficient_privilege / RLS) on the 500 path", () => {
    const { status, body } = errorToResponse({ code: "42501" });
    expect(status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    expect(body.error).toBe("Internal server error");
    expect(isConstraintViolation({ code: "42501" })).toBe(false);
  });

  it("keeps unknown SQLSTATEs on the 500 path", () => {
    const { status, body } = errorToResponse({ code: "99999" });
    expect(status).toBe(500);
    expect(body.code).toBe("INTERNAL");
  });

  it("keeps inherited Object.prototype keys on the 500 path", () => {
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(errorToResponse({ code: key })).toEqual({
        status: 500,
        body: { error: "Internal server error", code: "INTERNAL" },
      });
    }
  });

  it("does not affect AppError subclasses", () => {
    const { status, body } = errorToResponse(new ValidationError("Invalid rating", "rating"));
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toBe("Invalid rating");
    expect(body.details).toEqual({ field: "rating" });
  });

  it("never leaks database internals into the response body", () => {
    const pgError = {
      code: "23503",
      detail: 'Key (word_id)=(3d2f9a1c) is not present in table "words".',
      constraint: "wordbook_items_word_id_fkey",
      table: "wordbook_items",
      column: "word_id",
      message: 'insert or update on table "wordbook_items" violates foreign key constraint',
      schema: "public",
    };
    const { body } = errorToResponse(pgError);

    expect(body.code).toBe("FOREIGN_KEY_VIOLATION");
    expect(body.error).toBe("Referenced resource does not exist.");
    expect(body.details).toBeUndefined();

    const serialized = JSON.stringify(body);
    for (const leak of [
      pgError.detail,
      pgError.constraint,
      pgError.message,
      pgError.table,
      pgError.column,
      pgError.schema,
    ]) {
      expect(serialized).not.toContain(leak);
    }
    // Spot-check the sensitive fragments too, so the assertion cannot pass
    // only because of a serialization quirk.
    expect(serialized).not.toContain("wordbook_items_word_id_fkey");
    expect(serialized).not.toContain("words");
    expect(serialized).not.toContain("word_id");
  });
});

describe("isConstraintViolation", () => {
  it("detects known constraint SQLSTATEs", () => {
    expect(isConstraintViolation({ code: "23503" })).toBe(true);
    expect(isConstraintViolation({ code: "23505" })).toBe(true);
    expect(isConstraintViolation({ code: "23502" })).toBe(true);
    expect(isConstraintViolation({ code: "23514" })).toBe(true);
    expect(isConstraintViolation({ code: "22P02" })).toBe(true);
  });

  it("returns false for everything else", () => {
    expect(isConstraintViolation({ code: "42501" })).toBe(false);
    expect(isConstraintViolation({ code: "08006" })).toBe(false);
    expect(isConstraintViolation({ code: "99999" })).toBe(false);
    expect(isConstraintViolation({})).toBe(false);
    expect(isConstraintViolation({ code: "" })).toBe(false);
    expect(isConstraintViolation({ code: 23503 })).toBe(false);
    expect(isConstraintViolation(null)).toBe(false);
    expect(isConstraintViolation(undefined)).toBe(false);
    expect(isConstraintViolation("23503")).toBe(false);
    expect(isConstraintViolation(new ValidationError("x"))).toBe(false);
  });
});
