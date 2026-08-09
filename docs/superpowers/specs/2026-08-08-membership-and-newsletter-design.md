# Membership, Paid Classes & Newsletter — Design

**Date:** 2026-08-08
**Status:** Approved by user, pending implementation plan

## Motivation

The site currently has no way to charge for anything (`classes.price` is a display-only string; `class-signups` just records a free RSVP) and no way to gate content to paying customers. This design adds:

1. A Buttondown-backed newsletter signup on the contact page (the original ask).
2. Real payment collection for classes that have a price.
3. A membership status, granted permanently to anyone who has ever paid for a class, that unlocks a gated content library.

These three pieces are largely independent and can be built/shipped in any order, but membership depends on paid classes existing first (there's nothing to grant membership *from* otherwise).

## Non-goals

- No recurring/subscription billing. Membership is a one-time-unlock, permanent status — no expiry, no cancellation flow, no Stripe subscription objects.
- No standalone "buy membership directly" product. The only door in is paying for a class.
- No member discount on class pricing. "Member" is a status derived from having paid, not a pricing tier.
- No changes to free class signup — it keeps today's RSVP-only flow untouched.
- Buttondown is newsletter-only. It is not used for transactional email (magic links, invites) — those go through EmDash's own configured email transport.

## Architecture overview

```
Visitor pays for a class
        │
        ▼
Stripe Checkout Session (one-time payment, amount = classes.price_cents)
        │
        ▼ (webhook: checkout.session.completed)
class-signups plugin
        │
        ├─► records the signup (existing capacity/dedupe logic)
        └─► if payer's email has no EmDash user yet:
                 calls EmDash's invite API, role = Subscriber (10)
                         │
                         ▼
            EmDash emails an invite → visitor registers a passkey
            (magic-link fallback, exactly like admin login)
        │
        ▼
Visitor is now a permanent member. Returning members log in at
/members/login using EmDash's own passkey/magic-link REST endpoints.
        │
        ▼
Gated pages (/dispatches/[slug]) check the visitor's session role
(≥ Subscriber) before including member-only content in the response.
```

The newsletter is unrelated to this flow — it's a simple plugin route on the contact page.

## Component 1: Newsletter plugin (Buttondown)

A new sandboxed plugin, `newsletter`.

- **Settings:** one `admin.settingsSchema` field, `apiKey` (type `secret`) — the Buttondown API key, entered once in **Admin → Plugins → newsletter** and encrypted at rest by EmDash (same mechanism used for other plugin secrets).
- **Route:** `subscribe` (`POST /_emdash/api/plugins/newsletter/subscribe`), public. Accepts `{ email }`, calls Buttondown's subscribers API with the stored key, returns `{ success: true }` or `{ success: false, error }` (per the project's established plugin convention — thrown `Response` objects become opaque 500s, so failures must be returned, not thrown).
- **Frontend:** a second form added to `src/pages/contact.astro`, alongside the existing message form (confirmed placement: contact page only). Unlike the existing message form — which posts back to `/contact` itself and re-renders server-side — the plugin's `subscribe` route lives at a separate JSON endpoint (`/_emdash/api/plugins/newsletter/subscribe`), so a plain HTML form post would navigate the browser to a raw JSON response instead of showing an inline result. This form needs client-side `fetch` (a small inline `<script>`) to call the route and swap in a success/error message without a page reload — the implementation plan should check how `class-signups`' own frontend calls its plugin routes and follow the same pattern for consistency.
- **Failure handling:** if Buttondown's API errors or is unreachable, the route returns `success: false` with a user-facing message ("Something went wrong, try again"); it must not throw and must not affect the existing contact-message form on the same page.

No changes to any existing collection or plugin are needed for this piece.

## Component 2: Paid classes (Stripe)

### Schema change

Add `price_cents` (integer, optional) to the `classes` collection. `price` (the existing free-form display string, e.g. `"$120"`, `"Sliding scale $80–150"`, `"Free"`) is unchanged and stays the source of truth for *display*. `price_cents` is the source of truth for *billing*:

- `price_cents` unset or `0` → free class, today's flow is untouched (direct RSVP via the existing signup endpoint, no Stripe involved).
- `price_cents` set to a positive integer → paid class, goes through Checkout.

### Extending `class-signups`

The plugin's signup route branches on whether the target class has `price_cents` set:

