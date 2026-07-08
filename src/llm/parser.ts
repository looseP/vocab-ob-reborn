/**
 * LLM 响应 JSON 容错解析。
 *
 * LLM 经常不严格遵守"只输出 JSON"的指令——可能包裹在 markdown code block 里，
 * 或前后有解释性文字。这个解析器尝试多种策略提取 JSON。
 */

export interface ParseResult<T = unknown> {
  success: boolean;
  data: T | null;
  raw: string;
}

export function parseLlmJson<T = unknown>(raw: string): ParseResult<T> {
  const trimmed = raw.trim();

  // 策略 1：直接解析
  try {
    return { success: true, data: JSON.parse(trimmed) as T, raw };
  } catch {
    // continue
  }

  // 策略 2：从 markdown code block 提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return { success: true, data: JSON.parse(codeBlockMatch[1].trim()) as T, raw };
    } catch {
      // continue
    }
  }

  // 策略 3：提取第一个 JSON 数组
  const jsonArrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try {
      return { success: true, data: JSON.parse(jsonArrayMatch[0]) as T, raw };
    } catch {
      // continue
    }
  }

  // 策略 4：提取第一个 JSON 对象
  const jsonObjMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonObjMatch) {
    try {
      return { success: true, data: JSON.parse(jsonObjMatch[0]) as T, raw };
    } catch {
      // continue
    }
  }

  return { success: false, data: null, raw };
}
