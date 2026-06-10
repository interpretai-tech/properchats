# ProperChat Public Tool Ecosystem

How ProperChat's capability system works today, and a proposed manifest contract
that turns it into a pluggable tool ecosystem where third-party tools slot in
without core changes. The worked example is **mail** (physical letters), shown
bound to two interchangeable external providers.

Status: design document only. Nothing in this doc changes runtime behavior.

File references use two prefixes:

- `public:` — this repository (`interpretai-tech/properchats`), commit `6722131`.
- `private:` — the full private deployment (`interpretai-tech/properchat`,
  commit `f2807a5`), which carries the larger capability catalog this design
  generalizes. Line numbers are anchored to those commits.

---

## Part 1 — The architecture as it exists

ProperChat does not have a "plugin system" today, but it already has every seam
one needs. A capability flows through six fixed stations:

```
Capability id ──> CAPABILITIES registry ──> CapabilityPicker (UI)
      │
      ▼
POST /api/chat ──> sign-in + tier gate (CAPABILITY_POLICY) ──> interpretStream
      │                                                            │
      │                                  tools: ["<token>"] ───────┘
      ▼                                                            ▼
StreamEvent protocol <── IAI agent runtime (toolset) <── external API (e.g. PostAgent)
      │
      ▼
UI surfaces (prose / message card / full-page viz) + post-stream metering
```

### 1.1 The capability id (the union type)

Every tool is first a string literal in one union:

- `public:src/lib/types.ts:23` — `Capability = "chat" | "web_search" | "image" | "deep_research" | "code"`
- `private:src/lib/types.ts:24-34` — the full set adds `url_context`,
  `document_agent`, `submittal_review`, `customer_search`, `mail`.

This id is the wire token in the `/api/chat` body, the persistence token on
every assistant `Message.capability`, and the key into every table below.

### 1.2 The registry (display metadata)

`CAPABILITIES: CapabilityMeta[]` is the secret-free catalog shared by client
and server:

- `public:src/lib/capabilities.ts:17-65` — `CapabilityMeta { id, label, hint, icon, providers }`.
- `private:src/lib/capabilities.ts:38-130` — same shape; the `mail` entry is at
  lines 116-129 (`label: "Mail"`, `hint: "Draft and send a physical letter —
  priced quote with a payment link"`, `icon: "Mail"`).

Legacy ids are normalized through one alias map + validator
(`normalizeCapability`, `private:src/lib/capabilities.ts:141-157`) so renames
never crash persisted chats — a property any plugin system must keep.

### 1.3 The picker (UI discovery)

`CapabilityPicker` renders the registry verbatim; there is no per-tool UI code
in the picker itself:

- `public:src/components/CapabilityPicker.tsx:115-116` — `CAPABILITIES.map(...)`
  with `capabilityAvailable(meta.id, avail)` deciding enablement.
- `private:src/components/CapabilityPicker.tsx:59-60,193-217` — same, plus a
  stable/experimental split and availability that also consults `ServerConfig`
  flags (e.g. `cfg.ssc` for submittal review,
  `private:src/lib/capabilities.ts:342-361`).

### 1.4 Dispatch: capability → agent tool token

The single most important seam. A capability is mapped to an **IAI native-tool
token**, and the token is the only thing sent upstream:

- `private:src/lib/capabilities.ts:295-331` — `capabilityInterpretTool(cap)`:
  `web_search → "web_search"`, `code → "code_execution"`,
  `deep_research → "deep_research"`, `customer_search → "customer_search"`,
  `mail → "mail"`. `chat`/`image` return `undefined` (no tool needed).
- `private:src/lib/server/providers.ts:416` resolves the token;
  line 439 forwards it: `...(interpretTool ? { tools: [interpretTool] } : {})`
  in the POST body to `INTERPRET_BASE/api/v1/ai/models/messages/stream`
  (`interpretStream`, `private:src/lib/server/providers.ts:396-530`).

Everything tool-specific — the agent loop, the external API client, the
secrets — lives behind that token in the IAI ("Sauron") runtime, *not* in
ProperChat. ProperChat's server never holds a PostAgent credential. This is
the property that makes tools swappable: the frontend contract is one string.

