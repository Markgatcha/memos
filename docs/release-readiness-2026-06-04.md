# Release Readiness Evidence - 2026-06-04

Status: local release gates passed.

## Validation

- `npm run typecheck` - passed.
- `npm test -- --runInBand` - passed, 119 tests.
- `npm run build` - passed.
- `npm run lint` - passed.
- `python -m compileall server adapters` - passed.
- `npm audit --audit-level moderate` - passed, 0 vulnerabilities.

## Release Notes

- REST bridge update support, request-id demuxing, and stderr draining are in place.
- Bridge script generation no longer writes into source or installed package directories.
- TTL, transactional link rollback, and metadata filter behavior have regression coverage.
- Fedora, Arch, and openSUSE native dependency smoke jobs are defined in CI but still need GitHub-hosted execution evidence.

## Deferred

- Package dry-run/wheel-install smoke in a fresh virtual environment.
- Published benchmark result snapshots beyond the existing `npm run bench` harness.
- Desktop service supervision contract implementation.
