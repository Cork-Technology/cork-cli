# What's Wrong with RFC-010 (and What We're Doing Instead)

Plain-English review of RFC-010 "Cork Protocol Model Context Protocol Server," written to
explain why we are replacing it rather than revising it. A revised RFC is being authored
separately from a clean requirements baseline.

## The short version

RFC-010 contains genuinely good security thinking wrapped in a design that would not work
for its primary audience — AI agents — and a scope that buries the product under
infrastructure. Its tool surface is roughly **40+ registered tools** when the same
functionality fits comfortably in about nine. It hardcodes facts nobody has verified,
requires heavyweight machinery (key ceremonies, multi-provider quorums, a separate Rust
signing service) before version 1 can ship, and omits six of our actual product
requirements entirely. It is also, frankly, very hard to read.

## What the RFC gets right

Credit first, because these survive into the replacement:

- **No custody.** The server never holds keys, signs, approves, or broadcasts. Correct
  and non-negotiable.
- **Don't trust what callers hand back.** Anything a caller stored and re-presents gets
  re-validated before the server returns executable bytes. This kills a whole class of
  tampering attacks.
- **Chain beats indexer.** When the database and the blockchain disagree, the RFC says
  report a conflict, never silently pick one. Exactly right.
- **Honest maturity labels.** Distinguishing "specified / implemented / activated /
  healthy" instead of pretending everything works is good discipline.
- **One shared "operation kernel."** Internally, the design recognizes that all
  operations follow one lifecycle. (Ironically, the tool surface then ignores this — see
  Issue 1.)

## Issue 1: Tool explosion — the design defeats its own insight

The RFC registers a separate tool for nearly every endpoint, action variant, and
lifecycle stage: seven query tools, eight limit-order tools, four tools (prepare /
finalize / simulate / reconcile) for *each* action variant, three token-authority tools,
four market-deployment tools, and so on. That's 40+ tools at launch, growing with every
new variant.

Why this matters: every registered tool's schema is loaded into an agent's context window
before any work happens, and agents demonstrably get *worse* at picking the right tool as
the count grows. Cork's own stated goal — "don't pollute the agent's context" — appears in
our product notes, and this design does the opposite. The deepest irony: the RFC's
internal architecture (one kernel, one envelope, per-capability "profiles") already
proves these are one polymorphic operation family. The design centralizes the semantics,
then fans the interface back out into dozens of near-identical tools.

What we're doing instead: about nine tools (query, compute, decode, family-scoped prepares, track,
capabilities/help, submit), with the variety expressed as strictly-typed variants
*inside* each tool's schema. Same rigor, ~85% fewer tools.

## Issue 2: Redundant and overlapping tools

Even within its own approach, the RFC duplicates itself:

- The signed-order **submit** tool is specified twice, in two different sections.
- There are **two separate "revoke allowance" tools** that both do the same thing: set a
  token approval to zero.
- **`market.verify`** duplicates verification that the RFC *also* requires every action
  preparation to perform internally anyway.
- **`authority.inspect`** (read balances/allowances/nonces) is just a read — it belongs
  with the other queries, not in its own tool family.
- The **prepare / simulate / reconcile** trio is stamped onto every capability
  separately, even though the RFC defines their behavior once in the kernel.

## Issue 3: Responses designed for auditors, not agents

Every read response must carry the complete raw upstream reply as **base64-encoded
bytes**, plus digests, plus a parsed version of the same data. So every market listing an
agent fetches arrives in duplicate — once as data, once as an encoded blob the agent
cannot read but must carry in its context window. That's a token tax on every single
call, paid to solve an auditing problem that only a small fraction of calls have.

Byte-level provenance is a fine *option* for the calls that need evidence. As the
*default envelope for everything*, it's directly hostile to the product's stated purpose.
The replacement makes compact responses the default and full evidence opt-in.

## Issue 4: Version numbers baked into tool names

Every tool is named `something.v1`. When v2 arrives, agents face `foo.v1` and `foo.v2`
side by side — doubling the surface and inviting wrong choices. Versioning belongs inside
the payload/envelope, where it can be negotiated, not in the name an agent has to pick.

