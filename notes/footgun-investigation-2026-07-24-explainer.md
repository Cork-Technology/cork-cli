# Where our numbers can bite: a plain-English tour of the footgun investigation

*Companion to `footgun-investigation-2026-07-24.md` (the technical report). This version is for
the whole team — no Solidity or TypeScript knowledge required — and is structured so it can be
turned into an explainer video: each section is a "scene" with a suggested visual.*

*Covers both audit passes: Scenes 3–11 are the first-pass findings; Scenes 11a–11d add the
highest-impact findings from the deeper second pass. We are not claiming the list is complete —
see the closing honesty note (Scene 13a).*

---

## Scene 1 — What this tool actually does (30 seconds of context)

cork-helper-cli is the toolbox that AI agents (and people, via a command line) use to interact
with Cork's Phoenix protocol: read market state, compute exact prices, build unsigned
transactions and orders, and relay signed orders to our venue.

Its core promise is **"our numbers are exactly the chain's numbers."** The math is ported from
the smart contracts digit-for-digit and tested against the live chain down to the last wei.
That promise holds — the math itself is in great shape.

The problem we went hunting for is different: **the places where a number changes costume.**

**Suggested visual:** a package moving down a conveyor belt through four differently-shaped doors.

---

## Scene 2 — The four "dialects" of numbers (the big idea)

The whole investigation boils down to one idea: this system speaks **four different number
dialects**, and every bug we found lives at a border crossing between two of them.

1. **Blockchain fixed-point.** The chain has no decimal point, so "1.0" is written as a giant
   integer: 1 followed by 18 zeros. Worse, there are *two* conventions side by side: for rates,
   `1e18` means **1.0**; for fees, `1e18` means **1 percent**. Same-looking number, 100× apart.
2. **Wire strings.** Big numbers travel between programs as text (`"2500000000000000000"`)
   because ordinary JavaScript numbers can't hold them precisely.
3. **Venue JSON.** Our own venue API expresses a premium two ways: on the order book it's a
   percent number (`4.1` means 4.1%), but in RFQ quotes it's a fraction string (`"0.041"` also
   means 4.1%). Both are correct — in their own dialect.
4. **Human/agent intent.** "Expire in an hour", "2.5 tokens", "next Friday" — relative times and
   human-sized amounts that must be translated into the dialects above.

A footgun happens when a value crosses a border **silently** (nobody checks it), **inconsistently**
(two neighboring fields use different dialects for the same kind of value), or **lossily**
(precision quietly falls off in the translation).

One more crucial piece of context: **our primary users are AI agents.** Industry measurement
(the MCP-Atlas study we cite in our own code) found that on financial tool servers, up to 45% of
agent errors are exactly this: right idea, wrong scale or format. Our design already fights this
in places — this investigation found the places it doesn't.

**Suggested visual:** the same value "4.1%" shown in four costumes: `41000000000000000000`,
`"4100000000000000000"`, `4.1`, `"0.041"` — then a border checkpoint with no guard at the booth.

---

## Scene 3 — The headline finding: the immortal market (F1, severity 7/10)

**The mistake:** In JavaScript, `Date.now()` gives you the time in **milliseconds**. Blockchains
use **seconds**. Paste a millisecond timestamp where seconds are expected and your date lands
roughly **55,000 years in the future**.

**Why it matters here:** When creating a just-in-time market, the caller supplies the market's
expiry date. We checked every layer:

- Our tool does **not** validate this field at all — not even "is it in the future".
- The smart contract checks only one thing: expiry must be *after* now. There is **no upper
  limit** (verified in the pool manager contract, line 103).

So a millisecond timestamp sails through everything and, once the order is filled, creates a real
market that expires in the year ~57,000. That matters because principal tokens in a pool can only
be fully redeemed **after expiry**. An effectively immortal market means effectively locked funds.

The irony: we built two dedicated alarm bells ("tripwires") for the percent-vs-fraction premium
mistake, but zero for the milliseconds-vs-seconds mistake — which is at least as common and has
worse consequences.

**The fix:** teach the shared timestamp type to recognize the mistake. Any date past ~2096 gets
"this looks like milliseconds — divide by 1000." One fix, and every timestamp field in every tool
inherits it. Plus a sanity ceiling on market lifetimes specifically.

**Suggested visual:** a calendar flipping to "Year 57,530", a vault door labeled "opens at
expiry" rusting shut.

---

## Scene 4 — The order that expired before it was born (F2, severity 6.5/10)

**Background:** A signed order packs several settings into one big number called `makerTraits` —
like a punch card with fixed-width columns. The expiry date gets a 40-bit column.

