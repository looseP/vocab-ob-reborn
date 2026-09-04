/**
 * Push commits to GitHub via Git Database API.
 * Uses temp files for request bodies to avoid Windows ENAMETOOLONG.
 */
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TOKEN = process.argv[2];
const REPO = "looseP/vocab-ob-reborn";
const API = `https://api.github.com/repos/${REPO}/git`;

function curl(method, url, body) {
  const headerArgs = [
    "-s", "-X", method,
    "-H", "Authorization: Bearer " + TOKEN,
    "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
  ];

  let tmpFile = null;
  if (body) {
    tmpFile = join(tmpdir(), `gh-body-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tmpFile, JSON.stringify(body));
    headerArgs.push("-d", "@" + tmpFile);
  }
  headerArgs.push(url);

  try {
    const result = execSync(`curl ${headerArgs.map(a => `"${a}"`).join(" ")}`, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 60000,
    });
    return JSON.parse(result.toString());
  } finally {
    if (tmpFile) {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
}

function getCommitInfo(sha) {
  const raw = execSync(`git cat-file -p ${sha}`).toString();
  const lines = raw.split("\n");
  const tree = lines.find(l => l.startsWith("tree "))?.slice(5).trim();
  const parents = lines.filter(l => l.startsWith("parent ")).map(l => l.slice(7).trim());
  const authorLine = lines.find(l => l.startsWith("author "));
  const messageStart = lines.indexOf("") + 1;
  const message = lines.slice(messageStart).join("\n").trim();

  let author = { name: "looseP", email: "20564@users.noreply.github.com", date: new Date().toISOString() };
  if (authorLine) {
    const m = authorLine.match(/^author (.+) <(.+)> (\d+) ([+-]\d{4})$/);
    if (m) author = { name: m[1], email: m[2], date: new Date(parseInt(m[3]) * 1000).toISOString() };
  }
  return { tree, parents, message, author };
}

const commits = execSync("git rev-list --reverse main").toString().trim().split("\n");
console.log(`[push] ${commits.length} commits to push`);

let remoteHead = null;
try {
  const ref = curl("GET", `${API}/refs/heads/main`);
  if (ref.object) {
    remoteHead = ref.object.sha;
    console.log(`[push] Remote main at: ${remoteHead.slice(0, 7)}`);
  }
} catch {
  console.log("[push] Remote main does not exist yet");
}

let parentSha = remoteHead;
for (const commitSha of commits) {
  const info = getCommitInfo(commitSha);
  console.log(`[push] ${commitSha.slice(0, 7)}: ${info.message.split("\n")[0]}`);

  const files = execSync(`git ls-tree -r --name-only ${commitSha}`).toString().trim().split("\n").filter(Boolean);
  console.log(`[push]   ${files.length} files`);

  const treeItems = [];
  for (const file of files) {
    const content = execSync(`git show ${commitSha}:${file}`).toString("base64");
    const blob = curl("POST", `${API}/blobs`, { content, encoding: "base64" });
    if (blob.sha) {
      treeItems.push({ path: file, mode: "100644", type: "blob", sha: blob.sha });
    } else {
      console.error(`[push]   ERROR creating blob for ${file}:`, blob.message);
      process.exit(1);
    }
  }

  const tree = curl("POST", `${API}/trees`, { tree: treeItems });
  if (!tree.sha) {
    console.error(`[push]   ERROR creating tree:`, tree.message);
    process.exit(1);
  }

  const commit = curl("POST", `${API}/commits`, {
    message: info.message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
    author: info.author,
  });
  if (!commit.sha) {
    console.error(`[push]   ERROR creating commit:`, commit.message);
    process.exit(1);
  }
  parentSha = commit.sha;
  console.log(`[push]   -> ${commit.sha.slice(0, 7)}`);
}

if (remoteHead) {
  const r = curl("PATCH", `${API}/refs/heads/main`, { sha: parentSha, force: true });
  console.log(`[push] Updated main -> ${r.object?.sha?.slice(0, 7)}`);
} else {
  const r = curl("POST", `${API}/refs`, { sha: parentSha, ref: "refs/heads/main" });
  console.log(`[push] Created main -> ${r.object?.sha?.slice(0, 7)}`);
}

console.log("[push] Done! All commits pushed via GitHub API.");