The public repo keeps a trimmed `interpretStream`
(`public:src/lib/server/providers.ts:152`) plus direct provider adapters with
their own native tools (`public:src/lib/server/providers.ts:258-315`).

### 1.5 The streaming contract

Every adapter (interpret or direct) emits one unified `StreamEvent` protocol:

- `public:src/lib/types.ts:130` / `private:src/lib/types.ts:265-298` —
  `start | delta | reasoning | trace | status | image | sources | companies |
  job | done | error`.

Two members matter for tools:

- `trace` — a durable tool step ("Searched the web for …"). Customer search
  even uses a trace line as a *committed contract*: the client detects
  `"Launched customer-research agents — job swarm-run-…"` to attach a pollable
  run (`private:src/lib/types.ts:117-128`).
- `done.usage.toolActivity` — names of tools that actually ran, threaded from
  the backend's `usage.tool_activity`
  (`private:src/lib/server/providers.ts:373-391,501-516`). This drives
  **post-stream metering** (1.7).

### 1.6 UI surfaces (three tiers of rendering)

Tools render at three escalating levels, all optional:

1. **Prose only** — mail today. `send_mail` returns payment/preview URLs that
   the agent writes into the assistant's markdown
   (`private:src/lib/capabilities.ts:117-129`). Zero custom UI.
2. **Message card** — a structured payload persisted on the `Message` rides
   normal tree/delta sync and renders a card:
   `Message.companies` → `CompanyList`
   (`private:src/components/MessageItem.tsx:189`),
   `Message.job` → submittal status card
   (`private:src/components/MessageItem.tsx:364-448`),
   `Message.runJob` → `CustomerSearchRunViz`
   (`private:src/components/CustomerSearchRunViz.tsx`, 401 lines, live-polled).
3. **Full-page visualization route** —
   `private:src/app/tools/visualizations/customer-search/[jobId]` and
   `.../submittal-review/[jobId]` (+ `/pdf`, `/details`), backed by poll/proxy
   API routes under `private:src/app/api/tools/`.

### 1.7 Limits, gating, and billing

One tunable table prices every expensive tool:

- `private:src/lib/server/limits.ts:83-110` — `CAPABILITY_POLICY`: one row per
  metered capability, one cell per tier (`number | "blocked" | "unmetered"`),
  env-overridable per cell (`${TIER}_${CAP}_LIMIT`,
  `private:src/lib/server/limits.ts:128-133`). The mail row (line 109):
  `{ free: "blocked", basic: "blocked", monthly: 5, insane: 5 }` — Pro-gated,
  5 letters/month.
- `private:src/lib/server/gate.ts:230-321` — `enforceCapabilityPolicy` drives
  entirely off that table: `blocked` → 402 `<cap>_requires_upgrade`; numeric →
  check-and-increment → 402 `<cap>_quota_exceeded`.
- Mail uses **success-only metering**: the gate arm is a read-only pre-check
  (`private:src/lib/server/gate.ts:276-299`); the letter is consumed
  post-stream only when `done.usage.toolActivity` matches `/^send_mail\b/`
  (`meterMailOnSend`, `private:src/lib/server/gate.ts:323-349`), wired in the
  chat route at `private:src/app/api/chat/route.ts:786-802`. A read-only
  `get_mail_status` turn never decrements the allowance.
- Sign-in is enforced per capability via `SIGN_IN_COPY`
  (`private:src/app/api/chat/route.ts:61-70`): metered tools need an identity.

### 1.8 The mail capability end-to-end (today's PostAgent binding)

1. User picks **Mail** in the picker (registry entry, 1.2).
2. `/api/chat` body carries `capability: "mail"`; route normalizes it
   (`private:src/app/api/chat/route.ts:345`), enforces sign-in + the
   CAPABILITY_POLICY pre-check.
3. `interpretStream` sends `tools: ["mail"]` to the IAI messages/stream API.
4. The IAI Sauron runtime's `mail` toolset (`send_mail` / `get_mail_status`)
   calls the **PostAgent REST API**: `send_mail` uploads the drafted markdown
   letter and **locks a priced quote**, returning a Stripe `checkout_url` and
   a preview URL (PostAgent also exposes an x402 machine-payment rail). It
   never auto-pays — the user opens the payment link themselves.
