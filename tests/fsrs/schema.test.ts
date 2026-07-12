import { describe, it, expect } from "vitest";
import {
  parseSchedulerPayload,
  SchedulerPayloadParseError,
} from "@/fsrs/schema";
import type { StoredSchedulerCard } from "@/fsrs/types";

const SAMPLE: StoredSchedulerCard = {
  difficulty: 5.2,
  due: "2026-01-14T12:00:00.000Z",
  elapsed_days: 1,
  lapses: 0,
  learning_steps: 0,
  last_review: "2026-01-13T12:00:00Z",
  reps: 3,
  scheduled_days: 2,
  stability: 4.8,
  state: 2,
};

describe("parseSchedulerPayload", () => {
  it("accepts a fully-populated valid card (identity)", () => {
    expect(parseSchedulerPayload(SAMPLE)).toEqual(SAMPLE);
  });

  it("treats empty object as a fresh card (DB default)", () => {
    const card = parseSchedulerPayload({});
    expect(card.state).toBe(0);
    expect(card.difficulty).toBe(0);
    expect(card.stability).toBe(0);
    expect(card.reps).toBe(0);
    expect(card.due).toBe(new Date(0).toISOString());
    expect(card.last_review).toBeNull();
  });

  it("treats null / undefined as a fresh card (no progress yet)", () => {
    expect(parseSchedulerPayload(null).state).toBe(0);
    expect(parseSchedulerPayload(undefined).state).toBe(0);
  });

  it("keeps present fields and fills the rest with defaults (version tolerance)", () => {
    const card = parseSchedulerPayload({ due: "2026-05-01T00:00:00Z", state: 1 });
    expect(card.due).toBe("2026-05-01T00:00:00Z");
    expect(card.state).toBe(1);
    expect(card.difficulty).toBe(0);
    expect(card.last_review).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(() => parseSchedulerPayload("nope")).toThrow(SchedulerPayloadParseError);
    expect(() => parseSchedulerPayload(42)).toThrow(SchedulerPayloadParseError);
    expect(() => parseSchedulerPayload([1, 2, 3])).toThrow(SchedulerPayloadParseError);
  });

  it("rejects wrong-typed fields (corruption)", () => {
    expect(() => parseSchedulerPayload({ difficulty: "bad" })).toThrow(SchedulerPayloadParseError);
    expect(() => parseSchedulerPayload({ due: 123 })).toThrow(SchedulerPayloadParseError);
    expect(() => parseSchedulerPayload({ state: "learning" })).toThrow(SchedulerPayloadParseError);
    expect(() => parseSchedulerPayload({ elapsed_days: -1 })).toThrow(SchedulerPayloadParseError);
  });

  it("rejects out-of-range state", () => {
    expect(() => parseSchedulerPayload({ state: 9 })).toThrow(SchedulerPayloadParseError);
    expect(() => parseSchedulerPayload({ state: -1 })).toThrow(SchedulerPayloadParseError);
  });

  it("rejects non-ISO, impossible, and timezone-less dates", () => {
    for (const due of ["not-a-date", "01/02/2026", "2026-13-99", "2026-02-30T00:00:00Z", "2026-05-01T00:00:00"]) {
      expect(() => parseSchedulerPayload({ due })).toThrow(SchedulerPayloadParseError);
    }
  });

  it("accepts strict ISO datetimes with UTC or an explicit offset", () => {
    expect(parseSchedulerPayload({ due: "2026-05-01T00:00:00Z" }).due).toBe("2026-05-01T00:00:00Z");
    expect(parseSchedulerPayload({ due: "2026-05-01T08:00:00+08:00" }).due).toBe("2026-05-01T08:00:00+08:00");
  });
});
