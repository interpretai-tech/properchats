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

### 2026-06-11 — Build caches lie after deletions

Tiny but recurring lesson from critic round 6: deleting a route/file can
leave generated build-cache types (`.next/types` validators) referencing
the dead module, failing typecheck with a phantom error that looks like a
real break. Rule for the contribution recipe: tool-binding PRs that
DELETE files must run typecheck from a clean build dir (CI already does;
locally `rm -rf .next` first). Cheap to document, saves every contributor
the same five confused minutes.

### 2026-06-11 — Convergence as a merge gate, not vibes

The simplification loop over the One Agent/admin/analytics wave converged
measurably: 43 dead surfaces (legacy code) → 4 → 1 → 3 → 0 code-level
findings per round, with each round forced onto *new* attack angles so a
clean verdict isn't a replayed probe list. Rule worth adopting for
marketplace batch reviews: a tool-catalog sweep is "done" when N
consecutive rounds with disjoint probe strategies report clean — not when
one review passes. The dedupe ledger (fixed vs deliberately-kept, with
reasons) is what makes consecutive rounds cheap; without it every round
re-litigates old adjudications.

### 2026-06-11 — M2 SHIPPED: `manifestToToolDefs()` — manifests are model-callable in the chat loop

The marketplace is now real in the M2 sense: a contributor's one-binding-file
+ one-registry-entry recipe makes their tool BOTH a webhook capability
(`POST /api/tools/<id>`) and callable by the assistant, with zero extra work.
What landed, and the design decisions:

- **Defs adapter** (`src/lib/tools/defs.ts`): `manifestToToolDefs()` maps
  each registered *webhook* manifest to a provider-agnostic def
  `{ name, description, parameters }` — name namespaced `<toolId>__<fn>`
  (resolved back via registry-prefix match, since ids contain single
  underscores), description = per-function text + the manifest's agent blurb
  (both are prompt text), schema passed through verbatim from the manifest.
- **Chat-loop wiring** (`src/lib/server/providers.ts`): all three direct
  chat adapters now run a bounded agentic loop (≤6 tool rounds) — Anthropic
  custom tools (`input_schema` / `tool_use` / `tool_result`), OpenAI
  chat-completions functions (`tool_calls` / role `tool`), Gemini
  `function_declarations` / `function_call` / `function_response` (response
  coerced to an object as the Struct field requires). Tool calls dispatch
  through the SAME `invokeTool` seam as the bridge route; status + trace
  events stream to the activity log per call. Scope: **direct chat turns
  only** — capability turns keep their provider server-tool semantics, and
  the interpret route is untouched (its backend speaks plain messages).
- **Union degradation, as decided**: `manifestToToolDefs()` STRIPS any
  binding whose `auth.secrets` env vars aren't configured — per request, the
  model never sees it, nothing 402/503s mid-loop. Defense in depth:
  `runToolDef` never throws; failures return to the model as `{ error }`
  with normalized copy (`ToolError` messages are ours; anything else becomes
  generic copy — raw vendor prose never reaches the model or UI).
- **One-seam metering, as decided**: `invokeTool` (registry.ts) now counts
  every invocation — bridge or chat-loop — into an in-memory counter and a
  debug line shaped for the cost plane:
  `tool_calls_total{tool, fn, pricing, key_alias}`, where `key_alias` is the
  first `auth.secrets` env var *name* (never key material). Per-invocation,
  not per-turn, per the One Agent metering learning.
- **Shape tests** (`tests/tool-defs.spec.ts`, 9 specs, all green): the
  Firecrawl binding driven through the FULL new path against *recorded* v2
  response shapes (defs generated → dispatch → typed result, asserting the
  exact endpoint + bearer header so a dead live key can't mask a protocol
  mismatch), the no-key strip proof, normalized vendor-500 copy, and the
  metering counter increment. CONTRIBUTING_TOOLS.md now requires shape +
  strip tests and carries the normalizer-owns-copy and no-analytics-in-
  bindings rules; TOOLS.md regenerated with the callability note.

**M3 gate** (runtime registration — no fork needed): `TOOL_MANIFEST_URLS`
env loads external manifest JSON; the bridge proxies invocation to the
manifest's declared `endpoint` with an HMAC header. Entry criteria before
building it: (1) manifest schema validation on load (an invalid remote
manifest must be stripped exactly like an unconfigured binding — same
degradation rule, now proven at the defs seam); (2) per-tool rate limits at
the bridge (exists) extended to remote endpoints; (3) allowlist default-OFF
in hosted deployments; (4) the one-seam metering above is the precondition
for letting unreviewed remote tools run at all — unmetered tools are
invisible cost. Remaining from §4: emit one OTEL span per bridge invocation
tagged `tool.id` when an OTLP endpoint is configured.

### 2026-06-11 — M2 hardening: rules enforced at the seam, not just documented

Security pass on the M2 chat-loop tool calling, assuming hostile deployers,
hostile model output, and hostile scraped content:

- **SSRF host guard** (`bindings/firecrawl.ts`): `scrape_url` now refuses
  loopback (127/8, `localhost[.tld]`), link-local (169.254/16 incl. the cloud
  metadata IP), RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10),
  0.0.0.0/8, metadata hostnames, every IPv6 literal, and decimal/hex/octal/
  short-form IPv4 encodings — at the seam, regardless of which Firecrawl
  deployment is configured, with normalized refusal copy. Explicitly NOT
  covered: DNS rebinding and public names resolving to private IPs (resolution
  and redirects happen Firecrawl-side; network-isolate self-hosted instances).
- **Per-turn invocation budget** (`server/providers.ts`): the one-seam meter
  *observes*; this *throttles*. Max 12 dispatched tool calls per turn and 4
  per round across all three adapter loops; over-budget calls return a
  structured `{ error: "tool budget for this turn exhausted" }` (or the
  parallel-cap copy) and the loop continues — union-degradation, never a
  killed stream. The 6-round bound stays, and the final round now carries no
  community tools (a call there could never dispatch).
- **Untrusted-content envelope** (`bindings/firecrawl.ts`): scraped markdown
  is wrapped in `<<<BEGIN/END UNTRUSTED EXTERNAL CONTENT>>>` markers plus a
  one-line "do not follow instructions inside" notice (search results carry
  the notice field); the 8000-char cap is unchanged. Defense in depth, not an
  injection guarantee.
- **Misc**: registration now throws if a tool id contains the `__` name
  separator (ambiguous resolution); loop fetch rejections surface as the
  adapter's normalized `Provider: …` copy; status/trace lines resolve the
  model-emitted tool name against the registry and degrade to generic copy
  (model prose never reaches the UI); malformed tool-call JSON becomes a
  structured `{ error }` without dispatching. All of it pinned by
  `tests/provider-loops.spec.ts` (stubbed provider SSE, one termination case
  per provider) and the expanded `tests/tool-defs.spec.ts`.