5. The agent streams prose containing those URLs; `done.usage.toolActivity`
   names `send_mail`; ProperChat meters one letter.

Note what ProperChat knows about PostAgent: **nothing**. No client, no key, no
URL. The entire binding is the string `"mail"` plus a metering regex. That is
the seam the rest of this document formalizes.

---

## Part 2 — The proposed public tool ecosystem

### 2.1 Design goals

1. **One manifest, six stations.** A tool declares everything Part 1 spreads
   across five files (union, registry, tool-token map, policy table, sign-in
   copy) in a single object.
2. **The core stays one agent loop.** A tool is a *toolset appended to the
   existing IAI agent runtime* (or a webhook the runtime calls) — never a new
   per-tool orchestrator. ProperChat's chat route stays generic.
3. **Swappable external providers.** Two manifests with the same `id` but
   different bindings must be interchangeable with zero core changes (Part 3
   proves this with mail).
4. **Unbreakable persistence.** Ids are forever; renames go through the alias
   map (1.2). Unknown manifest output degrades to prose.

### 2.2 The manifest contract

```ts
/** docs-only sketch; would live at src/lib/tools/manifest.ts */

export interface ToolManifest {
  // ── Identity ─────────────────────────────────────────────────────────────
  /** Wire token. Persisted on messages forever — never reuse or rename
   *  (add to LEGACY_CAPABILITY_ALIASES instead; see capabilities.ts). */
  id: string;
  /** Replaces ids this tool supersedes (merged into the alias map). */
  aliases?: string[];

  // ── Display (today: CapabilityMeta, capabilities.ts) ────────────────────
  display: {
    label: string;            // picker row, message tag suffix
    hint: string;             // one-line picker hint
    icon: string;             // lucide-react icon name
    experimental?: boolean;   // picker section split
  };

  /** System-prompt blurb teaching the agent when/how to use the toolset. */
  description: string;

  // ── Invocation binding (today: capabilityInterpretTool) ─────────────────
  /** Exactly one of: */
  binding:
    | {
        kind: "iai-toolset";
        /** Native-tool token forwarded as tools:[token] to messages/stream
         *  (providers.ts interpretStream). The toolset is registered in the
         *  IAI runtime's registry + SAURON_TOOLSETS. */
        token: string;
      }
    | {
        kind: "webhook";
        /** ProperChat-hosted bridge: the IAI runtime is given a generic
         *  remote-tool token and POSTs tool calls to this endpoint, which
         *  proxies the third-party API with secrets resolved server-side. */
        endpoint: string;                 // e.g. "https://tools.example.com/mail"
        functions: WebhookFunctionDecl[]; // JSON-schema'd tool functions
      };
  /** Providers/tiers that can host the agent turn (CapabilityMeta.providers). */
  providers: ("anthropic" | "openai" | "gemini")[];

  // ── Auth & secrets ───────────────────────────────────────────────────────
  auth: {
    /** Adds the id to SIGN_IN_COPY (chat route) → 401 + requiresAuth. */
    requiresSignIn: boolean;
    /** Env var names the binding needs server-side (values NEVER appear in
     *  the manifest; deployment supplies them — cf. ServerConfig.ssc flag). */
    secrets?: string[];
    /** ServerConfig boolean exposing "configured on this server" to the
     *  picker, like cfg.ssc does for submittal review. */
    configFlag?: string;
  };

  // ── Limits / billing (today: a CAPABILITY_POLICY row) ───────────────────
  policy: {
    /** Per-tier monthly allowance; env-overridable as ${TIER}_${ID}_LIMIT. */
    allowance: Record<"free" | "basic" | "monthly" | "insane",
                      number | "blocked" | "unmetered">;
    /** When to consume one unit:
     *  - "per-turn":   atomic check-and-increment in the gate (deep_research)
     *  - "on-success": read-only pre-check, consume post-stream when
     *                  done.usage.toolActivity matches meterOn (mail)
     *  - "on-accept":  consume after an async job is accepted upstream
     *                  (submittal_review). */
    meterMode: "per-turn" | "on-success" | "on-accept";
    /** Tool-name regex source for on-success mode (e.g. "^send_mail\\b"). */
    meterOn?: string;
    /** Own validated provider key exempts metering (deep_research only today). */
    ownKeyExempt?: boolean;
    /** Stripe credit packs extend past the allowance (submittal_review). */
    creditsFallback?: boolean;
    /** 402 copy: BLOCKED_COPY / QUOTA_COPY rows in gate.ts. */
    blockedCopy?: string;
    quotaCopy?: string;
  };

  // ── UI slots (all optional; absent ⇒ prose-only like mail today) ────────
  ui?: {
    /** Message-card renderer keyed by a structured payload the tool emits
     *  (a StreamEvent the store persists onto the Message, like companies/
     *  job/runJob). The renderer registers into MessageItem's card switch. */
    card?: {
      /** StreamEvent type + Message field this card consumes. */
      payloadKey: string;        // e.g. "mailQuote"
      component: string;         // e.g. "components/tools/MailQuoteCard"
    };
    /** Full-page viz route mounted under /tools/visualizations/<id>/[jobId],
     *  with poll/proxy API routes under /api/tools/<id>/. */
    vizRoute?: { page: string; api?: string[] };
    /** Durable-trace pattern that attaches a pollable job to the message
     *  (the customer_search "Launched … job swarm-run-…" contract). */
    jobTracePattern?: string;
  };
}
```

