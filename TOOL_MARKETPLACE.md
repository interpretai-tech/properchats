# ProperChats Tool Marketplace — the plan

> Living document (appended to over time). Companion to
> [docs/PUBLIC_TOOL_ECOSYSTEM.md](docs/PUBLIC_TOOL_ECOSYSTEM.md) (the manifest
> contract) and [TOOL-OPENSOURCE-properchats.md](TOOL-OPENSOURCE-properchats.md)
> (the first three tools landed through it). This file is the **product plan**:
> how the open-source repo becomes a place where anyone can add their toolset,
> and how the private deployment uses the same design to ship trending tools
> fast.
>
> Status log at the bottom; new research and decisions get appended, not
> rewritten.

## 1. The thesis

ProperChats runs ONE agent loop (Sauron). A "tool" is never a new
orchestrator — it is a **toolset**: a small manifest (open-source side) or a
Python toolset class (private IAI side) exposing a few JSON-schema functions,
a system-prompt fragment, and optionally a rich card renderer. Because the
loop, streaming contract, gating, and UI tiers already exist, the marginal
cost of a new tool is ~one file plus a registry entry. The marketplace is the
bet that this marginal cost is low enough that *outsiders* will pay it.

Two audiences, one contract:

| | Open-source (properchats-public) | Private (properchat + IAI) |
|---|---|---|
| Unit of contribution | `ToolManifest` + binding in `src/lib/tools/bindings/` | Sauron toolset class in `interpret/backend/ai/models/` |
| Who adds tools | Anyone via PR (or runtime manifest URL, phase 3) | Us, chasing trending APIs |
| Auth | Keyless or bring-your-own-key env vars | Platform keys, metered via `increment_capability_usage` |
| Discovery | `GET /api/tools/<id>` manifest endpoint | CapabilityPicker, tier-gated |
| Invocation | `POST /api/tools/<id>` webhook bridge | Tool token in `tools:[...]` on the messages/stream call |

## 2. Open-source marketplace: contribution path

What exists today (proven by wttr.in / mathjs / yahoo-finance2):
`src/lib/tools/manifest.ts` (contract), `registry.ts` (typed list +
`invokeTool` dispatch), `/api/tools/[tool]` bridge route, e2e spec proving
live calls.

The marketplace plan, phased:

**Phase M1 — "PR a folder" (now → next).**
- `CONTRIBUTING_TOOLS.md`: a 10-minute recipe — copy `bindings/weather.ts`,
  fill the manifest (id, functions, JSON schemas, `upstream` attribution
  block), add the registry entry, add one live-call test. CI runs the
  tools-registry spec on PRs.
- Manifest gains three fields needed for marketplace listing: `category`,
  `pricing: "keyless" | "byok" | "metered"`, and `maintainer` (GitHub handle).
- A generated `TOOLS.md` catalog (script walks `TOOL_MANIFESTS`) so the README
  shows the live tool list without manual edits.

**Phase M2 — model-facing, not just webhook-facing.**
Today the bridge is HTTP-invokable but the public agent loop doesn't
auto-attach manifests as model tools. Add a `manifestToToolDefs()` adapter so
every registered manifest's functions become callable tools in the public
chat loop (capability id `community_tools`, one picker entry, functions
namespaced `<toolId>__<fn>`). This is the moment "marketplace" becomes real:
adding a binding makes the *assistant* able to use it, not just curl.

**Phase M3 — runtime registration (no fork needed).**
`TOOL_MANIFEST_URLS` env: comma-separated URLs serving manifest JSON; the
bridge proxies invocation to the manifest's declared `endpoint` with an HMAC
header. This is the external-developer path — host your tool anywhere,
register by URL. Needs: schema validation on load, per-tool rate limits
(already in the bridge), an allowlist default-off in hosted deployments.

**Phase M4 — trust & listing.**
A `marketplace/` index (JSON in-repo, later a tiny site): verified badge =
maintainer signed the manifest + live-call CI green for 30 days. No paid
listings; metered tools declare their own pricing in the manifest and the
host's gate (`CAPABILITY_POLICY`) decides exposure per tier.

## 3. Private fast-path: trending tools as Sauron toolsets

The private design mirrors M1 with the IAI toolset class instead of a TS
manifest. The recipe that has now shipped mail, customer_search, and
submittal_review:

1. **Toolset class** (`*_toolset.py`): few functions, strict JSON schemas,
   refusal messages that instruct the model (see mail_toolset's
   branch-aware refusals), system fragment with anti-placeholder wording.
