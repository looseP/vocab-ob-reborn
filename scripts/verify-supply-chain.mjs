import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

if (lockfile.lockfileVersion < 3) {
  throw new Error(`package-lock.json must use lockfileVersion 3 or newer; found ${lockfile.lockfileVersion}`);
}

const rootPackage = lockfile.packages?.[''];
if (!rootPackage) {
  throw new Error('package-lock.json is missing its root package entry');
}

for (const field of ['dependencies', 'devDependencies']) {
  const manifestEntries = packageJson[field] ?? {};
  const lockEntries = rootPackage[field] ?? {};
  for (const [name, version] of Object.entries(manifestEntries)) {
    if (lockEntries[name] !== version) {
      throw new Error(`package-lock.json is out of sync for ${field}.${name}`);
    }
  }
}

if (packageJson.scripts?.['security:audit'] !== 'npm audit --omit=dev --audit-level=high') {
  throw new Error('security:audit must gate high and critical production dependency vulnerabilities');
}

console.log('Supply-chain manifest and lockfile checks passed.');