### 2.3 Lifecycle: register → discover → invoke → render → meter

| Phase | Core mechanism (all existing code) |
|---|---|
| **Register** | Manifest added to a `TOOL_MANIFESTS` array; build step derives the `Capability` union member, `CAPABILITIES` entry, alias map rows, `CAPABILITY_POLICY` row, `SIGN_IN_COPY` row, and (for `iai-toolset`) asserts the token exists upstream — the deploy-order rule documented at `private:src/lib/capabilities.ts:308-325` becomes a CI check. |
| **Discover** | Picker renders the derived registry (1.3); `auth.configFlag` greys un-configured tools exactly like `cfg.ssc` does. |
| **Invoke** | Chat route normalizes the id, applies the gate from `policy`, and `interpretStream` forwards `binding.token` (or the webhook bridge token). No per-tool branches in the route. |
| **Render** | Stream events flow as today; if `ui.card.payloadKey` matches a structured event, the store persists it on the `Message` and `MessageItem` dispatches to the registered card; otherwise prose. |
| **Meter** | `policy.meterMode` selects one of the three existing metering shapes (gate consume / `meterMailOnSend`-style post-stream / post-accept consume) — all already implemented generically enough to be parameterized by `meterOn`. |

---

## Part 3 — Worked example: MAIL, twice

The point of the contract: the same `id: "mail"` bound to two different
external providers, with identical core behavior.

### 3.1 Manifest A — today's PostAgent binding (user-paid, quote + link)

```ts
const mailViaPostAgent: ToolManifest = {
  id: "mail",
  display: { label: "Mail", icon: "Mail",
    hint: "Draft and send a physical letter — priced quote with a payment link" },
  description:
    "send_mail uploads the drafted markdown letter to PostAgent and LOCKS a " +
    "priced quote, returning payment (Stripe checkout_url; x402 machine rail) " +
    "and preview URLs. Never auto-pays — the user opens the link. " +
    "get_mail_status is read-only.",
  binding: { kind: "iai-toolset", token: "mail" }, // registered in IAI Sauron
  providers: ["anthropic", "openai", "gemini"],
  auth: { requiresSignIn: true },        // secrets live in the IAI runtime,
                                         // not in ProperChat → no `secrets`
  policy: {
    allowance: { free: "blocked", basic: "blocked", monthly: 5, insane: 5 },
    meterMode: "on-success",
    meterOn: "^send_mail\\b",            // quote lock = the send attempt
    blockedCopy: "Sending physical mail is a Pro feature. …",
    quotaCopy: "You've used all your mail letters for this month …",
  },
  // no `ui` — payment/preview URLs render in the assistant's prose
};
```

Every field above is a fact in the private codebase today:
the token (`private:src/lib/capabilities.ts:317-325`), the policy row
(`private:src/lib/server/limits.ts:103-109`), the meter regex
(`private:src/lib/server/gate.ts:324`), the copy
(`private:src/lib/server/gate.ts:180-181,194-195`), the sign-in row
(`private:src/app/api/chat/route.ts:64`).

### 3.2 Manifest B — a Lob binding (platform-paid, billed as credits)

