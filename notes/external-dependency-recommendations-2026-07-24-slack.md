# Slack message draft — external-dependency recommendations

*Post this to the relevant channel with the HTML file attached as an upload (not pasted inline —
Slack mangles the CSS if you paste the markup). File:
`notes/external-dependency-recommendations-2026-07-24.html`.*

---

📎 *Footgun audit → things we can't fix on our side (dependency owners, this one's for you)*

While hardening **cork-helper-cli** against numeric/API footguns, a handful of the issues turned out
to have their root cause in a dependency we *consume* — the contracts, the venue, the registry, the
indexer, or the remote address file. I've fixed the tool-side workarounds already; this is a
short list of the upstream fixes I'd like so the workarounds can eventually retire (and so other
consumers without our guards are protected too).

Attached HTML (self-contained, opens in any browser) has the full write-up — problem / why it
matters / the fix we want — one section per dependency. The headline asks:

• *Contracts:* enforce the 5% fee cap **at pool creation** (not just the setter), add an **upper
  bound on expiry**, and make the adapter **refund the unused slippage cap** (right now the leftover
  is skimmable by anyone).
• *Venue (api-phoenix):* stop serving **malformed / zero-amount** order rows, and converge the
  **dual-scale premium** contract (percent `4.1` vs fraction `"0.041"`) onto one scale.
• *Market-registry:* guarantee that a recipe's **resolved bands always satisfy `createNewPool`**
  (today a lookupable recipe can resolve to an uncreatable market).
• *Envio HyperSync:* nail down **pagination / indexer-lag** behavior, and confirm whether the
  **staging PM is indexed**.
• *cork-defaults.json:* it currently **404s**, so we run on the bundled fallback — please **publish
  it at the canonical URL and SHA-pin/sign it** (we validate shape, not authenticity).

Owners I could guess are tagged below; I left `@owner-tbd` wherever I wasn't sure — please reassign.

Contracts: @ziankork (Pybast?) · Registry/venue: @owner-tbd · Envio integration: @owner-tbd
(raouf2ouf?) · cork-defaults publishing: @heri16 (?)
