# HyperSync napi client — Bun spike (2026-07-20)

Verdict: **blocked on THIS host, inconclusive for Bun itself.**

- `@envio-dev/hypersync-client` resolves its native binding per platform. This sandbox is
  **musl libc on aarch64**; Envio ships gnu + x64-musl + darwin builds, but no arm64-musl one.
- Direct `dlopen` of the gnu binding fails (`__register_atfork: symbol not found` — a glibc
  symbol absent under musl). **Node 24 fails identically**, so this is a host-libc gap, not a
  Bun napi limitation — Bun's napi layer was never reached.
- Consequence for the repo: the `full-decentralized` datasource treats the client as an
  optional, dynamically-imported dependency and returns an honest `unavailable`
  (`hypersync_unavailable`) when the module cannot load. Live verification of the client under
  Bun needs a glibc or macOS host plus the Envio token in the environment.

Run it yourself with the Envio token exported: `bun spike.ts` (loads the module, constructs a
client, and streams one factory event range on Arbitrum).