- **Free class:** unchanged — validates capacity/close-time, records the signup, returns availability, exactly as it does today.
- **Paid class:** applies the same capacity/close-time check as the free path *before* creating a Checkout Session (`mode: "payment"`, amount = `price_cents`, metadata carrying `classId`, `name`, `email`, `notes`) and returns the session URL for the browser to redirect to. The signup is **not** recorded yet at this point — only after payment succeeds. This pre-check narrows but does not eliminate overselling: a class can still fill up in the window between Checkout Session creation and the webhook confirming payment (two people checking out concurrently for the last spot). When the webhook's own capacity check fails after a successful charge, the signup is **not** silently dropped — it's recorded in an "oversold, needs resolution" state surfaced on the plugin's admin page, since there is no automated refund flow in this design; resolving it (refund or manual capacity exception) is a manual step for Jess.

### Stripe webhook handler

A new plugin route, `webhooks/stripe`, receiving `checkout.session.completed` events (Stripe's standard webhook signature verification against a stored `webhookSecret`, both `apiKey` and `webhookSecret` added as `secret` settings fields alongside the plugin's existing settings). The route must be marked `public: true` — like the existing `signup`/`availability` routes — since Stripe's webhook requests carry no EmDash session or admin token.

**Open question for the implementation plan (higher-risk than the ones below):** Stripe's signature verification (`stripe.webhooks.constructEvent`) requires the exact raw, unparsed request body — EmDash's plugin route dispatcher appears to parse POST bodies into `routeCtx.input` via a Zod schema before the handler runs. Whether/how a sandboxed route can get at the raw body needs to be confirmed against the current plugin API before this is buildable as described; if there's no raw-body access, this may need to be a native (not sandboxed) plugin route instead.

**Second open question:** this project's non-GET plugin routes normally require the `X-EmDash-Request` header or a matching `Origin` to pass CSRF checks (see CLAUDE.md's plugin quirks). Stripe's webhook requests will carry neither. Marking the route `public: true` addresses session/token auth, but the plan needs to confirm separately whether `public: true` (or some other flag) also exempts a route from the CSRF check — otherwise Stripe's deliveries will be rejected before the handler's own signature verification ever runs.

On receipt:

1. Verify the Stripe signature. Reject (400) if invalid.
2. Look up the checkout session's metadata (`classId`, `name`, `email`, `notes`).
3. **Idempotency:** Stripe may redeliver webhooks. Before recording anything, check whether a signup already exists for this `(classId, email)` pair (existing dedupe-by-email logic already does this) or whether this specific Stripe session ID has already been processed (store the session ID against the signup record). If already processed, return success without side effects.
4. Record the signup (same capacity/dedupe path as free classes, now confirmed-paid).
5. Check whether an EmDash user already exists for this email.
   - If not, call EmDash's user invite endpoint with `role: 10` (Subscriber). This triggers EmDash's own invite email (passkey registration, magic-link fallback) — no email-sending code of our own needed.
   - If a user already exists (they're already a member, or already have some other role), do nothing — an existing Editor/Admin who buys a class doesn't get demoted or re-invited.
6. Log failures (e.g., invite call fails) rather than throwing, and surface them somewhere Jess can see (plugin admin page, same pattern as the existing signups list) so she can manually invite the payer from **Settings → Users** as a fallback — the payment and signup record are the source of truth either way.

Signup records gain two new pieces of state beyond what's tracked today: the originating Stripe session ID (for idempotency) and, for the rare oversold case, a resolution status the admin page surfaces. These live in the plugin's existing (schemaless) storage alongside the current signup fields — no separate collection needed.

**Open question, but treat the fallback as the likely primary path, not a worst case:** the documented sandboxed-plugin capability surface only lists read access to users (`users:read` — `get`/`getByEmail`/`list`), with no write/invite capability. So the plan should assume the webhook handler will need to call EmDash's own REST API (`POST /_emdash/api/auth/invite`) via `ctx.http.fetch`, using a stored admin personal access token — not as a fallback, but as the design. This has knock-on requirements not yet reflected elsewhere in this doc:

- The plugin needs a `network:request` capability with an `allowedHosts` entry for the site's own domain.
- The admin PAT used to call the invite endpoint is itself a secret and must be added as a `secret` settings field (see Data Model summary below), rotated the same way other plugin secrets are.
- Confirm the `/api/auth/invite` endpoint's exact request/response shape and auth requirements (it's documented as an admin-panel action; confirm it accepts PAT bearer auth, not just an admin session cookie) before implementation.

