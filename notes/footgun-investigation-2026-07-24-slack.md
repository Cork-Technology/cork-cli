# 🔍 Numeric footgun audit of cork-helper-cli — results

*TL;DR: We deep-audited every place cork-helper-cli handles numbers, amounts, timestamps, and
scales — twice. The core math is solid (exact, integer-based, verified against the chain
wei-for-wei). But we confirmed ~22 issues at the "translation boundaries" where a number changes
format. A handful are serious enough to fix before wider adoption. We are NOT claiming this is the
complete list — see the honesty note at the end. Full technical report:
`notes/footgun-investigation-2026-07-24.md`.*

---

## Why we looked

The tool constantly translates numbers between four "dialects": blockchain fixed-point (where the
digits `1e18` mean 1.0 for a rate but 1% for a fee), plain text strings on the wire, the venue's
JSON (a premium is `4.1` on the order book but `"0.041"` in an RFQ quote), and human/agent intent
("expire in an hour", "2.5 tokens"). Every issue we found lives where one of those crossings
happens **silently** (nothing checks it), **inconsistently** (two neighboring fields use different
formats for the same thing), or **lossily** (precision quietly drops).

This matters because our main users are AI agents, and industry data says up to 45% of agent
errors on financial tools are exactly this — right idea, wrong scale or format.

Everything below was verified, either by running the actual code or by reading our source
side-by-side with the smart contracts. We ran two passes: the first covered the core; a follow-up
covered the rest of the codebase and roughly doubled the count.

---

## The big ones 🔴

**1. A millisecond timestamp creates an (effectively) immortal market — 7/10.**
JavaScript's `Date.now()` gives milliseconds; the chain wants seconds. Paste one into a market's
expiry and the date lands ~55,000 years out. Nothing stops it — our tool doesn't validate the
field, and the contract only checks "is it in the future," with no upper limit. Since principal
can only be fully redeemed *after* expiry, a filled order like this locks funds in a market that
never really expires. Ironically we built two alarms for the percent-vs-fraction premium mistake
and zero for milliseconds-vs-seconds.

**2. An oversized order expiry silently wraps into the past — 6.5/10.**
Order settings get packed into fixed-width slots. The expiry slot is small, and we write into it
with a mask that silently chops anything too big. We ran it: a large-but-legal expiry came out as
**July 2025 — already expired**, and the tool still returned "ok" with a signable, forever-
unfillable order.

**3. When funding a "buy up to X" action, we move the full X, not what's actually spent — 6.5/10.**
For actions with a slippage cap (like "mint shares, spend at most 100 collateral"), we transfer
the *whole cap* into the adapter. If the action only needs 80, the extra 20 is left behind, and we
build no leg to send it back. Our read of the adapter says leftovers aren't refunded and can be
swept by anyone next block — so a user who sets a loose cap silently donates the slack. (The
"we-move-the-cap" part is confirmed in our code; the "not refunded / skimmable" part is read from
the contract source and should be confirmed on a fork before we act.)

**4. Rollover orders are relayed without ever checking the signature — 6.5/10.**
When someone submits a signed rollover order, we compute its fingerprint but never verify that the
signature actually belongs to the person named on the order. We also skip the settler and deadline
checks that our own *preparation* step performs. So a garbage-signed or mismatched order relays
cleanly and then can't be filled. (This is a worse cousin of #5 below, where at least the hash is
checked.)

**5. Order-book listings aren't checked against the signed order — 6/10.**
A submitted order carries display fields (expiry, partial-fills, nonce) that duplicate what's
already sealed inside the signature. We verify the order's hash carefully but relay these
duplicates unchecked — so the book can advertise "live till Friday, partial fills OK" about an
order whose signature says otherwise. Takers then waste gas on fills that revert.

**6. Our "read everything" mode silently returns partial data as if it were complete — 6/10.**
The full-decentralized (HyperSync) reads only fetch one page and throw away the "there's more,
resume here" marker — so callers can't even tell the data was cut off. The mainnet fills scan from
block zero over the 1inch protocol is almost guaranteed to truncate, and because it isn't scoped
to Cork it also returns *other people's* 1inch fills mixed in. Counts get presented as complete
evidence when they aren't. (Our venue reads handle this correctly — this path just doesn't.)

---

## Worth fixing soon 🟡

**7. A brief network blip can silently roll our contract addresses backwards — 5.5/10.**
Our address list is fetched fresh and cached. We confirmed that if the cache is a bit stale and a
refresh fails for even 10 minutes, we *overwrite the good cached copy* with a failure marker and
fall back to whatever shipped in the installed bundle — which can silently un-learn a redeployed
address (the adapter address is explicitly volatile). Unsigned transactions would then target a
stale address. Serving the slightly-stale-but-real cache would be safer than falling back to the
bundle.

**8. Partial-fill orders die after their first fill — 5/10.**
`allowsPartialFills: true` sounds like "fill me piece by piece," but a hidden hard-coded setting
means: one fill of any size, then the rest is dead. Post 100, get 1 filled, lose 99 — silently,
undocumented. Real 1inch behavior, but we never surfaced it.

**9. The premium scale alarms have gaps — 5/10.**
Good idea, four confirmed holes: a negative or astronomically huge premium passes with no warning
at all; a premium *exactly* 100× the cited quote slips past the blocker (floating-point rounds the
ratio to 99.99999999999999); a legal fraction just under the 0.5 cap is falsely rejected; and if
the cited quote has no readable premium, the check just skips. Lesson: don't guard exact-integer
promises with approximate floating-point math.

