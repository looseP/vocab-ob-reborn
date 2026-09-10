// tests/repositories/l3-cursor.test.ts
import { describe, it, expect } from "vitest";
import { decodeCursor, encodeCursor, UUID_RE } from "@/repositories/l3-cursor";

const ID = "11111111-1111-4111-8111-111111111111";

describe("l3 cursor codec", () => {
  it("round-trips a valid cursor", () => {
    expect(decodeCursor(encodeCursor("2026-01-01T00:00:00.000Z", ID))).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: ID,
    });
  });

  it("treats an absent cursor as the start of the page", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("throws for a payload that is not decodable JSON", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(/Invalid pagination cursor/);
  });

  it("throws when the payload parses but has the wrong shape", () => {
    // Reaches the post-try guard rather than the catch: JSON is valid, the
    // field types are not.
    const wrongShape = Buffer.from(JSON.stringify({ createdAt: 1, id: "nope" }), "utf8").toString("base64url");
    expect(() => decodeCursor(wrongShape)).toThrow(/Invalid pagination cursor/);
  });

  it("rejects a well-formed payload whose id is not a uuid", () => {
    const badId = Buffer.from(JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", id: "abc" }), "utf8").toString("base64url");
    expect(() => decodeCursor(badId)).toThrow(/Invalid pagination cursor/);
  });

  it("rejects a well-formed payload whose createdAt is unparseable", () => {
    const badDate = Buffer.from(JSON.stringify({ createdAt: "not-a-date", id: ID }), "utf8").toString("base64url");
    expect(() => decodeCursor(badDate)).toThrow(/Invalid pagination cursor/);
  });

  it("accepts only canonical uuid shapes", () => {
    expect(UUID_RE.test(ID)).toBe(true);
    expect(UUID_RE.test("11111111-1111-9111-8111-111111111111")).toBe(false);
  });
});
