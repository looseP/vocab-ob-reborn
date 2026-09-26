/**
 * 重新锚定 openapi breaking approval（ADR-0035 §勘误 口径）。
 *
 * baseSha256    = sha256(openapi@origin/main)
 * currentSha256 = sha256(docs/api/openapi.json @工作树)
 * issues        = 相对 base 的**实测** breaking 集合
 *
 * 为什么要这个脚本：response 联合新增变体是本仓已裁决的 breaking（脚本 line 124
 * 明确判为 breaking 而非 unknown）。它必须被**显式记录**在 approval 里，不能被
 * 悄悄吞掉，也不能靠人手抄 location/message —— 抄错一条 approval 就会整体失效。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { compareOpenApiDocuments } from "../scripts/verify-openapi-breaking";

const root = process.cwd();
const BASE = process.env.API_CONTRACT_BASE_REF ?? "origin/main";
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function gitShow(ref: string, file: string): string {
  return execFileSync("git", ["show", `${ref}:${file}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const currentText = readFileSync(path.join(root, "docs/api/openapi.json"), "utf8");
const baseText = gitShow(BASE, "docs/api/openapi.json");

const issues = compareOpenApiDocuments(JSON.parse(baseText), JSON.parse(currentText));
if (issues.some((entry) => entry.kind === "unknown")) {
  throw new Error("存在 unknown change：unknown 不可通过 approval 豁免，先人工判定");
}

const approvalPath = path.join(root, "docs/api/openapi-breaking-approval.json");
const approval = {
  version: 1,
  baseSha256: sha(baseText),
  currentSha256: sha(currentText),
  issues,
};
writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");

console.log(`[reanchor] base=${BASE} issues=${issues.length}`);
for (const entry of issues) console.log(`  ${entry.kind.toUpperCase()} ${entry.location}`);