[Lob](https://www.lob.com) is a print-and-mail API where the **platform** holds
the API key and is invoiced per piece — there is no per-letter checkout link to
hand the end user. So a Lob binding flips two knobs and adds a card:

```ts
const mailViaLob: ToolManifest = {
  id: "mail",                            // same wire token: old chats still render
  display: { label: "Mail", icon: "Mail",
    hint: "Draft and send a physical letter — billed to your plan" },
  description:
    "create_letter renders the drafted letter via Lob (PDF/HTML template), " +
    "addresses it, and submits it for printing. Returns a Lob letter id and " +
    "a thumbnail preview. cancel_letter works until the send window closes.",
  binding: {
    kind: "webhook",                     // Lob client lives in a ProperChat-
    endpoint: "/api/tools/mail-lob",     // hosted bridge, not the IAI runtime
    functions: [/* create_letter, get_letter, cancel_letter (JSON schema) */],
  },
  providers: ["anthropic", "openai", "gemini"],
  auth: {
    requiresSignIn: true,
    secrets: ["LOB_API_KEY"],            // platform-billed → platform-held key
    configFlag: "mailLob",               // greys the picker if unset (cf. cfg.ssc)
  },
  policy: {
    allowance: { free: "blocked", basic: "blocked", monthly: 5, insane: 5 },
    meterMode: "on-success",
    meterOn: "^create_letter\\b",        // platform pays Lob ⇒ metering IS billing
    creditsFallback: true,               // letters past 5/mo via Stripe credit packs
  },
  ui: {
    card: { payloadKey: "mailLetter",    // letter id + status + thumbnail
           component: "components/tools/MailLetterCard" },
  },
};
```

### 3.3 What changed, and what didn't

| Station | PostAgent (A) | Lob (B) | Core change |
|---|---|---|---|
| id / persistence | `"mail"` | `"mail"` | none |
| picker entry | from manifest | from manifest | none |
| invocation | IAI token `"mail"` | webhook bridge | none — both are `binding` values |
| who pays the carrier | end user (quote → checkout_url) | platform (Lob invoice) | none — `meterMode`/`creditsFallback` |
| metering trigger | `send_mail` ran | `create_letter` ran | none — `meterOn` |
| secrets | inside IAI runtime | `LOB_API_KEY` in bridge env | none — `auth.secrets` |
| rendering | prose links | letter card | none — `ui.card` registration |

The chat route, gate, picker, stream protocol, and persistence are untouched in
both columns. That is the slot-in property.

---

## Part 4 — Checklist: slotting in a new tool

A hypothetical **calendar** tool (read availability, draft invites):

1. **Pick a permanent id** — `"calendar"`. Never reused; renames go through
   the alias map.
2. **Choose a binding** — an IAI toolset token if the agent logic belongs in
   the shared runtime (`get_availability`, `draft_invite`), or a webhook bridge
   if the provider SDK (Google/Microsoft) should stay in ProperChat's deploy.
3. **Write the manifest** — display, description (the agent's usage contract),
   providers, `auth` (`requiresSignIn: true`; OAuth client secrets in
   `secrets`; a `configFlag` so unconfigured servers grey the picker).
4. **Price it** — one `allowance` row. Cheap read-only tools can be
   `"unmetered"`; anything that costs real money picks a `meterMode`:
   `on-success` + `meterOn: "^create_event\\b"` means browsing availability is
   free and only booked events meter (the mail precedent).
5. **Decide the UI tier** — start prose-only; add a `ui.card` when there is a
   structured payload worth persisting (an event confirmation); add a
   `vizRoute` only for long-running/job-like output (the customer-search bar).
6. **Mind deploy order** — for an `iai-toolset` binding the runtime carrying
   the token ships before or with the frontend, or the turn 400s after the
   gate consumed allowance (`private:src/lib/capabilities.ts:308-315`); the
   register-phase CI assertion exists to catch exactly this.
7. **Test the three failure modes** — blocked tier (402 copy), exhausted
   allowance (402 with used/limit), unconfigured server (greyed picker) — all
   derivable from the manifest, so they can be table-driven tests.

That's the whole surface: one manifest, no edits to `/api/chat`, the gate, the
picker, or the stream protocol.