**The bug (demonstrated by running the code):** we write the expiry into its column with a mask —
which means anything too big to fit is silently **chopped**. We fed in the largest expiry the
input rules allow, and the chopped result came out as **July 2025 — in the past**. The tool
returned "ok" and handed back a perfectly signable order that no one can ever fill. A
milliseconds-flavored mistake in the same field lands in the year 22745 instead — an order that
never expires when its maker thought it would.

Silent truncation is the villain here: the right response to "doesn't fit" is an error, not
scissors.

**The fix:** check the value fits *before* packing it, and put a sane maximum (say, 10 years) on
the input itself.

**Suggested visual:** a long ticket being fed into a slot that guillotines off the end, the
remaining stub reading "EXPIRED YESTERDAY."

---

## Scene 5 — The label that doesn't have to match the can (F3, severity 6/10)

When someone submits a signed order to our venue, they also send listing details for the order
book: when it expires, whether partial fills are allowed, a nonce. Here's the thing — **all three
facts are already sealed inside the signed order itself** (in that same `makerTraits` punch card).
The listing fields are just a duplicate copy for display.

Our submit tool is admirably paranoid about some duplicates: it re-derives the order's hash from
scratch and refuses to trust the caller's version (our principle "K3: recompute, never trust").
But it relays the listing fields **without comparing them to the signed order**, even though it
parses the punch card two lines earlier. It also never checks that the signature actually belongs
to the order's maker (only the separate "finalize" flow does that).

**Consequence:** the order book can claim "live until Friday, partially fillable" about an order
whose signature says "expired Tuesday, all-or-nothing." Takers waste gas on fills that revert;
the book quietly rots.

**The fix:** don't accept the duplicate — *derive* those fields from the signed order, and reject
with a clear conflict if the caller's copy disagrees. We already do exactly this for another
field pair; extend the pattern.

**Suggested visual:** a soup can whose label says "Tomato" being peeled back to reveal "Mushroom,"
with a stamp: "label never checked."

---

## Scene 6 — The order that dies after its first bite (F4, severity 5/10)

Orders have a setting `allowsPartialFills`, default **true**. Sounds like: "takers can fill me a
piece at a time." But our order builder also hard-codes a hidden second setting —
`allowMultipleFills: false` — and in the 1inch protocol that combination means:

> Any *one* fill, of any size, is allowed. After that, the rest of the order is dead.

So a market maker posts 100 units, someone fills 1, and the other 99 silently become unfillable.
No error, no warning; the code even has an internal comment acknowledging the mechanics — but
the user-facing description says nothing.

**The fix:** at minimum, document it honestly. Better: make a deliberate product decision about
whether partial orders should survive multiple fills, and expose the choice.

**Suggested visual:** a sandwich behind a deli counter; one bite is taken; the whole sandwich is
swept into the bin.

---

## Scene 7 — The alarm system with gaps in the fence (F5, severity 5/10)

Recall the premium's two dialects: order book says `4.1` (percent), RFQ quotes say `"0.041"`
(fraction). We built two alarms: a *warning* for suspiciously tiny premiums, and a *blocker* that
compares your order against the quote you cite and rejects ~100× divergence.

Good idea. Four gaps, all confirmed:

1. **No bounds at all** on the premium input: a *negative* premium, or an astronomically huge one
   (someone pasting a blockchain-scale number), passes validation and gets relayed with no warning
   — the tiny-premium alarm only watches the range between 0 and 0.1.
2. **The blocker uses floating-point math.** We tested the exact boundary: a premium *exactly*
   100× the cited quote produces a computed ratio of 99.99999999999999 — a hair under the
   trigger. The alarm does not fire precisely at the divergence it was built to catch.
3. **The fraction cap misfires at its own edge.** RFQ fractions must be below 0.5. The string
   "0.49999999999999999" is legitimately below 0.5, but floating-point rounds it to exactly 0.5
   and we wrongly reject it.
4. **Missing data silently disarms the alarm.** If the quote you cite has no readable premium,
   the cross-check just… skips, and the order relays unchecked.

The deeper lesson: **never guard exact-integer promises with approximate float math.** These
thresholds should be compared as scaled whole numbers, the way all our real money math already is.

**Suggested visual:** a laser-grid alarm with one beam angled a hair too high; a burglar walks
under it at exactly the advertised height.

---

## Scene 8 — Same tool, three time dialects, one strict sibling (F6, severity 4.5/10)

Within a single tool (`cork_submit` / order prep), timestamps appear three different ways:
absolute seconds as a *string* here, absolute seconds as a *plain number* there, *relative*
seconds-from-now elsewhere. And the validation rigor is just as inconsistent: the rollover flow
strictly checks its deadlines (ordered, in the future), while its sibling, RFQ-open, checks
**nothing** — you can relay a time window that ends before it starts, or even *negative*
timestamps (the input rules literally allow them).

