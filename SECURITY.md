# Security

Report vulnerabilities privately through GitHub Security Advisories for this
repository. Do not open a public issue with deployment tokens, OIDC tokens,
repository identifiers that are not already public, or account details.

The Action never accepts a Micro API origin or permanent credential. Its OIDC
token is requested only for `https://micro.do/actions`, masked immediately,
held in the child-process environment, and sent only to `https://micro.do` by
the checksum-pinned CLI. Server-side binding policy remains authoritative; the
Action's local claim decoding exists only to produce an early configuration
error.

An Abla server build uses a source-pinned compiler inside a commit-pinned Nix
installer and toolchain. Compilation finishes before the Action requests the
GitHub OIDC token, so project build code never receives deployment authority.
Static-only projects skip the compiler toolchain entirely.
