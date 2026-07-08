# I4: GitHub 推送被三重阻塞

## 问题现象

`git push` 到 GitHub 失败，连续遇到三个独立问题。

## 问题 1: github.com:443 不可达

**现象**: `Failed to connect to github.com port 443`

**根因**: 网络环境对 `github.com` 有阻断。但 `api.github.com` 可达（curl 测试 200 OK）。git push 走 `github.com`（不是 API），所以被阻断。

## 问题 2: PAT 权限不足

**现象**: `403 Permission to looseP/vocab-ob-reborn.git denied`

**根因**: 第一个 PAT 是 fine-grained token，创建时没勾选 `Contents: Write` 权限。API 响应头 `x-accepted-github-permissions: allows_permissionless_access=true` 确认是只读。用户换成 classic token（`ghp_` 前缀，默认有 `repo` 完整权限）后权限问题解决。

## 问题 3: Windows 命令行长度限制

**现象**: `ENAMETOOLONG: spawnSync cmd.exe`

**根因**: 用 GitHub Git Database API 推送时，`package-lock.json` 等大文件的 base64 内容作为 `-d` 参数传给 curl，超出 Windows 命令行 32767 字符限制。

## 解决方案

用 GitHub Git Database API 绕过 `github.com:443`（只走 `api.github.com`），并用临时文件传 request body 绕过命令行长度限制：

```javascript
// 1. 先用 Contents API 创建一个初始文件（初始化空仓库）
curl -X PUT .../contents/README.md -d '{"message":"init","content":"..."}'

// 2. 用 Git Database API 逐文件创建 blob → tree → commit → ref
//    body 写入临时文件，curl 用 -d @tmpfile 读取
const tmpFile = join(tmpdir(), `gh-body-${Date.now()}.json`);
writeFileSync(tmpFile, JSON.stringify(body));
headerArgs.push("-d", "@" + tmpFile);
```

## 推送流程

```
git rev-list --reverse main  → 获取所有提交 SHA
对每个提交:
  1. git ls-tree -r --name-only <sha>  → 获取文件列表
  2. 对每个文件: git show <sha>:<file> | base64 → POST /git/blobs
  3. POST /git/trees (所有 blob SHA)
  4. POST /git/commits (tree SHA + parent SHA)
最后: PATCH /git/refs/heads/main (更新分支指向)
```

## 验证方式

- GitHub 仓库页面显示 2 个提交 + 全部文件
- `curl -s https://api.github.com/repos/looseP/vocab-ob-reborn/commits` 返回提交列表

## 后续推送

如果 `github.com` 网络问题解决，可以直接 `git push`。否则继续用 `node scripts/push-via-api.mjs <token>`。

## 关联文件

- `scripts/push-via-api.mjs` (推送脚本)
