/**
 * Shared ADR-0026 contract for container log rotation.
 *
 * stdout/stderr stay the single source of truth (the application never
 * dual-writes to a file); Docker's `json-file` driver rotates and caps
 * retention. Every service in a deployable compose file must therefore pin
 * that driver with bounded `max-size`/`max-file` so a chatty container cannot
 * fill the host disk.
 *
 * The three compose verifiers call this so the requirement is enforced by
 * `npm run runtime:verify`, `npm run single-host:verify` and
 * `npm run cloudflare-tunnel:verify` instead of living in prose.
 */

export interface ComposeServiceBlock {
  name: string;
  body: string;
}

export const LOG_ROTATION_ANCHOR = "default-logging";
const REQUIRED_DRIVER = "json-file";
const REQUIRED_MAX_SIZE = "10m";
const REQUIRED_MAX_FILE = "5";

/**
 * Split the top-level `services:` block into 2-space-indented service blocks.
 *
 * A service header is the only line at two-space indentation ending in `:`;
 * everything deeper belongs to the preceding service. The section ends at the
 * next column-zero key (`volumes:`, `networks:`, ...) or end of file.
 */
export function parseComposeServices(compose: string): ComposeServiceBlock[] {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^[^\s#]/.test(line));
  const section = lines.slice(start + 1, end < 0 ? lines.length : end);
  const blocks: ComposeServiceBlock[] = [];
  let current: ComposeServiceBlock | undefined;
  for (const line of section) {
    const header = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (header) {
      current = { name: header[1], body: "" };
      blocks.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return blocks;
}

/**
 * Assert the compose file declares the rotation anchor and that every required
 * service references it. Pass `services` for overlay files that carry partial
 * service overrides (the overridden service inherits rotation from its base
 * layer and must not be required to repeat it).
 */
export function verifyComposeLogRotation(compose: string, label: string, services?: string[]): void {
  const requirePattern = (source: string, pattern: RegExp, what: string): void => {
    if (!pattern.test(source)) throw new Error(`${label} ${what} is missing or malformed`);
  };

  requirePattern(
    compose,
    new RegExp(`^x-logging: &${LOG_ROTATION_ANCHOR}$`, "m"),
    "log rotation anchor",
  );
  const anchorBlock = compose.match(
    new RegExp(`^x-logging: &${LOG_ROTATION_ANCHOR}\\r?\\n([\\s\\S]*?)(?=^[^\\s#])`, "m"),
  )?.[1];
  if (!anchorBlock) throw new Error(`${label} log rotation anchor is malformed`);
  requirePattern(anchorBlock, new RegExp(`^ {2}driver: ${REQUIRED_DRIVER}$`, "m"), "json-file driver");
  requirePattern(anchorBlock, new RegExp(`^ {4}max-size: "${REQUIRED_MAX_SIZE}"$`, "m"), "max-size rotation");
  requirePattern(anchorBlock, new RegExp(`^ {4}max-file: "${REQUIRED_MAX_FILE}"$`, "m"), "max-file rotation");

  const blocks = parseComposeServices(compose);
  if (blocks.length === 0) throw new Error(`${label} declares no services`);
  const required = services ?? blocks.map((block) => block.name);
  for (const name of required) {
    const block = blocks.find((candidate) => candidate.name === name);
    if (!block) throw new Error(`${label} service ${name} is missing or malformed`);
    requirePattern(block.body, new RegExp(`^ {4}logging: \\*${LOG_ROTATION_ANCHOR}$`, "m"), `service ${name} log rotation`);
  }
}