2. **Registry token** in `native_tools/registry.py` + capability predicate.
3. **PC wiring**: `Capability` union + `CAPABILITIES` entry +
   `capabilityInterpretTool` token + picker entry; gate/meter via the generic
   `increment_capability_usage` RPC (no migration per tool).
4. **Card UI** only if the result deserves it (run cards, globe, pdf pane);
   otherwise plain markdown is fine for v1.
5. **Playwright spec** with `page.route` mocks (per repo convention).

Selection filter for "trending": clean REST + API-key auth (no OAuth dance for
v1), usage-based pricing we can meter 1:1 onto the existing per-capability
counter, and a result that renders as a satisfying card. Candidate research is
appended below as it comes in.

## 4. Observability hook (so marketplace tools are debuggable)

Every toolset call already flows through the one loop, so the OTEL pivot
(collector → Tempo → Grafana; SigNoz abandoned) gives marketplace tools
tracing for free: spans tagged `tool.id` / `swarm.run_id`, queryable in
Grafana Explore. Manifest tools invoked via the bridge route should emit one
span per invocation with the same attributes — add this when M2 lands so
community tools are first-class in the same dashboards.

---

## Appended research & decisions

<!-- Each loop tick appends below this line; never rewrite history above. -->

### 2026-06-10 — initial plan committed; trending-tool research in flight

- Round of web research on June-2026 trending, easy-to-wrap APIs launched;
  results land here as `### Trending tool candidates` when complete.
- OTEL→Grafana pivot started in the obs tree (SigNoz terraform module slated
  for removal; Tempo + otel-collector added next to the existing
  Prometheus/Grafana helm releases).

### 2026-06-10 — Trending tool candidates (researched via PH/HN leaderboards + vendor pages)

| Tool | What | Effort | Pricing | OSS | Card idea |
|---|---|---|---|---|---|
| **fal.ai** | One API for trending video/image models (Veo 3.1, Kling 3.0, Seedance 2.0, Flux 2) | **S** — one `generate_video/image` tool, async polling matches the SSE loop | Pure usage (Kling $0.07/s, Seedream $0.03/img) | no | Inline video player card + "remix" button |
| **ElevenLabs** | TTS, music gen, SFX, dubbing, voice agents | **S** — POST → audio bytes | Free 10K chars; PAYG; Music $0.15/min | no | Waveform audio card — "your business jingle in 10s" |
| **Firecrawl** | Scrape/crawl/monitor any site → LLM-ready markdown (~131K stars) | **S** — endpoints map 1:1 to tools, output already markdown | Free 1k credits/mo; from $16/mo | **yes** | Page-snapshot card + diff badge on Monitor fire |
| **Exa / Websets** | Neural search + lead-list enrichment (email/phone) | S–M (enrichment is async/webhook) | 1k free req/mo; $7/1k searches, $0.02/email | no | Lead-list card feeding the globe + mail toolset |
| **Shovels** | US building permits (130M+) + contractors (2.3M+); new zoning Decisions API | **S** — one GET per lookup; best brand fit (submittal_review synergy) | Free in-app search; API via sales | no | Permit timeline per address; jurisdiction heatmap on globe |
| **RentCast** | Property records, AVM home value/rent + comps, MCP server bundled | **S** — 3-4 synchronous GET tools | Free 50 calls/mo; from $74/mo | no | Property card: value gauge, rent est., comps mini-map |
| **Vapi** | Voice AI phone agents (real outbound/inbound calls) | M — webhooks for live transcript | $0.05/min + pass-through; 60 free min | no | Call card: live status, recording, AI summary |
| **Tavus** | Real-time AI avatar video (clone from ~1 min footage) | M — async gen easy, live CVI harder | Free 25 min; $59/mo + $0.37/min | no | Avatar-video pitch card, one-click attach to mail |
| **Cal.com v2** | Scheduling API: slots, bookings, webhooks | **S** — `find_slots`/`create_booking`, BYO key | Free plan incl. API key | **yes** (AGPL) | Booking confirmation card + reschedule |
| **Documenso** | Open-source e-sign (DocuSign alt) | S–M — pairs with submittal PDF pipeline (review → sign) | Free 5 docs/mo; $25/mo + API | **yes** | Signature-status card with per-recipient chips |
| **Postiz** | Publish/schedule to 30+ social networks; MCP-native | **S** — `schedule_post(channels, text, media, time)` | From $29/mo; self-host free | **yes** | Multi-platform post preview + countdown |
| **Lob** | Programmatic physical mail (postcards/letters/checks) | **S** — mail toolset already emits HTML/PDF; one POST to make it physical | Free dev plan; ~$0.87/postcard | no | Postcard front/back render + USPS tracking timeline |
| **Browserbase + Stagehand** | Cloud browsers for agents + new Search/Fetch APIs | M–L — session lifecycle; overlaps Firecrawl for simple cases | Free tier; $20/mo dev | Stagehand yes | Live session card with screenshot frames + action log |
| **Stripe Agentic Commerce** | ACP/x402/agent wallets — in-chat checkout & machine payments | M — toolkit easy, token guardrails careful (Stripe already wired for mail) | Per-transaction | no | In-chat checkout card → confirmed receipt |