### Class detail page

`src/pages/classes/[slug].astro` needs to branch its signup form the same way: if `price_cents` is set, submitting the form redirects to the Stripe Checkout URL the plugin returns instead of showing an inline success message; free classes behave exactly as today.

## Component 3: Gated content library

### New collection: `dispatches`

- `title` (string, required)
- `featured_image` (image)
- `summary` (text) — always public; this is the teaser that sells membership
- `content` (Portable Text) — member-only
- `published_at` (datetime)

### New pages

- `src/pages/dispatches/index.astro` — lists every published entry's `title`, `featured_image`, and `summary`. Public, no gating. Ends with a "Become a member" note explaining that full dispatches unlock after paying for any class, linking to `/classes`.
- `src/pages/dispatches/[slug].astro` — reads the visitor's session (via whatever EmDash exposes for session lookup outside the admin middleware — to be confirmed in the implementation plan; EmDash's own admin shell middleware pattern is `getSession(request)` populating `locals.user`, and the equivalent needs to run for this route too, most likely via a small custom middleware entry scoped to `/dispatches/*`). If the session's role is ≥ Subscriber (10), render the full Portable Text `content`. If not, render only the `summary` plus a CTA — **the gated `content` field must not be fetched/included in the response at all for an unauthorized visitor**, not merely hidden client-side, since the page is server-rendered and nothing server-rendered should reach the client's HTML if it isn't supposed to be visible.

### `/members/login` page

A public-facing login page (distinct from `/_emdash/admin/login`) that drives EmDash's passkey (WebAuthn) and magic-link REST endpoints (`/api/auth/passkey/options`, `/api/auth/passkey/verify`, `/api/auth/magic-link/send`, `/api/auth/magic-link/verify`) from our own page/script, matching the UX of the admin login but styled to the site's editorial theme. The browser-side WebAuthn ceremony itself (`navigator.credentials.get`) needs to be wired up here since we're not using EmDash's admin React island — the implementation plan should check whether EmDash ships a reusable client helper for this before writing it from scratch.

## Data model summary

| Collection/Plugin | Change |
|---|---|
| `classes` | add `price_cents` (integer, optional) |
| `dispatches` (new) | `title`, `featured_image`, `summary`, `content`, `published_at` |
| `class-signups` plugin | add Stripe Checkout branch, `webhooks/stripe` route (`public: true`), `apiKey`/`webhookSecret`/`emdashInviteToken` settings, session-id tracking for idempotency, `network:request` capability with the site's own domain in `allowedHosts` |
| `newsletter` plugin (new) | `apiKey` setting, `subscribe` route |

## Security considerations

- Stripe webhook signatures must be verified; unverified requests are rejected outright.
- The Buttondown API key, Stripe API key/webhook secret, and the admin personal access token used to call EmDash's invite endpoint are all stored as encrypted plugin secrets, never in `.env` or committed config.
- Gated `dispatches` content must never be present in server-rendered output for an unauthorized session — verify this explicitly (e.g. by checking the raw HTML response, not just what's visually hidden) during implementation.
- The invite-triggering webhook handler must not be spoofable into inviting arbitrary emails as Subscribers — it only acts on verified Stripe events, and metadata (email) comes from the Checkout Session Stripe itself created, not from unauthenticated user input at webhook time.

## Testing approach

Stripe's live webhook behavior isn't practical to unit-test in isolation. The plan should rely on:

- Stripe test mode + the Stripe CLI (`stripe listen --forward-to`) for local webhook delivery during development.
- A manual end-to-end walkthrough: pay for a test class in Stripe test mode → confirm the signup is recorded → confirm the invite email fires → register a passkey → confirm `/dispatches/[slug]` now renders full content for that session → confirm it still shows only the teaser in a logged-out browser.
- A manual walkthrough of the free-class path to confirm it's unaffected (no Stripe involvement, no invite).
- A manual walkthrough of the newsletter form against a Buttondown test/sandbox list (or a temporary real list), including the failure path (wrong/revoked API key) showing a friendly error rather than a crash.
- Re-delivering the same Stripe webhook event twice (Stripe CLI supports this) to confirm idempotency — no duplicate signups, no duplicate invite attempts.