## Issue 5: Heavy infrastructure as a launch requirement

Before version 1 can activate, the RFC requires: cryptographically signed deployment
manifests with an offline key ceremony and two-person signing; an append-only
transparency log; every state read confirmed by two independently-run providers agreeing
byte-for-byte; a separate signing-gate service written in Rust; conformance to **two**
versions of the MCP protocol simultaneously — one of which is an unreleased release
candidate; and a hosted gateway that proves credential revocation within 30 seconds
across all nodes.

Each of these defends against something real. None of them is what makes the product
useful, and together they put months of infrastructure between us and the first useful
tool call. Worse, the RFC states them as hard activation gates rather than as hardening
steps with triggers. The replacement keeps the *principles* (no custody, verification,
determinism) as invariants and moves the heavy mechanics to a "deferred hardening"
section that says what each one protects against and what event would justify building
it.

## Issue 6: Unverified claims stated as frozen fact

The RFC "bakes" decisions — 13 specific adapter functions in five families, a six/seven
split between buildable and unavailable variants, an exact execution path through
specific helper contracts, a share-rounding formula, specific commit hashes and version
pins — and marks them normative. Some of these are probably right. None of them are
cited to verified, on-chain observations, and at least one pin references an **unmerged
pull-request branch** as a dependency.

A spec that freezes unverified claims is worse than one that admits uncertainty, because
implementers build on the claims without re-checking. The replacement carries each of
these as an explicit "claim to verify empirically" — against deployed contracts on a
mainnet fork — before the new RFC may state it as fact.

## Issue 7: Six of our product requirements are simply missing

Comparing the RFC against our actual product goals, it never mentions:

1. **Enriched output** — labels and doc/wiki references attached to returned data so
   agents don't misread raw values (a core goal from day one).
2. **Time-dependent computed state** — current Dutch-auction order prices, rollover
   prices, and the rate-limited impairment floor (where the worst case is *not*
   `minRate`). This is some of the highest-value math in the product.
3. **The RFQ system** (hybrid local/remote pricing with per-market cached config).
4. **Tool search** — the keyword index so agents find the right capability without
   loading everything (made more urgent, not less, by the RFC's 40 tools).
5. **The three data modes** — centralized cached DB, public RPCs, and the embedded
   HyperSync indexer for decentralized operation. HyperSync appears nowhere.
6. **Address/config sourcing from our GitHub repos** with caching and verification,
   rather than hardcoding.

## Issue 8: It bans the escape hatch our own requirements ask for

The RFC flatly forbids any generic contract-call or raw-RPC capability. For a hosted,
multi-tenant gateway, that caution is defensible. But our original requirement was to
replace `cast` — a generic tool — for our own developers. The resolution is a
lane split the RFC never considers: the **local CLI** gets full generic capability
(including wrapping existing CLIs like `cast` and `gh` and enriching their output), while
the **MCP surface** stays closed and Cork-typed.

## Issue 9: Nobody can read it

The document spells out every acronym everywhere ("Hypertext Transfer Protocol,"
"JavaScript Object Notation"), repeats the same rules per capability instead of stating
them once, and buries decisions in 1,000+ lines of dense normative tables. Two symptoms
worth naming: the review process itself needed a "review_override" section to argue with
its own reviewers, and the open-questions list still includes *which humans own each
area* — an organizational blank spot presented alongside frozen technical detail. A spec
only works if the team actually reads it; this one reads like it was written to be
defensible rather than usable.

## Where this leaves us

We are keeping the RFC's security spine (no custody, untrusted re-presentation, closed
write schemas, chain-authoritative reconciliation, honest maturity) and discarding the
tool explosion, the default byte-envelopes, the launch-blocking infrastructure, and the
unverified baked decisions. The replacement RFC is being written from a clean,
deduplicated requirements baseline, with every carried technical claim verified against
deployed contracts on a fork before it may be stated as fact, and with the agent
experience — few tools, teachable schemas, compact responses, searchable help — treated
as a first-class requirement rather than an afterthought.
