# Numeric-core property harness (fast-check)

Differential + invariant properties over `packages/core/src/math/*` bigint ports.
Reference model = Solidity 0.8.30 checked arithmetic + OZ `Math.mulDiv` (reverts on d==0 and
uint256 overflow). Companion Solidity ground-truth: `experiments/fork-harness/test/RevertDomainParity.t.sol`.

Run (needs fast-check; not a repo dependency — install in an isolated dir):
    BUN=$(mise which bun)
    mkdir -p /tmp/proptest && cd /tmp/proptest && "$BUN" add -d fast-check
    cp <repo>/experiments/proptest/core.proptest.ts core.test.ts
    "$BUN" test core.test.ts

History: this harness originally DOCUMENTED the revert-domain divergences (third-pass footgun
investigation, 2026-07-24): mulDiv overflow gap, ceilDiv negative overshoot, computeT>WAD on
current<start, fee>=100% negative-denominator silent garbage, impairmentFloor div-by-zero at
worstRate=0. After the hardening pass (fix/footgun-hardening-2026-07-24) the ports enforce the
Solidity revert domain, so the harness now asserts FULL revert-parity — a failure here means a
guard regressed. Still faithful-to-contract (not guarded): the calculateRate unclamped
no-change early-return (P7b — in-band lastAdjustedRate is a documented precondition).