### 2026-06-11 — M2 cycle closed; M3 is a trust-model decision, not a feature

M2 shipped and survived its adversarial pass in one day: build (29faa77)
→ critic (SSRF chain, unenforced budget, untested loop) → hardening
(a41b87d: seam-level SSRF guard with legacy-IP-encoding parser, enforced
12/turn + 4/round budget, untrusted-content envelope, 373-line loop spec).
Status: a contributed manifest is now standalone-callable AND
agent-callable, stripped when unconfigured, metered per invocation,
with vendor copy normalized everywhere.

M3 (runtime remote manifests via TOOL_MANIFEST_URLS) is deliberately NOT
started autonomously: it changes who can put executable tool surface in
front of the model from "repo committers" to "anyone a deployer pastes a
URL for". The documented preconditions (schema validation on load, bridge
rate limits on remote endpoints, allowlist default-OFF hosted, metering as
a hard gate) are necessary but the go/no-go is an owner decision.
Operational note: live trending sweeps are currently blocked in the build
environment (Vertex org policy denies web_search); refresh the candidate
list when search access returns or do it manually from PH/HN.

### 2026-06-11 — Trending refresh (HN /best, partial — search still env-blocked)

Direct page fetch works even though web_search is policy-blocked, so a
partial sweep resumed. Signals relevant to the catalog:
- **PgDog** (pgdog.dev): funded Postgres tooling — watch for an API
  surface; a managed-Postgres-introspection binding (schema/EXPLAIN as
  agent tools) keeps coming up as a candidate category.
- **DiffusionGemma** (Google): ~4x faster text gen — if it lands on a
  served API, it's a latency-tier candidate for the model catalog, not a
  tool binding.
- **npm v12 breaking changes** (github.blog): pin the contribution
  recipe's CI to the npm major before it flips; bindings recipe assumes
  lockfile semantics that may shift.
- Platform churn worth tracking for the private side: AWS Bedrock policy
  change around Anthropic-bound data sharing (affects where deployers can
  run BYOK Claude traffic).
Full PH/leaderboard sweep still pending search access; candidates above
are watch-list, not shortlist.

### 2026-06-11 — ElevenLabs TTS binding shipped (`tts`) — first non-text tool; binary-output precedent set

Second BYOK marketplace binding, built strictly by the CONTRIBUTING_TOOLS.md
recipe: `src/lib/tools/bindings/elevenlabs.ts`, one registry entry (id `tts`,
functions `text_to_speech {text, voiceId?}` / `list_voices {}`), one spec file
(`tests/elevenlabs-tts.spec.ts`), TOOLS.md regenerated (5 tools). BYOK on
`ELEVENLABS_API_KEY` (vendor bills per character; free tier 10k chars/mo);
fixed base `ELEVENLABS_BASE_URL || https://api.elevenlabs.io` (no
user-supplied URLs, SSRF n/a). Pinned protocol: `POST
/v1/text-to-speech/{voice_id}` + `GET /v1/voices`, both `xi-api-key` —
shape-tested on recorded responses so a dead key can't mask drift. Default
voice documented in the schema (`21m00Tcm4TlvDq8ikWAM`, "Rachel", premade).

**Binary-output design decision (the precedent for all future
audio/image/file tools).** TTS returns audio bytes; the chat loop
`JSON.stringify`s the ENTIRE tool result into the model's tool_result block
(`providers.ts`), and the bridge route returns the same `invokeTool` result —
the platform had exactly one result channel. 2,500 chars of speech is ~2-3 MB
of mp3 (~3-4 MB as base64): inlining it would blow the context on every call.
Decision, two parts:

1. **Size cap at the seam**: `text` > 2,500 chars is refused up front with
   instructive copy (split into multiple calls) — also keeps one call inside
   a sane slice of the vendor free tier.
2. **Split-channel result via a reserved key**: the manifest contract gains
   `UI_PAYLOAD_KEY = "_ui"` (`src/lib/tools/manifest.ts`). A binding parks
   heavy payloads there (`{ dataUrl, contentType, bytes }`) and keeps every
   other field compact metadata. `runToolDef` strips the key before the
   result reaches the model — the model-visible result is
   `{ voiceId, characters, contentType, bytes, audio: "<omitted: N bytes
   audio/mpeg>" }`, asserted in tests to contain zero base64 and to serialize
   under 500 bytes. The `/api/tools/<id>` bridge route is untouched and
   passes `_ui` through, so UI callers get the playable `data:audio/mpeg`
   URL. Rationale for a reserved key over alternatives: a binding cannot
   tell which caller invoked it (model loop and bridge share the one
   `invokeTool` seam — by design), a model-settable `include_audio` arg
   would let the model pull bytes into its own context, and server-side
   audio storage is out of scope for a marketplace binding. The strip is ~10
   generic lines in `defs.ts`; image/file tools should reuse `_ui` verbatim.
   (Follow-up when a chat-UI audio card lands: `runBudgetedToolCall` could
   additionally surface `_ui` as a stream event, the way provider `image`
   events flow today.)

**Recipe friction findings (CONTRIBUTING_TOOLS.md followed as a third-party
contributor):**

1. **Binary output had NO recipe — and needed a platform change.** The
   "agent-sized output" rule assumes text ("trim to ~20 fields"). A pure
   outside contributor could not have shipped this tool: keeping bytes out of
   the model loop required the `UI_PAYLOAD_KEY` seam in `manifest.ts` +
   `defs.ts`, which the recipe says contributors never touch. Now that the
   seam exists the promise holds again — CONTRIBUTING_TOOLS.md should
   document `_ui` under "Agent-sized output".
2. **Binding filename convention is ambiguous.** Recipe says
   `bindings/<id>.ts`, but the only BYOK example is `firecrawl.ts` with id
   `web_scrape` (vendor-named file, product-named id). Followed the firecrawl
   precedent (`elevenlabs.ts`, id `tts`); recipe should pick one rule.
3. **Nowhere to declare vendor pricing details.** Manifest `pricing` is just
   the `keyless|byok|metered` enum; "per character, 10k chars/mo free" had to
   ride in `display.hint`, which is picker UI copy. A listing-only
   `pricingNote` field would separate catalog metadata from prompt/UI text.
