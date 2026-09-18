/**
 * 作文正文 hash 工具（W3，ADR《writing-workspace》§3/§5）。
 *
 * domain 不引 node:crypto（零出向），hash 放 service 层。正文真源纪律：
 * 存储的 text 与 hash 必须基于「同一归一字符串」——调用方先 normalizeWritingText
 * （CRLF/CR → LF，不 trim、不 Unicode normalize），再 sha256WritingText。
 *
 * 反馈锚点 / hash 一致性见 S§5：text_sha256 = SHA256(UTF-8(NORMALIZE_LF(原样正文)))。
 */
import { createHash } from "node:crypto";

/**
 * 计算归一后正文的 SHA-256（小写 hex）。
 * 输入必须是**已归一**文本（与存储 answers/attempt.text 同串），否则 hash 与存储不一致。
 */
export function sha256WritingText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