**10. The decode tool hides everything if any one piece is malformed — 4.5/10.**
If a bundle contains one garbled leg, the whole decode throws and every *other* leg is hidden —
which is exactly what the file's own header warns against. It should show the good legs and mark
the bad one "unknown."

**11. Same tool, three different time formats, uneven checking — 4.5/10 (a cluster).**
Timestamps show up as text-seconds, number-seconds, and relative-seconds across one tool, and the
validation is lopsided: rollover deadlines are checked strictly, but RFQ-open accepts a window that
ends before it starts and even negative timestamps; pre-funded deposits skip the "does this pool
exist / is it expired" check that funded deposits get; `deadlineAt` accepts times in the past
without a peep; the reconcile check only looks at page 1 of the order book, so it can wrongly report
"order not found." Inconsistency between siblings is exactly what trains agents into unit mistakes.

**12. "Do you have a Permit2 allowance?" reports the wrong allowance — 4/10.**
The account-state read shows the token's approval *to* Permit2, but the funding step actually needs
a *different* Permit2-internal allowance (with an expiry) that we never check. A user seeing a big
number reasonably concludes the bundle will fund — and it can still revert.

**13. Price responses mix three unit systems with no labels — 4/10.**
One compute response returns the rate, share amounts, reference amounts, and the fee — each in a
different decimal system, none labeled. On 18-decimal pools it all coincidentally lines up, then
breaks by a factor of a trillion on the first 6-decimal asset. (Another endpoint already labels its
units — we should make that the house rule.)

---

## Minor but real 🟢

- **MCP error signalling can mislead integrators (3.5/10):** routine "not found" results are flagged
  as hard errors, while serious integrity conflicts are flagged as success, unless the client reads
  the `state` field. Error responses also stamp the wrong chain ID (always "1").
- **Hand-set RPC URLs aren't chain-checked (3.5/10):** point one at the wrong chain and every read
  is wrong-chain data wearing the right label. The automatic paths do verify; the manual one doesn't.
- **CLI `--json` loses precision on numeric fields (3/10):** big integers in genuinely-numeric
  fields get rounded by JSON parsing before validation even sees them (the string amount fields are
  safe). Verified.
- **Our "bit-exact" math keeps computing where the contract would refuse (3.5/10):** fed an
  impossible timestamp it produced a 5.5% fee from a 5% max, instead of erroring. Unreachable today,
  but the math ships as a library others import.
- **A rate described as an amount (3/10):** `minPremiumPerShare` is really "per-share," but the
  description calls it a plain amount — misleading for 6-decimal tokens.
- **Smaller stuff:** unknown on-chain status codes get relabeled "None" (can fabricate or mask a
  conflict); registry lists silently cut off at 500/100 items with no warning; a network 5xx reads
  as a permanent rejection instead of "retry"; teaching's "here's a correct example" always shows
  the tool's *first* example even when a different variant failed; the CLI silently ignores extra
  arguments; a large piped response may get truncated on exit; and our "tampered config is rejected"
  claim only checks the *shape* of the address file, not its authenticity.

---

## What came back clean ✅

Most of the codebase, genuinely. All core pricing/fee/impairment math is exact integer arithmetic
with rounding matched to the contracts and pinned by wei-for-wei fork tests. Big numbers leave as
strings through one central choke point. Venue data is treated as untrusted and re-verified for
hashes and signatures. Token decimals are always read live, never assumed. The EIP-712 typehashes,
market-id encoding, and CREATE2 derivation all check out. And the band-resolution math re-checks
itself against the chain on *every call* — that self-check is the gold-standard pattern the fixes
above should copy. Our 437 offline tests all pass.

---

## The one structural lesson

Every protection that exists today was built one-field-at-a-time — premiums got tripwires, band
math got a self-check, amounts got teaching text. That's why every *new* field starts life
unprotected, and the gaps above are exactly the fields nobody got around to. The highest-leverage
fix isn't any single patch — it's moving protections into the **shared types** (the timestamp type
learns to smell milliseconds and absurd dates; anything that duplicates signed data is derived or
cross-checked; range-check before packing into bit-slots; scale alarms use exact integer math;
every money response labels its units) plus **a CI test that fails the build** when a new field
carries money/time/rate meaning without using the protected types. That turns this whole audit into
an enforced rule instead of a memory.

---

## How complete is this? (honest note)

We are **not** claiming this is the full list. The first pass deep-read ~60% of the code and found
12 issues; a second pass covered the rest and found ~10 more — so the count roughly doubled the
moment we looked harder. Reassuringly, every new finding fit an existing category (no new *kind* of
problem appeared), which suggests the map of failure types is solid. But three gaps remain before
anyone should say "exhaustive": (1) the funds-impact part of #3 is read from the contract source,
not yet fork-tested; (2) this whole audit was offline/static — the live-chain and live-venue paths
self-skip without network; and (3) we did no fuzzing. For the scale-and-rounding core specifically,
a property-based test harness against a chain fork is the only thing that earns the word
"exhaustive" — recommended as the durable follow-up, and something we can build next.

---

## Suggested next steps

1. Fix #1, #2, #3, #4 now (small changes, real downside protection — #3/#4 touch funds).
2. Batch the 🟡 items into a "boundary hardening" PR — most are a few lines each plus tests.
3. Add the schema-lint CI test so the whole class stays dead.
4. Build the property-based fork test harness for the numeric core to close the completeness gap.

Questions and pushback welcome — especially on #8 (partial fills), which is a product decision, not
just a bug. Full details, evidence log, and per-finding remediation live in
`notes/footgun-investigation-2026-07-24.md`.