**Shortlist (virality × ease):** 1. fal.ai (most shareable artifact a chat
can emit), 2. ElevenLabs, 3. Firecrawl (also the OSS-marketplace flagship),
4. Shovels (best "proper" brand fit), 5. Postiz (closes the content loop;
OSS + MCP-native).

**Decisions from this round:**
- properchats-public (open marketplace) first additions should be the OSS
  trio **Firecrawl, Cal.com, Postiz** (+ Documenso later) — all
  self-hostable, all manifest-friendly, all keyless-or-BYOK.
- Private (Sauron toolset) fast-path order: **fal.ai → ElevenLabs →
  Shovels** — S-effort wraps, usage-priced (meter 1:1 on
  `increment_capability_usage`), each yields a signature card (video /
  audio / permit timeline).
- Lob remains the designated PostAgent fallback/extension for physical mail
  (ties into task #110: platform-billed mail evaluation).

### 2026-06-10 — Task #110 verdict: PostAgent vs platform-billed mail (Lob) — GO for hybrid

Code-grounded eval (mail_toolset.py, usage.ts, this doc's "MAIL, twice"
example; lob.com + postgrid.com fetched 2026-06-10). **GO for the hybrid,
NO-GO for full replacement.**

| Axis | PostAgent (today) | Lob | PostGrid (alt) |
|---|---|---|---|
| Billing | user-paid Stripe checkout; zero platform risk | platform-billed; Developer $0/mo PAYG, **$0.806/letter** ($0.636 on $260/mo Startup) | $1.019–1.179/letter, free tier to 500 |
| Formats | pdf/html/md/text/docx/image, **30 MB** cap | **PDF <5 MB + HTML only** (Webkit, merge vars) | PDF/HTML |
| International | US-only (hard-coded) | yes (240+ countries) | yes |
| Tracking | job polling, 5-state machine | **webhooks** (USPS scans) + real test env | 1 webhook free |

Platform cost at 10/100/500 letters/mo: $8 / $81 / $403 (Lob Developer).
A $2 mail-credit over Lob's $0.806 ≈ $1.19/letter gross margin.

**Recommendation:** keep both bindings, tier-select — free/basic →
PostAgent user-paid (zero platform risk; could even unblock from today's
`blocked` with a small rate-limit cap), monthly/insane → Lob
platform-billed with 5/mo allowance + `creditsFallback` credit packs.
Three corrections to this doc's Manifest-B sketch: Lob Developer is $0/mo
PAYG (not invoice-only); Lob's **5 MB PDF cap** breaks our 30 MB
assumption (enforce 5 MB on the Lob path or route big PDFs to PostAgent);
no native image format (wrap `attached_image` in HTML — remote assets OK
on Lob's renderer, unlike PostAgent).

Wiring (existing seams only): (1) Lob provider class beside
PostAgentClient inside the same `mail` toolset, tier-selected; result =
letter id + thumbnail, `letter_created` status; (2) usage.ts gains
`consumeMail` mirroring `consumeSubmittalReview` (generalize the
credit-composing RPC to capability-keyed); gate pre-check + post-stream
`meterMailOnSend` unchanged; (3) a `mailLetter` card (id, status, Lob
proof thumbnail, cancel-while-cancellable) — PostAgent path stays prose.
Unverified before shipping cancel UI: Lob's cancellation-window length.

### 2026-06-10 — Tool observability is now live-ready (status update to §4)

Both halves of the §4 hook landed today in the private trees: the
infra side (SigNoz module removed; OTEL collector + Tempo deployed next to
Prometheus/Grafana, Tempo datasource queryable in Explore) and the app side
(swarm tracing now defaults to a `NullSpanEmitter` — spans buffer nothing
unless an OTLP endpoint is configured, so pointing
`OTEL_EXPORTER_OTLP_ENDPOINT` at `otel-collector.monitoring.svc:4318` is the
single switch that lights up tool tracing in Grafana). Remaining item is
unchanged: when M2 lands, the public bridge route emits one span per
invocation tagged `tool.id`.

### 2026-06-10 — Firecrawl `web_scrape` SHIPPED (first BYOK tool, recipe proven)

Built exactly to the pinned design and landed in one pass using
CONTRIBUTING_TOOLS.md — the recipe holds: one binding file
(`bindings/firecrawl.ts`), one registry entry + dispatch arm, three specs.
8/9 registry specs pass end-to-end (the 9th is the live BYOK dispatch test,
skip-if-unconfigured as designed). Catalog regenerated: 4 tools.
One recipe learning folded back into the binding: resolve `auth.secrets`
keys BEFORE the upstream-fetch try block, or the 503 "not configured"
refusal gets re-wrapped as a 502 — worth a line in CONTRIBUTING_TOOLS.md
when it's next touched. Note for CI/dev: the repo needs Node >=20.9
(`~/.nvm/versions/node/v22.22.0` works; system node is 20.0.0).

### 2026-06-10 — Firecrawl binding design pinned (next build step)

The first recipe-proving contribution is specified; implementation is
mechanical from here:

- `src/lib/tools/bindings/firecrawl.ts` — two functions:
  `scrape_url(url, only_main_content?)` → POST `${FIRECRAWL_BASE_URL}/v2/scrape`
  returning `{ url, title, markdown }` (markdown trimmed to ~8k chars with a
  `truncated` flag — agent-sized output rule), and
  `search_web(query, limit<=5)` → POST `/v2/search` returning compact
  `{title, url, snippet}` rows.
- Manifest: `id: "web_scrape"`, category `data`, **pricing `byok`**
  (`auth.secrets: ["FIRECRAWL_API_KEY"]`) — first BYOK tool, which exercises
  the one M1 path the keyless trio didn't; `FIRECRAWL_BASE_URL` env override
  keeps the self-host door open (upstream: firecrawl/firecrawl, AGPL-3.0).
- Tests: discovery + skip-if-unconfigured dispatch
  (`test.skip(!process.env.FIRECRAWL_API_KEY, …)`), per the recipe.

### 2026-06-10 — M1 complete: listing fields + generated catalog

`ToolManifest` gained the three marketplace fields (`category`,
`pricing: keyless|byok|metered`, `maintainer`), all three live manifests are
populated, and [TOOLS.md](TOOLS.md) is now **generated** from the registry
(`npm run gen:tools` → `scripts/gen-tools-catalog.mjs`, executed with tsx
against the typed registry so the catalog cannot drift from the code).
M1 is done: recipe + listing metadata + auto-catalog. Next phase gate is
**M2** (`manifestToToolDefs()` — manifests become model-callable in the chat
loop), with the Firecrawl binding as its proving tool.

### 2026-06-10 — M1 ships: CONTRIBUTING_TOOLS.md

[CONTRIBUTING_TOOLS.md](CONTRIBUTING_TOOLS.md) is in: the one-binding-file +
one-registry-entry + one-test recipe, with qualification rules (keyless/BYOK,
license attribution, agent-sized output) and the PR checklist. Remaining M1
items: the three new manifest fields (`category`, `pricing`, `maintainer`)
and the generated `TOOLS.md` catalog. Next concrete tool: a **Firecrawl**
binding (`scrape_url` first — free tier, OSS, output is already markdown),
which will be the first contribution to exercise the recipe end-to-end.

Sources: producthunt.com monthly leaderboards 2026/5+6, HN /best + /show,
firecrawl.dev/pricing, exa.ai/pricing, shovels.ai, fal.ai/pricing,
elevenlabs.io/pricing/api, cal.com/docs/api-reference/v2, documenso.com/pricing,
postiz.com, lob.com/pricing, tavus.io/pricing, vapi.ai/pricing,
rentcast.io/api, browserbase.com/pricing, docs.stripe.com/agentic-commerce.

### 2026-06-11 — The One Agent: the marketplace's universal consumer

Decision (from the private build, recorded here because it sets the
marketplace's north star): ProperChat is gaining **"The One Agent"** — a
selectable capability wired to the unified agent loop that attaches the
*entire* toolset (web search, deep research, document tools, vertical
toolsets) and reasons in-thread until it decides it's done, handling tool
failures and retries itself.

Why this matters for the marketplace: every manifest registered through the
M1 recipe should be *automatically* in The One Agent's toolset — no
per-tool UI, no per-tool capability entry. That makes `manifestToToolDefs()`
(M2) the single integration point: a contributor ships one binding file and
their tool is immediately usable both as a standalone capability *and* by
the flagship agent. Design rule going forward: **a manifest that needs
special-casing inside the agent loop is a malformed manifest** — failure
handling, auth (BYOK), and output sizing must live in the binding, because
the One Agent will call tools unattended.

### 2026-06-11 — Usage metering is a manifest concern (from the obs build)

The private obs work is adding per-API-key usage + billing metrics
(tokens/requests/est-cost by provider/model/key-alias, exported OTEL →
Prometheus → a "LLM Usage & Billing" Grafana board, plus optional env-gated
pollers for the Anthropic admin usage/cost API and OpenAI usage API).
Marketplace consequence: the manifest's `pricing` field (landed in M1)
should graduate from documentation to **meterable contract** — a binding
declares its unit (per-call, per-token, per-page) and the platform emits a
`tool_calls_total{tool, unit, key_alias}` metric at the dispatch seam in
`registry.ts`, the same one-seam pattern as the chat providers. That gives
every contributed tool usage/billing observability for free, and it's a
prerequisite for The One Agent calling marketplace tools unattended:
unmetered tools are invisible cost. Key rule carried over: metric labels
carry key *aliases* (env-var name or hash prefix), never key material.

### 2026-06-11 — Degrade by stripping, not blocking (One Agent metering learnings)

Pattern decision from hardening the private One Agent: when an agent holds
a *union* of toolsets and one of them is quota-exhausted (or unconfigured),
the right behavior is to **strip that token from the grant** for the turn
— the agent keeps working with the rest — never to 402 the whole turn.
Implemented as a generic `excludeInterpretTools` seam at the single place
the tools list is built. Marketplace rule that follows: a manifest binding
must tolerate being absent (the agent's prompt never promises a specific
tool), and per-tool metering (see the meterable-pricing note above) is what
makes stripping decidable. Second learning: meter per *invocation* in the
turn's activity log, not per turn — agent loops can call one tool dozens of
times per turn, and per-turn metering undercharges by exactly that factor.

### 2026-06-11 — Two-plane usage telemetry: Grafana for cost, PostHog for product

Decision: usage observability splits into two planes and tools shouldn't
blur them. **Infra/cost plane** (landed): OTEL metrics → Prometheus →
Grafana — tokens, requests, est-cost per provider/model/key-alias, vendor-
billed spend. **Product plane** (building): PostHog — capability selected,
turn sent/completed, run launched, paywall funnels, keyed by user id; lazy-
loaded, env-gated no-op, hard no-content rule (labels only, no message
text, no autocapture, no recording, /admin excluded). Marketplace rule:
a contributed tool gets BOTH for free from the platform seams — the
registry dispatch metric (cost plane) and a `tool_used {tool}` product
event — so manifests never embed their own analytics SDKs (a binding that
phones home fails review).

### 2026-06-11 — Wave verification learning: masked failures unmask on vendor recovery

From today's full-suite gate: a model binding (gp-xlarge → direct
gpt-5.5-pro on chat-completions) had been broken for an unknown time but
*invisible* because the vendor key was over quota — every call failed at
the quota layer before reaching the endpoint mismatch. When the key
recovered, the real bug surfaced. Marketplace rules derived: (1) a
binding's CI must include a *shape* test against recorded vendor responses
(endpoint/protocol mismatch fails fast even when live keys are dead);
(2) the platform error normalizer owns ALL user-facing copy — raw vendor
prose leaking to the UI is itself a review-blocking defect, because vendor
errors change under your feet. Both now enforced privately; recipe docs
should carry them into CONTRIBUTING_TOOLS.md when M2 lands.

### 2026-06-11 — Critic cadence: review-per-feature, then sweep-per-wave

Process decision worth encoding for marketplace contributions: today's
wave ran TWO distinct critic passes and each caught things the other
couldn't. Per-feature adversarial critics (launched the moment a feature
landed) found design-level holes — a fail-open admin gate, quota
amplification through an agent's tool union, a health cache that was
silently inert in prod. The end-of-wave sweep (full Playwright suite +
simplification pass over only the new diff) found what per-feature review
can't see: cross-feature collisions, vendor-recovery unmaskings, and dead
weight left by the fixes themselves. Marketplace mapping: PR review of a
contributed binding = the per-feature pass; the nightly catalog-wide
suite over TOOLS.md entries = the sweep. Neither substitutes for the
other.