Why this matters beyond tidiness: agents learn conventions from one field and apply them to the
next. Inconsistency between siblings is exactly what manufactures Scene 3/4-style unit mistakes.

**The fix:** one timestamp type everywhere, and give every action the checks the strictest
sibling already has.

**Suggested visual:** three wall clocks labeled "string seconds / number seconds / seconds from
now," only one with a security guard under it.

---

## Scene 9 — The price quote with unlabeled currencies (F7, severity 4/10)

Ask the tool "what does it cost to take 1 token of collateral out?" and the answer contains four
numbers — in **three different unit systems**, with no labels:

- the rate (18-decimal fixed point, 1e18 = 1.0),
- the swap-token amount (always 18 decimals),
- the reference-asset amount (that token's *own* decimals — could be 6),
- the fee (the *collateral* token's decimals).

For pools where every token has 18 decimals, all of this coincidentally lines up — so an
integration gets built, tested, shipped… and then meets a 6-decimal asset (like vbUSDC, one of
our canonical examples) and is suddenly wrong by a **factor of a trillion**, silently.

We already solved this once: another response (`resolve-recipe`) ships a little `scales` block
that spells out its units. It just never became the house rule.

**The fix:** every money-bearing response labels its units and echoes the token decimals.

**Suggested visual:** a restaurant bill where one line is in dollars, one in yen, one in cents —
no currency symbols anywhere.

---

## Scene 10 — The photocopy that keeps going where the original stops (F8, severity 3.5/10)

Our math is a "bit-exact port" of the contracts — same inputs, same outputs, proven wei-for-wei.
But there's a subtle asymmetry: when the *contract* gets an impossible input (like a "current
time" before the market even existed), it **refuses to compute** — the transaction reverts. Our
copy doesn't refuse. We ran it: fed a time 100 seconds before the market's start, and the port
cheerfully computed a fee of 5.5% from a 5% maximum — a number the real contract would never
produce.

Today's tool handlers can't reach this state (they read time and market data from the same
snapshot). But this math ships as a library that other projects can import directly, and future
features could desync those inputs. "Bit-exact" should include *refusing exactly where the
contract refuses.*

**The fix:** add the same guardrails the contract has — refuse impossible inputs with a clear
error — and document the promise precisely.

**Suggested visual:** two calculators side by side; the real one displays "ERROR," the photocopy
displays "5.5%."

---

## Scene 11 — Small stuff, honestly disclosed (F9–F12, severity 2–3/10)

- **A rate dressed as an amount (F9):** the rollover field `minPremiumPerShare` is actually
  "premium-token units *per share*," but it's described as a plain token amount. For a 6-decimal
  premium token, following the description produces the wrong number. Fix: rewrite the one
  description, with examples.
- **Two numbers that snuck past the dress code (F10):** block numbers in two event-related outputs
  are emitted as raw JavaScript numbers instead of strings like everything else; a `staleness`
  field never says its unit. Cosmetic today, convention-eroding tomorrow.
- **Fingerprints that depend on word order (F11):** each response carries a digest (fingerprint)
  of its data, but the fingerprint depends on JSON key order. Fine for comparing our own outputs;
  fragile if anyone else recomputes it. Also, four different mismatch situations share one error
  code (`digest_mismatch`). Fix: document "opaque, compare only ours," or canonicalize; split the
  code.
- **Fields that are accepted, then ignored (F12):** two input fields validate fine and then do
  nothing (they're reserved for later). Documented in the docs, invisible in the response. Fix:
  a one-line "this field was ignored" warning in the response itself.

**Suggested visual:** a quick-cut montage — mislabeled jar, two guests in jeans at a black-tie
party, two identical documents with different fingerprints, a suggestion box with no bottom.

---

## Scene 11a — The change machine that hands back the whole bill (F13, severity 6.5/10)

**Second-pass finding.** When we build a "buy up to X" action — say "mint me some shares, and
spend at most 100 collateral to do it" — we move the **whole 100** into the adapter before the
action runs. But the action often only needs 80. The other 20 is left sitting in the adapter, and
we build **no leg to send it back**. Our reading of the contract says leftovers aren't refunded,
and anyone can sweep them in the next block.

So a user who plays it safe with a generous cap silently donates the difference. Playing it safe
becomes the expensive choice — the opposite of what "maximum I'll spend" is supposed to mean.

*(Honesty flag: the "we move the whole cap" part is confirmed in our own code; the "not refunded,
sweepable by anyone" part is read from the smart-contract source and should be confirmed on a test
fork before we act on it.)*

**The fix:** add a "send the change back to the user" step for every capped amount.

**Suggested visual:** a vending machine that takes your $20 for a $16 snack and drops the $4 change
into a slot labeled "anyone."

---

## Scene 11b — The bouncer who never checks IDs (F14, severity 6.5/10)

**Second-pass finding.** When someone submits a signed *rollover* order, we compute its fingerprint
— but we never check that the signature actually belongs to the person named on the order. (We do
this correctly for one other order type; rollover just… doesn't.) We also skip the settler and
deadline sanity checks that our own *preparation* step performs.

So a rollover order signed by the wrong person, or with garbage where a signature should be, sails
through and gets relayed — then quietly can't be filled. Our whole design philosophy is "recompute
every commitment, trust nothing" — and the signature is the one commitment we forgot to recompute.

**The fix:** recover the signer from the signature and reject if it isn't the order's owner; re-run
the settler/deadline checks before relaying.

**Suggested visual:** a bouncer waving people through a velvet rope while glancing at, but never
opening, their IDs.

---

## Scene 11c — "Here's everything" when it's really just page one (F15, severity 6/10)

**Second-pass finding.** One of our data-read modes (the fully-decentralized one) fetches a single
page of results and throws away the "there's more — resume here" bookmark the service hands back.
So not only is the data cut off, callers **can't even tell** it was cut off. The mainnet scan that
starts from block zero over the busy 1inch protocol is almost guaranteed to truncate — and because
it isn't filtered down to Cork, it also mixes in *other people's* trades.

The result: a partial, partly-unrelated list presented as the complete picture. (Our main venue
reads handle this perfectly, with careful "this list is incomplete" signalling — this one path just
skips it.)

**The fix:** follow the "resume here" bookmark until the data runs out, or clearly flag the result
as incomplete like our other reads do; scope the scan to Cork.

**Suggested visual:** someone confidently reading "the full report" that's actually just the first
page, with pages 2-through-500 still in the printer.

---

## Scene 11d — The blackout that quietly rewinds our address book (F16, severity 5.5/10)

**Second-pass finding.** We fetch our list of contract addresses fresh and cache it. We confirmed
that if the cache goes a little stale and a refresh fails for even ten minutes, we **overwrite the
good cached copy** with a "failed" marker and fall back to the addresses that shipped inside the
installed app — which can be older. One of those addresses is explicitly labeled "this one moves" —
so a brief network blip can silently point our unsigned transactions at a **retired** address.

The safer behavior is obvious in hindsight: if the fresh fetch fails, keep serving the
slightly-stale-but-real cache instead of throwing it away for the shipped-in fallback.

**The fix:** never discard a known-good cache on a temporary failure; prefer stale-real over
bundled-old.

**Suggested visual:** a phone contact list flickering during a signal drop and quietly restoring
everyone's *old* phone numbers.

---

## Scene 11e — Everything else the second pass turned up (grab-bag)

The deeper pass found more small ones, same flavors as before:

- **The decoder hides the good with the bad** — one malformed piece of a bundle makes the whole
  decode fail, hiding every other (perfectly readable) piece. It should show the good and mark the
  bad "unknown."
- **The wrong "do you have permission?" light** — the account view shows one Permit2 approval, but
  the funding step needs a *different* one it never checks; a green light that doesn't mean "go."
- **Uneven guards across one tool** — some actions strictly validate their time windows and pool
  state; their siblings validate nothing (a window that ends before it starts, a deadline already
  in the past, a check that only looks at page one).
- **Error signals that mislead integrators** — routine "not found" results get flagged as hard
  errors, while serious integrity conflicts get flagged as success, unless the caller reads a
  specific field; error responses also stamp the wrong chain ID.
- **A hand-typed RPC address isn't chain-checked** — point it at the wrong network and every answer
  is wrong-network data wearing the right label.
- **The command line rounds big numbers in a few fields** before validation ever sees them.

**Suggested visual:** a fast montage of small red flags — a shredder eating a whole folder over one
torn page, a green light wired to the wrong switch, a mislabeled shipping stamp.

---

## Scene 12 — What was checked and came back clean

Credit where due, because it's most of the codebase:

- The core pricing/fee/impairment math: exact integer arithmetic, rounding directions matching
  the contracts, pinned by tests that compare against the live chain wei-for-wei.
- One central choke point converts all big numbers to strings before output — no money value
  leaves as a lossy float (the venue's percent-premium field being the deliberate exception).
- Data from the venue is treated as untrusted and re-verified — for hashes and signatures the
  paranoia is real and correct.
- Token decimals are always read live from the token contracts, never assumed.
- The band-resolution math **re-checks itself against the chain on every single call** and raises
  a conflict if it ever drifts. This is the gold-standard pattern the fixes above should copy.

**Suggested visual:** a factory floor where most stations have green lights; camera pans to the
handful of red ones we've just toured.

---

## Scene 13 — The one structural lesson (the ending)

Every protection in this codebase that exists was built **bespoke, per field**: premiums got
tripwires, band math got a self-check, amounts got teaching text. All good — but it means every
*new* field starts life unprotected, and the gaps we found are exactly the fields nobody got
around to.

The highest-leverage fix isn't any single patch above. It's moving the protections **into the
shared types** so every current and future field inherits them automatically:

1. The timestamp type learns to smell milliseconds and absurd horizons.
2. Anything that duplicates signed data is derived or cross-checked, never trusted.
3. Range checks happen *before* bit-packing, everywhere.
4. Scale alarms use exact integer math, never floats.
5. Every money-bearing response labels its units.
6. A CI test that **fails the build** if someone adds a new field carrying money/time/rate
   semantics without using the protected types.

That last one turns this whole document into an enforced rule instead of a memory.

**Suggested visual:** individual guards being replaced by a single checkpoint built into the
road itself; end card: "Protect the types, and the fields protect themselves."

---

## Scene 13a — How complete is this? (the honesty beat)

Worth saying plainly, because it's the difference between "we found the bugs" and "we found some
bugs": **we are not claiming this is the whole list.** The first pass read the core carefully and
found a dozen issues. When we looked harder in a second pass, the count roughly doubled. That's the
honest signal — look harder, find more.

The reassuring part: every new finding fit a category we'd already named. No new kind of problem
appeared. So we trust the map of failure types even if the pin-list isn't final.

Three gaps remain before anyone should say "exhaustive": the funds-impact part of the vending-
machine finding (Scene 11a) is read from the contract, not yet tested on a fork; this whole audit
was done offline, so the live-chain and live-venue paths sit out; and we did no fuzzing. For the
number-crunching core especially, throwing millions of random inputs at it and comparing to the
chain is the only thing that earns the word "exhaustive" — and it's the natural next step.

**Suggested visual:** a map with a well-lit explored region and a hand-drawn "here be dragons" edge;
caption: "the map is trustworthy; the edges aren't fully walked yet."

---

## Appendix: severity cheat-sheet for the video

**First pass (the core):**

| # | Nickname | Severity | One-liner |
|---|---|---|---|
| F1 | The immortal market | 7/10 | ms-vs-seconds timestamp creates a pool expiring in year ~57,000; funds locked till expiry |
| F2 | Expired before birth | 6.5/10 | oversized expiry silently chopped to a past date; tool says "ok" |
| F3 | Label ≠ can | 6/10 | order-book listing fields never checked against the signed order |
| F4 | One bite kills it | 5/10 | partial-fill orders die after the first fill; undocumented |
| F5 | Gaps in the laser grid | 5/10 | premium alarms: unbounded input, float edge misses, silent skip |
| F6 | Three clocks, one guard | 4.5/10 | timestamp dialects and validation rigor vary within one tool |
| F7 | Unlabeled currencies | 4/10 | one response mixes three unit systems with no labels |
| F8 | The eager photocopy | 3.5/10 | ported math computes where the contract would refuse |
| F9–F12 | Small stuff | 2–3/10 | misleading field description; stray raw numbers; order-sensitive fingerprints; ignored fields |

**Second pass (the rest of the codebase):**

| # | Nickname | Severity | One-liner |
|---|---|---|---|
| F13 | The change machine | 6.5/10 | capped "buy up to X" actions fund the whole cap; unspent remainder is stranded on the adapter |
| F14 | The bouncer who won't check IDs | 6.5/10 | rollover orders are relayed before the signer is confirmed to be the order owner |
| F15 | Just page one | 6/10 | decentralized reads stop after one page and can include non-Cork rows |
| F16 | The blackout rewind | 5.5/10 | a brief fetch failure drops a good address cache and falls back to shipped-in (older) addresses |
| F17–F22 | Second-pass small stuff | 3–4.5/10 | decoder hides good legs when one is malformed; wrong Permit2 allowance shown; uneven sibling guards; error-signal severity inversion; hand-set RPC not chain-checked; CLI rounds a few numeric fields |

All demonstrated claims were reproduced by running the actual code on 2026-07-24 (run log in the
technical report, §3); everything else was confirmed by reading the source and the reference
smart contracts side by side. See Scene 13a for the completeness caveats.
