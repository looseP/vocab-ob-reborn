import type { RuntimeMetricsSnapshot } from "@/services/runtime-status.service";
import type { operations } from "./generated/openapi";

export type GeneratedOperationMetricsResponse =
  operations["getOperationMetrics"]["responses"][200]["content"]["application/json"];

type Extends<Actual, Expected> = [Actual] extends [Expected] ? true : false;
type Assert<T extends true> = T;

type _GeneratedToRuntime = Assert<
  Extends<GeneratedOperationMetricsResponse, RuntimeMetricsSnapshot>
>;
type _RuntimeToGenerated = Assert<
  Extends<RuntimeMetricsSnapshot, GeneratedOperationMetricsResponse>
>;
