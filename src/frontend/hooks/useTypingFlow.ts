/**
 * useTypingFlow —— 阻塞式逐字打字状态机（ADR-0036，对齐 typewords-typing-demo 拍板）。
 *
 * 规则：
 * - 字母全归答案：输入序列与目标逐位比较（含大小写/标点/空格，大小写不敏感归一）；
 * - 错字阻塞：错键不前进、输入位标红闪示，wrongTimes 只增不减；
 * - 无 setTimeout：闪示态由下一次有效键入清除（纯状态推进）；
 * - 完成即回调 onDone（一次性，重入安全）。
 */

import { useCallback, useRef, useState } from "react";

export interface TypingFlowState {
  /** 已正确键入的位（含最后一次错键的闪示位由 wrongFlash 标注）。 */
  typedLength: number;
  /** 当前期望字符（已完成时为 null）。 */
  expectedChar: string | null;
  /** 最近一次错键的输入字符（null = 无闪示）。 */
  wrongFlash: string | null;
  /** 累计错键数（只增不减，跨切档重置由调用方显式 reset）。 */
  wrongTimes: number;
  /** 是否已完成全部目标字符。 */
  done: boolean;
}

export interface TypingFlowApi extends TypingFlowState {
  /** 处理一次键入（可打印单字符）。返回本次是否为有效推进（正确键入）。 */
  handleKey: (char: string) => boolean;
  /** 处理退格：阻塞式状态机下禁用（字母全归答案、错字阻塞，无需回删）。 */
  /** 重置状态机（换词 / 自选切档重置本档尝试时调用）。 */
  reset: () => void;
}

/** 大小写归一：字母统一小写比较，其余字符原样（演示页「字母全归答案」口径）。 */
function normalizeChar(ch: string): string {
  return ch.toLowerCase();
}

export function useTypingFlow(
  target: string,
  onDone?: (result: { wrongTimes: number }) => void,
): TypingFlowApi {
  const [typedLength, setTypedLength] = useState(0);
  const [wrongFlash, setWrongFlash] = useState<string | null>(null);
  const wrongTimesRef = useRef(0);
  const [wrongTimes, setWrongTimes] = useState(0);
  const doneRef = useRef(false);
  const typedLengthRef = useRef(0);
  typedLengthRef.current = typedLength;
  const targetRef = useRef(target);
  targetRef.current = target;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const done = typedLength >= targetRef.current.length && targetRef.current.length > 0;
  const expectedChar = done ? null : targetRef.current[typedLength] ?? null;

  const handleKey = useCallback((char: string): boolean => {
    if (char.length !== 1) return false;
    const expected = targetRef.current[typedLengthRef.current];
    if (expected === undefined) return false; // 已完成
    if (normalizeChar(char) === normalizeChar(expected)) {
      setWrongFlash(null);
      setTypedLength((v) => {
        const next = v + 1;
        if (next >= targetRef.current.length && !doneRef.current) {
          doneRef.current = true;
          onDoneRef.current?.({ wrongTimes: wrongTimesRef.current });
        }
        return next;
      });
      return true;
    }
    // 错字阻塞：不前进，wrongTimes 只增不减
    wrongTimesRef.current += 1;
    setWrongTimes(wrongTimesRef.current);
    setWrongFlash(char);
    return false;
  }, []);

  const reset = useCallback(() => {
    typedLengthRef.current = 0;
    wrongTimesRef.current = 0;
    doneRef.current = false;
    setTypedLength(0);
    setWrongTimes(0);
    setWrongFlash(null);
  }, []);

  return { typedLength, expectedChar, wrongFlash, wrongTimes, done, handleKey, reset };
}
