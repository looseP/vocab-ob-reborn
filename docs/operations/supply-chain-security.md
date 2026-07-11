# Supply-chain security

CI uses a read-only GitHub token and disables persisted checkout credentials. `npm ci` verifies that `package-lock.json` is usable and synchronized with `package.json`; `npm run security:verify` also checks the lockfile structure and fails on high or critical vulnerabilities in production dependencies.

## Local verification

```sh
npm ci
npm run security:verify
npm run sbom:npm
```

`npm run sbom:npm` writes `sbom-npm.cdx.json` in CycloneDX JSON 1.6 format. CI uploads it as `sbom-npm-cyclonedx`.

After building `vocab-observatory-v2:ci`, generate the container SBOM with the same pinned local scanner used by CI:

```sh
docker run --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "${PWD}:/out" \
  anchore/syft@sha256:e86b0ba0b1d2fe8a2e9f96ed9b22033df9781f43b9a7eb27c57e6c89234946bc \
  docker:vocab-observatory-v2:ci \
  --output cyclonedx-json=/out/sbom-container.cdx.json
```

CI uploads the result as `sbom-container-cyclonedx`. The scanner runs locally against the Docker daemon; it does not send the image to an external scanning service.

Audit failures must be investigated and remediated by updating affected dependencies. Do not add `continue-on-error`, suppress advisories, or lower the audit level to bypass the gate.