4. **Test-layout contradiction.** Recipe step 3 says to ADD cases to the two
   shared spec files (`tools-registry.spec.ts`, `tool-defs.spec.ts` "as
   template"), while the marketplace pitch is "one binding + one entry +
   tests". A standalone per-tool spec file works (runner globs it) and avoids
   contributor merge conflicts on shared files — recipe should bless that
   explicitly.
5. **The recorded-shape pattern only covers the defs path.** Stubbing
   `globalThis.fetch` works for node-side `runToolDef` tests, but bridge
   tests hit the dev-server process where nothing can be stubbed — so bridge
   dispatch coverage for BYOK tools is forever live-or-skip. Worth stating in
   the recipe so contributors don't try to stub the server.
6. **Checklist wording on `upstream` reads mandatory** ("attribution filled
   for wrapped OSS") but proprietary vendors (ElevenLabs) legitimately omit
   the block; the §0 text is clear, the checklist is not.
7. **Doc drift**: `registry.ts` header still says "All three launch tools are
   open-source, keyless" — now 5 tools, 2 of them BYOK.

Verification: full Playwright suite 73 passed / 3 skipped (live-key tests),
`tsc --noEmit` clean, `eslint .` clean, `next build` clean, `npm run
gen:tools` regenerated.

### 2026-06-11 — Recipe friction items closed in CONTRIBUTING_TOOLS.md

The seven friction findings from the ElevenLabs dogfood are adjudicated:
documented `_ui`/UI_PAYLOAD_KEY under a new "Binary output" rule (model
sees metadata, bridge carries bytes — elevenlabs.ts is the template),
blessed per-tool spec files over shared-spec edits, fixed the
vendor-filename convention wording, made `upstream` explicitly
OSS-wrapping-only, and pointed vendor pricing details at `display.hint`
pending a structured field. Deferred deliberately: a structured
pricing-details manifest field (wants the metering/billing planes to
mature first) and live-or-skip bridge BYOK tests (inherent to not
shipping keys in CI). Registry header drift fixed in 2fc585e.

### 2026-06-11 — `_ui` pipeline closed end-to-end: `tool_ui` stream events + in-chat audio chip

The split-channel precedent from the TTS binding had a last-mile gap: the
model loop correctly stripped `_ui` (defs.ts), but nothing delivered the
payload to the chat client — only direct `POST /api/tools/tts` callers got
the audio, so in-chat TTS was inaudible. Closed (the follow-up the TTS entry
anticipated): `runBudgetedToolCall` now reads the RAW result via
`runToolDefWithUi` (defs.ts; `runToolDef` is a thin wrapper over it) and,
when `_ui` is present AND passes the server whitelist, emits ONE `tool_ui`
StreamEvent `{tool, fn, payload}` alongside the existing status/trace events
— tool/fn registry-resolved, never model prose. The whitelist
(`sanitizeToolUiPayload`, providers.ts) is deliberately narrow in v1:
`{kind: "audio", dataUrl}` only, where dataUrl matches
`^data:audio/(mpeg|wav|ogg);base64,[A-Za-z0-9+/=]+$` and is ≤ ~2 MB
(2.8 M chars); anything else — wrong kind/mime, junk chars, oversize —
is dropped with a `console.warn`, never a stream error, so hostile or
oversized binding output can't reach the wire. Client side: the store
attaches `tool_ui` payloads to the in-flight assistant message
(`message.toolUi`, same extras pattern as `images`/`activity`) and
MessageItem renders an audio chip — native `<audio controls>` with a
"{tool} audio" label, no autoplay. Persistence mirrors inline images:
`data:` payloads are stripped before localStorage (quota), so clips are
session-only by design. The `_ui` pipeline is now end-to-end:
binding → strip → whitelist → SSE → audio chip; next kinds: image,
file-download. Specs in `tests/tool-ui.spec.ts` (stubbed loop + vendor,
whitelist pins, mocked-stream UI render).

### 2026-06-11 — Bridge abuse posture hardened; `_ui` bounds calibrated end-to-end

Critic findings on the `_ui`/bridge/tts surface, fixed:

**Bridge posture (`/api/tools/[tool]` POST).** The route stays
unauthenticated (it's the public bridge) but is no longer drivable from a
hostile page in someone else's browser, and BYOK keys are no longer
single-rate-limit-away from cost-DoS. Three gates, in order, all before any
body read or budget spend: (1) Content-Type must be `application/json` →
415 — this alone kills no-preflight CSRF, since a cross-origin "simple
request" can only be text/plain or form-encoded, and JSON forces a CORS
preflight we never answer; (2) browser provenance headers indicating
another site (`Sec-Fetch-Site: cross-site`, or an `Origin` whose host
mismatches the request Host) → 403 — ABSENT headers mean a programmatic
caller (curl, server-to-server) and are deliberately allowed: a non-browser
client can fake any header, so this check only exists to stop browser
abuse; (3) tools whose manifest declares `auth.secrets` (BYOK-metered:
web_scrape, tts) consume a per-tool hourly budget
(`TOOLS_BYOK_TOOL_LIMIT`, default 60/h) on top of the per-IP burst limit —
charged before dispatch, shared across all callers. Honest limitation:
like the per-IP limiter it is process-local, so a multi-instance deploy
multiplies the ceiling by instance count; a durable global budget needs a
shared store (KV/Upstash). Keyless tools are behaviorally unchanged.

**Cap arithmetic (`TOOL_UI_MAX_DATAURL_CHARS`).** The old 2.8 M-char cap
was below a real worst-case clip: 2,500 input chars ≈ 150–180 s of speech
at 128 kbps (~16 KB/s) ≈ 2.4–2.9 MB of mp3 ≈ 3.2–3.9 M base64 chars.
Raised to 4.2 M (arithmetic in the providers.ts comment). The whitelist
regex is also strict-form now: `[A-Za-z0-9+/]*={0,2}` — padding only at
the end, and the JS end-anchor (no `m` flag) means `…AAAA\n<script>` can
never smuggle a suffix.

**Store bounds (client).** `message.toolUi` appends are bounded at append
time: max 4 clips per message AND max 8.4 M total dataUrl chars (2 ×
the 4.2 M server cap). Policy: refuse the NEWEST clip (console.warn) —
earlier clips are already referenced by streamed prose, so evicting them
would orphan that text. Mirrors the inline-images posture (session-only,
stripped before localStorage).

**Vendor Content-Type pinned (tts).** The ElevenLabs binding no longer
embeds the vendor's Content-Type into the dataUrl verbatim: only
`audio/(mpeg|wav|ogg)` pass; anything else hard-pins `audio/mpeg` (the
requested format) with a warn — defense regardless of which seam consumes
the payload.

Specs: `tests/tools-bridge-security.spec.ts` (direct handler driving: 415,
403, headerless-allowed, per-tool 429 across IPs — offline, no keys),
plus new pins in `tool-ui.spec.ts` (newline/CRLF/padding anchors, store
append bounds) and `elevenlabs-tts.spec.ts` (text/html → pinned
audio/mpeg).

### 2026-06-11 — Surface declared stable; remaining gates are owner decisions

Second hardening cycle (a836b1f) closed same-day: bridge posture
(JSON-only + cross-site 403 + per-tool BYOK budget), store append bounds,
vendor content-type pin, calibrated caps — all test-pinned. The catalog
surface (5 tools, defs seam, _ui pipeline, bridge) is now stable and
critic-converged; further autonomous iteration here would be churn, not
value. Open gates, all owner decisions: M3 remote manifests (trust
model), structured pricing-details field (wants billing plane), image/
file _ui kinds (wants a first consumer tool), and the full trending
sweep (wants search access). Next binding candidates remain fal.ai /
Shovels / Postiz from the shortlist when prioritized.

### 2026-06-11 (later) — Gate check: unchanged

PR #18 (private wave) still open; no owner gate moved. Surface remains
stable per the previous entry; no autonomous work queued by design.

### 2026-06-11 — Trending sweep retried: PH June leaderboard + Show HN (direct fetch)

web_search remains org-policy-blocked; PH/HN page fetches work, so this
is a fuller sweep than the watch-list note above.

Binding candidates (meet the recipe bar — real API, agent-shaped):
- **Publora** (PH): publishing API posting across 10 social networks,
  explicitly agent-first ("via MCP/API, works with Claude/Cursor").
  Directly overlaps the Postiz shortlist slot — evaluate head-to-head;
  whichever has the cleaner BYOK + per-post pricing wins the slot.
- **SpadeBox** (Show HN): sandboxed tooling + JS runtime for agents —
  not a binding, but relevant to the M3 trust model (a sandbox layer is
  one answer to running remote-manifest tools safely).
- **Ory API-key server** (Show HN, OSS Go): self-hostable key management
  — candidate infra for the BYOK story (per-user key vaulting) rather
  than a model-callable tool.
Watch only: HelixDB (graph-on-object-storage; query-tool potential once
hosted), Artie (warehouse replication; enterprise-shaped), Workplane
(agent/human file workspace — competitor signal, not a binding).
Meta-signal: the June PH leaderboard is dominated by agent-NATIVE
products (Publora, SellerClaw, Vokal) — the marketplace thesis (tools
declare agent-readiness via manifest) is the market's direction, not a
bet. Shortlist update: Postiz-vs-Publora bake-off replaces the bare
Postiz slot; fal.ai and Shovels unchanged.

### 2026-06-11 — Bake-off verdict: Postiz takes the social-publishing slot

Evaluated against the recipe bar with per-axis evidence (docs.postiz.com/
public-api, postiz.com/pricing, github.com/gitroomhq/postiz-app; Publora's
own site 403s bots — claims rest on its MIT publora-api-docs repo + PH).

**Postiz** wins on: self-host door (POSTIZ_BASE_URL || api.postiz.com —
the only candidate satisfying the self-host rule; Publora is hosted-only),
OSS maturity (AGPL-3.0, 31.8k stars, 195 releases, explicit 90-100/h rate
limits — AGPL imposes nothing on an HTTP-calling binding beyond the
upstream block), and stability asymmetry (Publora's agent pivot launched
2026-06-10, rate limiting "planned but not currently enforced", free tier
excludes the API). Both auth schemes are equally BYOK-clean (plain key
header; vendor owns the social OAuth) — auth didn't differentiate.

Publora remains the better-priced hosted fallback ($2.99/account vs
$29/mo) with an arguably more agent-shaped API (Zod-enum platforms,
~60-byte results); re-evaluate after months of API stability.

Manifest sketch recorded (id social_post, list_channels + create_post,
secrets [POSTIZ_API_KEY], category social, pricing byok, text-only v1 —
no media, no _ui, no SSRF guard). Blockers before building:
(1) record real fixtures for the settings.__type per-platform mapping and
the type now-vs-schedule body; (2) **owner call — irreversibility**: this
would be the catalog's first tool with public side effects (a
hallucinated create_post publishes to real accounts); decide
schedule-only v1 (require scheduleAt ≥ N min out, cancellable in the
Postiz UI) vs allowing "now"; (3) bridge-budget story for self-hosters
raising API_LIMIT; (4) normalize the vendor's delete-500 bug if
delete_post is ever added.

### 2026-06-11 — Shipped: social_post (Postiz) — the catalog's first public-side-effect tool, schedule-only v1

Built per the bake-off verdict above: `src/lib/tools/bindings/postiz.ts`
(+ registry entry, + `tests/postiz-social.spec.ts`, 18 specs). Two
functions: `list_channels` (GET /public/v1/integrations, trimmed to
{id, platform, name} ≤ 50 rows) and `create_post` (POST /public/v1/posts,
text ≤ 5,000 chars to 1-5 channels). Auth verified from
docs.postiz.com/public-api: raw key in `Authorization` — NO Bearer
prefix. Self-host door honored (POSTIZ_BASE_URL || api.postiz.com).

**Schedule-only rationale (owner blocker (2), resolved conservatively):**
a hallucinated create_post publishes to real accounts, so v1 has NO
"post now" path — `scheduleAt` is required, must parse as ISO, and must
be ≥ 10 minutes out (≤ 1 year); the wire body is always `type:
"schedule"`. The 10-minute window is the user's undo button: the post is
visible and cancellable in the Postiz UI before it goes live, and the
manifest description instructs the agent to say exactly that and never
claim immediate publication. **Allowing `type:"now"` remains an open
owner toggle** — flipping it is a one-line wire change but a policy
decision, deliberately not taken autonomously.

Other safety pins: `settings.__type` is derived server-side from a fresh
/integrations lookup keyed by channel id (model-supplied platform
strings are ignored — spec-pinned); minimal `{__type}` settings only,
with vendor 400s on richer-schema platforms normalized to "Postiz
rejected the post settings for <platform>…" (vendor field names
redacted); all other vendor failures → "Postiz responded NNN".

**Fixture caveat:** the recorded /integrations and /posts shapes are
DOCS-DERIVED (public-api/integrations/list.md + posts/create.md, fetched
2026-06-11) — we hold no Postiz key, so verifying the binding against
live-recorded fixtures is a deploy-time TODO. Remaining open items from
the bake-off blockers: (3) bridge-budget story for self-hosters raising
API_LIMIT (vendor caps ~90-100 create-calls/h, noted in display.hint),
(4) delete-500 normalization if delete_post is ever added; media posts
(POST /upload) and per-platform settings schemas are explicitly out of
v1 scope.

### 2026-06-11 — Hardening pass: one-seam BYOK budget, social category cap, shared-authority rule

Critic findings on the social_post surface, fixed:

**Budget bypass (real bug).** The BYOK hourly budget
(`TOOLS_BYOK_TOOL_LIMIT`, 60/h per tool) lived only in the bridge route
(`/api/tools/[tool]`) — but the chat loop dispatches via
`runToolDefWithUi` → `invokeTool`, which never touched it, so an injected
conversation could schedule posts up to the vendor's ~90-100/h cap. The
budget now lives in `invokeTool` itself (registry.ts) — the registry's
self-described one seam — so bridge calls AND model tool-calls drain the
same `tools:byok:<id>` counter; the route dropped its duplicate check
(its 429 now flows from the seam's `ToolError`, whose `retryAfter`
becomes the Retry-After header). New: `category: "social"` tools get a
tighter default — `TOOLS_SOCIAL_TOOL_LIMIT`, 15/h (posting to real
accounts deserves a smaller blast radius than scraping). Inside the chat
loop a budget refusal surfaces as structured `{ error }` data and the
loop continues (spec-pinned in provider-loops). Still process-local,
like all rateLimit.ts ceilings.

**Shared authority (real bug for multi-user deployments).**
POSTIZ_API_KEY is deployer-scoped: any chat user can list/post to ALL
connected accounts. The manifest now says so plainly (display.hint +
description: one Postiz workspace per deployment, all users share its
connected accounts) and sets `auth.requiresSignIn: true`. Honesty note:
`requiresSignIn` is *declarative* — this repo ships no session system,
so nothing here can enforce it; the flag exists for session-bearing host
apps and as a manifest-level marker. CONTRIBUTING_TOOLS.md gained a
"shared-authority tools" rule: side-effecting BYOK tools must declare
their sharing model.

**Smells.** (1) TZ-less `scheduleAt` is now refused with instructive
copy (a timezone-less ISO string parses in the SERVER's zone — a "6pm"
post could go out at 3am); a trailing `Z` or ±HH:MM offset is required.
(2) The 10-minute schedule lead gained a ~60s skew pad (clock skew +
/integrations lookup latency; user-facing copy unchanged). (3) Postiz
integrations with `disabled: true` are filtered at the shared
`fetchIntegrations` seam — absent from list_channels AND unpostable via
create_post.

Specs added (postiz-social + provider-loops): model-supplied
`type:"now"` still wires as `type:"schedule"`; TZ-less scheduleAt
rejected with zero fetches; no-key forced create_post → normalized
`{ error }`, zero fetches; budget exhaustion at the seam (zero vendor
calls) and mid-chat-loop (loop continues to a clean done); disabled
channel unlisted and unpostable; social default 15/h vs BYOK 60/h.

### 2026-06-11 — Shipped: fal.ai `image_gen` binding + the `image` _ui kind, end-to-end

The shortlist's fal.ai slot lands as `image_gen` (`generate_image
{prompt, model?}` — `src/lib/tools/bindings/fal.ts`), and with it the
second `_ui` kind: **images are now delivered in-chat alongside audio**
(binding `_ui` → server whitelist → `tool_ui` SSE → bounded `<img>` chip
in MessageItem; session-only, same persist-time strip as audio).

**Auth/endpoint findings (docs-fetched 2026-06; WebFetch only — search
is org-blocked):** env var is `FAL_KEY` (fal's documented name), header
is exactly `Authorization: Key $FAL_KEY`. Simplest REST path for a fast
model: the synchronous host — `POST https://fal.run/{model_id}` with the
flat input JSON; result returns on the same connection ("no queue and no
status polling" — fal.ai/docs/documentation/model-apis/inference/
synchronous.md). The queue host (`queue.fal.run`, submit → status →
response GETs) exists for long jobs and is deliberately not used.
Sources: fal.ai/docs/model-apis/quickstart, …/inference/queue.md +
synchronous.md, fal.ai/models/fal-ai/flux/schnell(/api).

**Bytes-vs-URL design:** we send `sync_mode: true` (documented on the
flux schnell schema: media returns as a data URI, not stored in request
history), so the happy path needs no second fetch. If fal returns a
hosted URL anyway, the bytes are fetched server-side ONLY from fal's own
result CDN — https + `fal.media` (or a `.fal.media` subdomain; their
docs' example output host), pinned in `isAllowedResultUrl`. Any other
host in the vendor response is refused with ZERO further fetches
(spec-pinned, including the `fal.media.evil.com` suffix spoof), and the
CDN fetch never carries the API key. That's the SSRF stance: a vendor
response is attacker-influencable input; this binding is not a proxy.

**Model allowlist, never free-form:** `model` accepts exactly
`fal-ai/flux/schnell` (default — ~$0.003/megapixel ≈ $0.003/image at the
default 1024×768) or `fal-ai/flux/dev` ($0.025/image, the only price
fal's pricing doc quotes exactly); anything else — including plausible
fal ids like video models that bill per *second* — is a 400 before any
fetch. A free-form model arg on a BYOK key is an open proxy to
arbitrary-priced models. Pricing reality lives in `display.hint`.

**The image `_ui` kind (the platform half):** `sanitizeToolUiPayload`
now accepts `{kind:"image", dataUrl}` against an anchored
`^data:image/(png|jpeg|webp);base64,…$` regex under the same 4.2 M-char
cap (the binding's own output cap is test-pinned equal to it). `kind` is
REQUIRED for images; the no-kind grandfather path stays audio-only.
**SVG is deliberately excluded and spec-pinned out:** `image/svg+xml` is
a scriptable document format (`<script>`, event handlers,
`foreignObject`) — rendering vendor bytes as SVG in the chat DOM is XSS,
not an image; gif is excluded as merely-unneeded. The client image chip
is a plain CSS-bounded `<img>` (max 420px, registry-resolved tool id as
label/alt, zero payload-driven attributes/handlers — spec asserts no
`on*` attributes). CONTRIBUTING_TOOLS.md's binary-output paragraph now
documents both in-chat kinds.

**Budget choice:** `image_gen` stays `category: "media"` on the generic
60/h BYOK budget (like tts), not the social-style 15/h: generation is
read-only spend on the deployer's key with no shared external authority,
and the worst case is ~$1.50/h (60 × flux/dev) — cost containment, not
blast-radius containment. Spec-pinned via `byokToolHourlyLimit`.

**Fixture caveat (provenance, honestly):** the recorded response shapes
in tests/fal-image.spec.ts are DOCS-DERIVED (the flux schnell output
schema + the queue/quickstart pages), not live-recorded — we hold no
FAL_KEY. Live verification is a deploy-time TODO; the live bridge spec
runs skip-unless-configured. Deferred: more models in the allowlist
(needs per-addition pricing review), image_size/seed args, the queue
path for slow models, and a "remix" affordance on the chip.

### 2026-06-11 — fal.ai image_gen adversarial critic: CLEAN
Independent read-only critic ran every requested attack against 6628ecd and
found NO blocker / no should-fix. Verified concretely: SSRF host-pin rejects
`@`-userinfo (both placements), IDN/punycode, IP-literals (incl.
169.254.169.254), trailing-dot, protocol-relative, http, and `?x=fal.media`
query smuggling — only real `fal.media`/`*.fal.media` over https passes, and
the CDN fallback fetch carries NO Authorization header (key never replayed);
model allowlist refuses path-traversal / url-encoded / leading-slash ids
BEFORE key resolution and before any fetch; image sanitizer blocks
svg/gif/html, uppercase-mime, newline-smuggle, and padding tricks, and the
no-kind grandfather path stays audio-only; budget converges on the single
`invokeTool` seam (no bridge-vs-chat bypass, matching the social_post fix);
FAL_KEY never logged/echoed/returned. Tests assert the load-bearing
properties (would fail if a guard were removed). Two NITs, both argued as
by-design non-holes (bridge returns raw `_ui` to the same trusted caller; the
chat UI only renders sanitized `tool_ui` stream events). Regex is linear — no
ReDoS (4M chars in 24ms, length cap precedes the match).

### 2026-06-11 — Decision: long-running tools need durable async execution, not held-open streams
A tool that can run for minutes (deep research, a document/PDF agent, the "one
agent" loop, a multi-city swarm) MUST NOT execute inside a synchronous
held-open SSE response. We hit this concretely: such runs die with network
errors when a proxy/idle timeout or a client refresh severs the connection,
and the work is lost. The durable shape — already proven by customer_search —
is **launch-job → enqueue (SNS/SQS or any queue) → a worker runs to completion
writing an incremental trace to a job record → client polls /jobs/{id}**. Two
properties make it correct: (1) the run's lifetime is decoupled from the HTTP
connection, so a refresh/disconnect never kills it; (2) the job record carries
the *incremental* trace (thinking + tool_activity + status, not just the final
answer) so a poller reconstructs the full progress after a refresh. Lifecycle
discipline that matters for at-least-once queues: the worker owns
RUNNING→COMPLETED/FAILED and **re-raises on failure** so visibility-timeout/DLQ
retry works, and the job must be **idempotent on redelivery** (no double side
effects). Implication for the marketplace contract: any binding whose worst-
case latency exceeds a few seconds should declare an async/poll mode rather
than assume the request-scoped tool-call budget; the in-chat `tool_ui`/poll
client is the rendering half. (Mirrors the ProperChats one_agent durability
work: server-persisted run trace + a session-gated poll endpoint.)

### 2026-06-11 — Decision: dual-transport migration (sync stream → async job) needs a client that accepts both
When a long-running tool moves from a synchronous held-open stream to the
durable queue+poll model, the client and server don't deploy atomically — the
backend may still stream synchronously in prod while the new async path ships
behind it. The robust pattern is a client that branches on the TRANSPORT it
actually observes, not on a version flag: if the first server event is a
`job` handle, drive the poll loop; otherwise consume the stream as before.
Both paths write the SAME durable run record / resume key, so refresh-resume
and rendering are identical regardless of transport. The server-side opt-in is
a dedicated MARKER token (here: an explicit `one_agent` durable-execution
token sent alongside the capability tokens that still drive tool assembly) —
gating the reroute on a marker rather than inferring it from the toolset keeps
ordinary turns on the synchronous path and makes the async opt-in explicit and
auditable. The marker must be made metering-safe (excluded from billable-tool
counting/strip seams) so adding it doesn't perturb usage accounting. Net: no
flag day, no lost traces across the cutover, and a clean rollback (stop
sending the marker → everything falls back to the stream path).

### 2026-06-11 — Decision: a durable agent run needs a job-id-keyed LINK that polls the queue directly, not just a thread-bound stream/resume
A persisted run trace + a resume poll keyed by the chat turn (chatId/nodeId)
recovers a refreshed thread — but it is still bound to that thread's poll
loop. When the run is an at-least-once queue job that outlives any single
worker (the worker can freeze past its maxDuration while the job keeps going),
the thread-bound poll can be severed and the run drops out of view even though
the job is still progressing. The fix is to give every such turn a LINK keyed
by the upstream JOB ID that polls the job DIRECTLY — a standalone page that
hits a `/job/[jobId]` proxy and folds the job snapshot with the SAME mapper the
in-thread stream uses, so the two surfaces agree byte-for-byte. Three
requirements make it robust: (1) surface the job id to the client from BOTH
the live event AND the durable record's resume path, so the link exists during
the run and survives a refresh; (2) the proxy validates the id shape BEFORE any
upstream fetch and kind-guards the job (so it can only ever serve its own job
kind, never another org/kind through the same endpoint); (3) it rides the
shared credential ladder + transient-vs-terminal 503 contract the other
job-poll pages use, so ownership is enforced by upstream org-scoping and the
page poller only stops on a genuine terminal status. Net: the run is checkable
from any later session by link, decoupled from whether the launching thread's
own poll ever completed.

### 2026-06-11 — Finding: routing Claude through Vertex for cloud credits is ADC-only — an API key (incl. a Gemini key) cannot authenticate Claude-on-Vertex
A tempting cost lever for a multi-model app is "serve our Anthropic models on
Google/Vertex credits by default." But the Anthropic SDK's `AnthropicVertex`
client (read at `anthropic==0.71.0`, `anthropic/lib/vertex/_client.py`) takes
only `project_id`, `region`, `access_token`, `credentials` — there is **no
`api_key` parameter**. Auth resolves through `google.auth.default()` → Google
**ADC** (service account / `GOOGLE_APPLICATION_CREDENTIALS` / workload
identity), and it requires the `anthropic[vertex]` extra (`google-auth`). So:
- A `GEMINI_API_KEY` (or any "express" key) buys you Google's *Gemini* models
  only; it can never pay for *Claude* on Vertex. "Default to a Gemini API key"
  and "route Claude via Google credits" are two different integrations, not
  one — don't conflate them in a fallback ladder.
- Vertex serves Claude under `@`-VERSIONED publisher ids
  (`claude-opus-4-1@20250805`), routed per project+region. A bare model alias
  404s — the id transform must map every served tier to its exact Vertex
  version, and `region` is REQUIRED (not every region carries every model).
- If the service runs on AWS/elsewhere, "use GCP credits for Claude" means
  mounting a GCP service-account credential into non-GCP pods — real infra, not
  a config flag. Cost/shape implication: budget for ADC provisioning, not just
  a project id env var.
Decision rule: pick the lever by what you actually want — cheaper spend by
ANSWERING with Gemini models (gate a Gemini-model fallback on "no usable
Anthropic key", an API-key-only change), vs. keeping Claude quality on Google's
dime (Vertex + ADC + per-tier @-version ids + region, an infra change). They
are not substitutable.

### 2026-06-11 — Correction (validated live): current Vertex accepts the BARE Claude id, and `location=global` is the no-quota-fuss default
Walking back the "@-version map" caveat in the note above — tested against a
real project: `POST .../locations/global/publishers/anthropic/models/claude-opus-4-8:rawPredict`
with an ADC token returned **HTTP 200**. So (a) the **unversioned** model id is
accepted (no `@date` lookup table needed — pass the id straight through), and
(b) the **`global` location** serves the newest Opus immediately, while pinned
regions are spottier: in the same test `us-east5` returned 429 (model enabled
but ~0 quota), `us-central1` "not servable", `us-west1` 404. Note `global`'s
host is the un-prefixed `aiplatform.googleapis.com` (NOT `global-aiplatform…`).
Practical guidance: default the integration to `region=global` + bare id; only
pin a region (and file a quota-increase) when latency or data-residency demands
it. Fastest possible test loop — no pod, no IaC: mint a token in-process
(`google.auth.default(scopes=[cloud-platform]).refresh()`) and `curl`/urllib the
rawPredict URL; 200 vs 404/400 instantly tells you availability + id format.

### 2026-06-11 — Gotcha: downloadable service-account keys are often org-disabled — design for keyless (WIF) from the start
Plan A for "let our pods call a cloud API" is usually "create a service account,
download a JSON key, mount it as a secret." On security-hardened GCP orgs that
**fails**: `gcloud iam service-accounts keys create` returns
`FAILED_PRECONDITION: Key creation is not allowed on this service account` —
the org enforces `constraints/iam.disableServiceAccountKeyCreation`. The policy
is deliberate (downloadable keys are long-lived, exfiltratable, and land in
state/secret stores), and it's exactly what nudges you to the better pattern.
Two ways through:
- **Quick stopgap (admin):** flip the project policy off, mint the one key,
  flip it back on — `gcloud resource-manager org-policies disable-enforce
  iam.disableServiceAccountKeyCreation --project=<p>` … create key …
  `enable-enforce`. Re-enabling does NOT revoke an already-created key (it only
  blocks NEW keys), so the key keeps working. Needs `roles/orgpolicy.policyAdmin`;
  if the constraint is set at the ORG level it must be toggled with
  `--organization=<id>`, not `--project`.
- **Right answer (keyless):** Workload Identity Federation. From AWS/EKS, map the
  pod's existing IAM identity (IRSA) to a GCP WIF pool and impersonate the SA —
  google-auth uses a NON-secret "external account" cred-config file (no key in
  it) to exchange the AWS credential for a short-lived GCP token. Nothing to
  download, nothing to rotate, nothing the key-creation policy blocks.
Design implication: when wiring a cross-cloud integration, assume you may not be
allowed to download a key and budget for WIF/keyless up front — the SDK code is
identical either way (the client reads ADC); only the credential SOURCE differs,
so this is a deploy/IAM decision, not an app-code one.

### 2026-06-11 — Technique: rebasing a stale feature branch — use `--onto` (or squash-first), not a plain `rebase main`
When a feature branch is well behind `main` AND its history includes commits
that already landed in main under different hashes (squash-merge, cherry-pick,
or evolved), a plain `git rebase origin/main` replays those already-merged
commits and explodes into spurious conflicts on files the feature never
touched (here: a swarm commit conflicting with main's evolved version, before
git ever reached the actual feature work). Two clean ways out:
- **`git rebase --onto origin/main <last-commit-before-your-work> <branch>`** —
  replays ONLY the commits after that base, dropping the stale/already-merged
  ones entirely (main already has them). You resolve conflicts only for YOUR
  changes.
- **Squash-first:** `git reset --soft <your-base> && git commit` to collapse
  the feature into one commit, then `rebase --onto origin/main <your-base>`.
  Now each conflicted file is resolved EXACTLY ONCE to its final state, instead
  of re-resolving the same file across an add-commit then a later edit-commit.
Two resolution heuristics that saved time: (a) when an incoming commit only
DELETED code that main already lacks (e.g. reverting a feature main never had),
take `--ours` (main's version) wholesale — the deletion is already done; (b)
when main and the branch added INDEPENDENT blocks at the same spot (an
"adjacency conflict" — two new k8s secrets, two new tf variables, two new env
entries), don't hand-splice the interleaved markers: take `--ours` (main) for
the whole file, then re-insert your additive blocks against known anchors. The
result is provably main + your delta, with no merge-mangled hybrids. Verify the
end state with `terraform fmt -check` / `ruff` / a YAML parse, not just absence
of `<<<<<<<` markers.

### 2026-06-11 — Workflow: stacked PRs — base the child on the parent's BRANCH, and rebase the child with `--onto`
When feature B logically merges after feature A (A is the "foundation"), don't
open both against `main` and eyeball-separate the diffs. Stack them:
- **Open B's PR with `--base <A's head branch>`** (not main). GitHub then shows
  ONLY B's diff (A's changes are the base), and the moment A merges it
  **auto-retargets B to `main`** — no manual rebase at merge time.
- Keep the branches honest with two rebases, in order: (1) rebase the parent
  onto current main and force-push (updates A's PR); (2) rebase the child onto
  the parent with `git rebase --onto <parent-branch> <old-base> <child>` so the
  child is literally `parent + child-commits`. Using `--onto` with the OLD base
  as the cut point replays only the child's own commits — not the parent's,
  which would otherwise double-apply and conflict.
Conflict heuristics that recur when rebasing the foundation onto a moved main:
(a) **adjacency union** — main and the branch each appended an INDEPENDENT block
at the same spot (a new telemetry call vs a new reroute; a new match-case vs a
new one): keep both. (b) **adopt-the-refactor** — if main changed the
surrounding PATTERN (e.g. a dispatch switch moved from inline calls to a
`handler = X` assignment), port your new case into main's new pattern rather
than re-adding the old style; you often inherit a bonus (here the new case
picked up main's tracing wrapper for free). Always validate the result against a
main BASELINE, not just "no \`<<<<<<<\` left": diff the linter error COUNT
before/after (merge should add zero) and confirm no error lands inside your
edited line ranges.

### 2026-06-11 — Trap: a new .py reaching `main` without its bazel target passes `bazel build` but crashes at runtime
A module merged onto main (here: `interpret/tools/usage_metrics.py`, brought in
by an observability merge) was imported by live code (`chat_runner.py`) but
**never got a `py_library` target** in its package BUILD, nor a dep edge from the
importing target. The backend then died at startup with
`ModuleNotFoundError: No module named 'interpret.tools.usage_metrics'` — even
though the `.py` was right there in the source tree. Why it slips through:
**`bazel build` packages a target's declared `srcs`/deps; it does NOT check
Python imports.** A file with no target is simply absent from the binary's
**runfiles**, so the failure only appears when the program actually runs and
imports it. Build-green is not run-green for Python under bazel.
Fix shape: add the `py_library` (`srcs=["x.py"]`, deps mirroring the module's
own imports — chase each `from interpret...import` to its target; watch for
cycles, e.g. ours pulled `//interpret/ai/models:pricing`), then add a dep edge
from every target whose sources import it. **Verify by RUNFILES, not build
status:** `bazel build //path:bin` then confirm
`ls bazel-bin/path/bin.runfiles/_main/<module path>.py` resolves — a green
build alone proves nothing here.
Prevention: a CI smoke target that actually imports the server entrypoint under
its runfiles (`python -c "import interpret.backend.api"`) converts this whole
class of "merged a file, forgot the BUILD wiring" bug from a prod-startup crash
into a CI failure. Also scan after big merges: for each `tools/*.py`, flag any
with no target that is imported anywhere — that's the next time-bomb.

### 2026-06-11 — Finding: OTLP tracing is ~free on the hot path — the real cost is full prompt/completion CONTENT capture, not spans
Worry: "does adding OpenTelemetry slow the backend?" Measured against the code's
actual setup, the answer is no for the request path, with one real exception:
- **Off (endpoint unset) = strict no-op.** Guard `tracing_enabled()` on
  `OTEL_EXPORTER_OTLP_ENDPOINT`; when unset, install nothing — the global tracer
  stays the no-op proxy, so span calls / `set_span_attributes` are ~free and the
  LLM-SDK instrumentors are never attached. Make "unset = silent off" the default.
- **On = negligible latency** because export is async: use `BatchSpanProcessor`
  (NOT `SimpleSpanProcessor`). The request thread only enqueues spans into an
  in-memory buffer; the HTTP POST to the collector runs on a background thread,
  off the hot path. Span creation is microseconds vs. LLM calls measured in
  seconds — it's in the noise.
- **The one genuine cost: content capture.** OpenLLMetry with
  `TRACELOOP_TRACE_CONTENT=true` copies the FULL prompt + completion into span
  attributes. For big agent payloads (multi-step agents, large PDFs, long
  histories) that's real serialization + memory + bigger export bodies. If cost
  matters, set it false (keep timings/token-counts/metadata, drop bodies) and/or
  sample a fraction of traces. This is the only knob that scales with payload.
- **Anti-pattern that LOOKS like "OTEL is slow": endpoint set but collector
  unreachable.** The background exporter retries with backoff and logs an
  exception per flush, and the buffer fills then drops spans — wasted CPU + log
  spam (not request-blocking, but ugly). Fix = point at a reachable collector
  (in dev: `kubectl port-forward` the collector's HTTP receiver — mind the port:
  gRPC 4317 vs HTTP 4318; an HTTP exporter aimed at 4317 fails) or disable.
Decision rule: ship tracing on-by-config, async-batched, content-capture OFF by
default (opt in per-env), and treat "endpoint set but unreachable" as a misconfig
to alarm on, not the steady state.

### 2026-06-11 — Design: a "maximal agent" must grant the UNION of every tool, and native server-tools need wrapping to join the loop
A single max-capability agent ("one ring") is only as capable as its grant
list — and it's easy to ship a curated subset by accident. Two traps surfaced:
- **Registered-but-not-granted.** A toolset can be fully registered in the
  agent's registry yet absent from the agent's grant list (a hardcoded array on
  the client). Result: a tool you built never reaches the loop. Audit the grant
  against the registry, not against memory; the maximal agent's grant should be
  the registry's full applicable set, computed/asserted — not a static subset
  that silently drifts.
- **Provider-native server-tools live on a DIFFERENT plane than in-loop Python
  tools.** web_search / code_execution / url_context are executed by the model
  provider during a single completion ("server tools"), whereas an agent loop
  drives Python tools turn-by-turn. So a maximal agent that only unions its
  Python toolsets is missing the native ones entirely. To put a server-tool on
  the loop, wrap it as a per-call Tool whose body makes a provider completion
  with just that server-tool enabled and returns the result — then it composes
  like any other tool. Critically, gate each on a per-(provider,model) support
  predicate and have the builder self-report not-applicable (return None) when
  unsupported, so the agent degrades gracefully across providers instead of
  hard-failing validation. Net rule: "all tools on one loop" = union(in-loop
  toolsets) + wrapped(native server-tools, per-provider-gated), minus anything
  staged/unsupported — and verify by asserting the assembled harness's token set
  equals that expected union, since a green build never checks grant coverage.

### 2026-06-12 — Gotcha: an agent's tool GRANT originates at the client — registering a toolset server-side isn't enough
A subtle distributed bug surfaced while shipping "all tools on the one agent": after merging the backend change that registers new toolsets (web_search/code_execution/url_context) AND the client change that expands the grant list, a live run STILL showed only the old tools. Root cause: the agent's grant list (`tools:[…]`) is emitted by the CLIENT and merely consumed by the backend — the backend assembles whatever tokens the client sends and can't add a capability the client didn't list. So three things must all be true for a new agent tool to appear: (1) the toolset is registered in the backend, (2) the client's grant list includes its token, AND (3) **the client is actually redeployed** — merging the client change to main does nothing until the user-facing app is rebuilt/shipped. "Merged" ≠ "deployed," and for a client-emitted grant the deploy that matters is the *client's*, not the backend's. Debugging rule: when a just-added capability doesn't show up, read the grant list in the live request log FIRST — if it's the old set, the gap is client deploy, not backend wiring (don't go spelunking the backend registry). Corollary from the same session: external-API objects named content-addressed (e.g. Gemini Files `sha256-<hash>`) collide across rotated/per-identity ownership — a name can be simultaneously "already exists" (409) to a writer and "forbidden" (403) to a reader when a different key owns it; deterministic names need a unique-fallback escape hatch, not just a get-or-create.

### 2026-06-12 — Root cause + design: a "large PDF" attachment fails SILENTLY because the chat path inlines it, and the fix is an agentic document session, not a bigger context window
Attaching a big PDF (~30–60MB / ~600 pages) to a chat looked attached (a "pdf"
chip), sent fine, and the model answered with zero knowledge of the doc — no
error, no log. Three compounding causes, each independently silent:
- **Inline-to-provider ceiling.** The chat route base64-inlines the PDF into one
  completion. Providers cap PDFs hard (Anthropic: 32MB / 600 pages, 100 pages on
  200k-ctx models) and reject past that. One inference call can never "read" 600
  pages — that's the wrong primitive, not a tuning problem.
- **Upload misroute → invisible drop.** The >4.2MB path used a generic presign
  to the wrong bucket with a 50MiB cap; on any failure it fell back to an inline
  `data:` URL, and for >20MB that became an empty URI — the attachment vanished
  with a success-looking UI. Lesson: an upload "fallback" that yields an empty
  reference is worse than a thrown error; degrade paths must surface, not swallow.
- **No RAG anywhere.** There is no vector store / retrieval in the stack
  (`file_search` is a staged, unsupported token), so "let the model search the
  doc" can't be a retrieval call.
Design rule (matches how SOTA systems handle big PDFs — incremental reading, not
context-stuffing): detect "large" on attach, and route to an **agentic document
session** that *walks* the PDF on demand — read N pages, find-text, get-chunks,
OCR, and a single `get_full_document_text` as the explicit transcribe path —
driven by the user's prompt turn-by-turn, with the PDF referenced by durable
`s3://` (per-user prefix), never inlined into the chat tree (which syncs to S3 as
deltas — 600 pages of text in a message would balloon every sync). Two user
intents to expose: (1) think about the doc agentically, (2) parse to text. The
agentic harness for this often ALREADY exists server-side and just isn't reachable
from the chat route with a request-attached file — the missing piece is one
bridge: turn an attached `media[]` PDF into a registered `doc_id` in a document
context the agent loop can address. Ship the client-side make-it-visible +
durable-upload half first (it's independent and de-risks the rest by converting a
silent failure into a legible one) before the backend capability.
