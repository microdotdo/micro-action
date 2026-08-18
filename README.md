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
      - uses: microdotdo/micro-action@v1 # Pin a full commit SHA in production.
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
`accept-price-changes: "true"` is explicitly set. Beginning real Stripe charges
is a separate decision and requires `accept-live-products: "true"`.

Action 1.2 installs the checksum-pinned Micro CLI 0.8.0. Its step summary
separately reports the local build, accepted bundle upload, activated deployment,
and retried live-route HTTP verification. A reachable private route may report
HTTP 401 and a site whose root intentionally does not exist may report 404;
both prove that the activated project route is serving without exposing a
credential. Network failures and HTTP 5xx responses fail the Action after five
bounded attempts.

## Development

```sh
npm run build
npm run check
npm test
git diff --exit-code -- dist/index.js
```

See [SECURITY.md](SECURITY.md) for the trust boundary and reporting process.
