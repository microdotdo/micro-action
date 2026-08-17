# Micro Action

Deploy a [Micro](https://micro.do) from GitHub Actions without storing a Micro
API key. The Action asks GitHub for an audience-bound OIDC identity, installs a
checksum-pinned `micro` CLI release, and runs the same build and deployment path
used locally.

Authorize the exact repository policy once from a trusted workstation:

```sh
micro github link \
  --repository owner/repository \
  --environment production \
  --ref refs/heads/main \
  --slug my-site
git add micro.github.json
git commit -m "Authorize Micro deployment"
```

Then add a workflow:

```yaml
name: Deploy Micro

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: AndreBaltazar8/micro-action@v1 # Pin a full commit SHA in production.
        with:
          path: .
          environment: production
```

The committed `micro.github.json` contains only the public binding ID and exact
policy facts; it contains no credential. The server verifies GitHub's signature, issuer, Micro-specific audience,
expiration, replay ID, immutable repository and owner IDs, exact ref,
environment, and pinned workflow before issuing a five-minute token that can
activate one deployment. The binding does not create a project or reserve a
slug; the first successful deployment does both atomically.

`pull_request` and `pull_request_target` identities cannot deploy. Product
price or currency changes also fail closed unless
`accept-price-changes: "true"` is explicitly set.

## Development

```sh
npm run build
npm run check
npm test
git diff --exit-code -- dist/index.js
```

See [SECURITY.md](SECURITY.md) for the trust boundary and reporting process.
