# Capix Code runtime integration status

Last verified: 2026-07-11

## Wired and verified

- `src/plugin.ts` compiles against the published `@opencode-ai/plugin` and
  `@opencode-ai/sdk` packages. The former local ambient contract has been
  removed.
- The Capix model catalog is registered through OpenCode's real `provider`
  hook.
- Authentication uses S256 PKCE, preserves the verifier/challenge/redirect
  tuple, validates callback state at the broker boundary, and accepts callback
  delivery only from the native bridge or an explicitly submitted callback.
- Tool policy is evaluated before inherited tool capabilities are closed.
  Broker disconnect still causes future policy decisions to fail closed.
- Compile, lint and the complete test suite pass (74 passed, 21 deprecated
  legacy-router tests skipped at the last verification).

## Bundled inference handoff

The published OpenCode `ProviderHook` supports model discovery only. OpenCode
executes inference through its pinned AI SDK provider interface. Capix Code now
ships a private local package at `packages/runtime-provider`, linked as
`@capix/runtime-provider`, implementing the exact `@ai-sdk/provider` 3.0.8
`ProviderV2` / `LanguageModelV2` contract used by OpenCode 1.17.18.

The model metadata names that locally bundled package. Its `capix` factory maps
normal OpenCode calls to the strict broker-backed Capix SSE transport, including
the caller abort signal, text, tool-input deltas, usage, terminal route receipt,
and typed terminal errors. Contract tests dynamically import the package by the
same name OpenCode receives from `api.npm`.

Do not publish a customer Capix Code build until an installed runtime test
proves all of the following without mocking `fetch`:

1. Start the packaged launcher and authenticate through the callback bridge.
2. Select `capix/auto` from the discovered model catalog.
3. Submit a prompt through OpenCode's normal message path.
4. Observe incremental text and a streamed tool call before completion.
5. Cancel a request and verify the upstream request is aborted.
6. Display the final usage and route-receipt identifiers.
7. Verify a 401 refreshes once and a 402 is surfaced without retrying.
