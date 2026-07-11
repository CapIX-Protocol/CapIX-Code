# Dependency security status

Last verified: 2026-07-11

`npm audit --omit=dev` reports zero production vulnerabilities.

The full development tree reports six advisories: three moderate, one high
and two critical. All are confined to the Vitest 2 / Vite development test
server chain (`vitest`, `@vitest/coverage-v8`, `@vitest/mocker`, `vite`,
`vite-node`, and `esbuild`). They are not dependencies of the shipped plugin,
credential broker, sandbox or `@capix/runtime-provider` package. CI uses
one-shot `vitest run`; it does not expose the Vitest UI or Vite development
server to a network.

The registry's only offered remediation is the semver-major Vitest 4.1.10
upgrade. It was not applied implicitly because this sprint requires
non-breaking fixes. Track that migration independently and revalidate the test
configuration and coverage thresholds. Production CI is fail-closed on
`npm audit --omit=dev --audit-level=high`.
