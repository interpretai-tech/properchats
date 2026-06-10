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
