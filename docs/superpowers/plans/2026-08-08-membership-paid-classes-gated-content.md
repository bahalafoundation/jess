# Membership, Paid Classes & Gated Content Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let classes charge real money via Stripe; anyone who pays for a class becomes a permanent member (EmDash's built-in Subscriber role, via passkey/magic-link login); members can read a new gated content library that's teaser-only for everyone else.

**Architecture:** Extend the existing `class-signups` plugin with a Stripe Checkout branch and a webhook-driven membership grant, using EmDash's own user-invite endpoint rather than building any custom auth. Stripe's raw-body signature verification can't happen inside the plugin sandbox (confirmed: `SandboxedRequest` exposes no body-reading method), so it's split across a plain Astro endpoint (signature verification) and a plugin route (business logic). A new `dispatches` collection holds the gated content; gating is a per-page session check, not a collection-level restriction.

**Tech Stack:** EmDash sandboxed plugin API, Astro server endpoints, Stripe's REST API called directly via `fetch` (no `stripe` npm SDK — avoids introducing a new dependency for what's a small, well-documented REST surface), Web Crypto (`crypto.subtle`) for HMAC signature verification.

**Testing note:** This repo has no test runner (confirmed: no `test` script, no vitest/jest, no `*.test.*` files). All verification below is manual — dev server, `curl`, the Stripe CLI, and the browser — matching this project's documented convention (CLAUDE.md: "start the dev server and use the feature in a browser"). This is also what the design spec's own Testing Approach section calls for, given Stripe's webhook behavior isn't practical to unit-test in isolation.

**Companion plan:** `2026-08-08-newsletter-buttondown.md` is fully independent of this one and can be built in either order.

---

## Chunk 1: Schema changes

### Task 1: Add `price_cents` to `classes` and create the `dispatches` collection

**Files:**
- Modify: `seed/seed.json`

- [ ] **Step 1: Read the current `classes` collection definition in `seed/seed.json`**

Find the `classes` collection entry (it has `fields` including `title`, `featured_image`, `summary`, `content`, `start_time`, `end_time`, `location`, `capacity`, `price`).

- [ ] **Step 2: Add the `price_cents` field**

Add this object to the `classes` collection's `fields` array, immediately after the existing `price` field:

```json
{
  "slug": "price_cents",
  "label": "Price (cents, for billing)",
  "type": "integer"
}
```

Leave the existing `price` field untouched — it stays the free-form display string (e.g. `"$120"`, `"Free"`). `price_cents` is separate and is what actually gets charged; unset or `0` means free.

- [ ] **Step 3: Add the `dispatches` collection**

Add a new top-level collection entry to `seed/seed.json`'s collections array (follow the exact structure of the existing `classes`/`pages` entries you just read):

```json
{
  "slug": "dispatches",
  "label": "Dispatches",
  "labelSingular": "Dispatch",
  "supports": ["drafts", "revisions", "search", "seo"],
  "fields": [
    {
      "slug": "title",
      "label": "Title",
      "type": "string",
      "required": true,
      "searchable": true
    },
    {
      "slug": "featured_image",
      "label": "Featured Image",
      "type": "image"
    },
    {
      "slug": "summary",
      "label": "Summary",
      "type": "text",
      "searchable": true
    },
    {
      "slug": "content",
      "label": "Content",
      "type": "portableText",
      "searchable": true
    },
    {
      "slug": "published_on",
      "label": "Published",
      "type": "datetime"
    }
  ]
}
```

`summary` is always public (the teaser); `content` is the member-only body — enforced in page code in Chunk 4, not by the schema itself.

- [ ] **Step 4: Validate the JSON**

Run: `python3 -m json.tool seed/seed.json > /dev/null`
Expected: no output, exit code 0. If it errors, fix the JSON syntax before proceeding.

- [ ] **Step 5: Start the dev server to apply the schema and regenerate types**

Run: `npx emdash dev`
Expected: starts without error. Per CLAUDE.md, schema changes auto-seed on first request and `npx emdash dev` regenerates `emdash-env.d.ts`.

- [ ] **Step 6: Verify in the admin UI**

Visit `http://localhost:4321/_emdash/admin/content-types` and confirm both `classes` (now with a `price_cents` field) and the new `dispatches` collection appear. Visit `http://localhost:4321/_emdash/admin/content/dispatches/new` and confirm the form renders with the five fields above.

- [ ] **Step 7: Verify generated types**

Read `emdash-env.d.ts` and confirm it now includes a `dispatches` entry and that the `classes` entry's data type includes `price_cents?: number`. If `npx emdash dev` didn't regenerate it automatically, run `npx emdash types` explicitly.

- [ ] **Step 8: Commit**

```bash
git add seed/seed.json emdash-env.d.ts
git commit -m "Add price_cents to classes and create dispatches collection"
```

---

## Chunk 2: Stripe Checkout for paid classes

### Task 2: Add Stripe settings to `class-signups` via Block Kit

**Files:**
- Modify: `plugins/class-signups/src/index.ts`
- Modify: `plugins/class-signups/src/sandbox-entry.ts`

The plugin's existing `admin` route only ever renders the signups dashboard, regardless of which admin page loaded it. It needs to branch on `interaction.page` so a second admin page can hold Stripe settings, following the exact pattern documented for Block Kit settings pages (`page_load` renders a form, `form_submit` saves to KV).

- [ ] **Step 1: Register a second admin page**

**Modify** `plugins/class-signups/src/index.ts`. This plugin will also need to call Stripe's API and (in Chunk 3) call back into the site's own `/api/auth/invite` endpoint, so it needs `network:request` with both hosts allowed. Compute the site's own host in `astro.config.mjs` (outside the sandbox, where `process.env`/`import.meta.env` are available) and pass it in as a plugin option, rather than hardcoding a domain inside the plugin package:

```typescript
import type { PluginDescriptor } from "emdash";

export function classSignupsPlugin(options: { siteHost: string }): PluginDescriptor {
	return {
		id: "class-signups",
		version: "0.2.0",
		format: "standard",
		entrypoint: "@jess/plugin-class-signups/sandbox",
		options: { siteHost: options.siteHost },
		capabilities: ["content:read", "network:request", "users:read"],
		allowedHosts: ["api.stripe.com", options.siteHost],
		storage: {
			signups: {
				indexes: ["classId", "createdAt"],
			},
		},
		adminPages: [
			{ path: "/signups", label: "Class Signups", icon: "list" },
			{ path: "/settings", label: "Payment Settings", icon: "credit-card" },
		],
	};
}
```

Bump the version (`0.1.0` → `0.2.0`) as a plain changelog marker for this broadened trust contract (new capabilities, new allowed hosts). Note this is just documentation here, not enforcement: EmDash's version-bump-on-capability-change rule exists to protect a marketplace consent flow, and this plugin is registered by calling `classSignupsPlugin()` directly in `astro.config.mjs` — a first-party TS function, not a jsonc-manifest install — so there's no separate consent step this bump feeds into.

`users:read` is added now because Chunk 3's `webhooks/confirm` route needs `ctx.users.getByEmail()` to check whether an invite is needed.

- [ ] **Step 2: Update the `astro.config.mjs` call site**

**Modify** `astro.config.mjs`. Compute the site host from wherever the project's deployed URL is known — check whether `EMDASH_SITE_URL`/`SITE_URL` is already set for this project (grep `.env`, `wrangler.jsonc`, and `astro.config.mjs` for `siteUrl`/`SITE_URL` before assuming; none of the earlier reads of `astro.config.mjs` showed a `siteUrl` configured, so this project likely relies on request-derived origin locally and will need one set for deployment — treat that as a prerequisite to flag, not something this plan can hardcode). For now, read it from an env var with a localhost fallback for dev:

```javascript
const siteHost = new URL(process.env.SITE_URL ?? "http://localhost:4321").host;
```

```javascript
plugins: [classSignupsPlugin({ siteHost }), newsletterPlugin()],
```

(Omit `newsletterPlugin()` here if the newsletter plan hasn't been implemented yet in this worktree — check `astro.config.mjs`'s current content before editing rather than assuming.)

- [ ] **Step 3a: Confirm the invite-token mechanism before writing settings copy**

This is a blocking spike, not optional prep: the spec (see its "Open question" on the invite-capability, Component 2) flags that EmDash's exact personal-access-token creation flow and scope name for calling `POST /_emdash/api/auth/invite` were not confirmed against the live product. Before writing the settings page text in Step 3b:

1. Query the docs MCP (`mcp__emdash-docs__search_docs`) for "personal access token create scope invite" and "API token admin UI" to find the real screen name and required scope.
2. With the local dev server running and logged into `/_emdash/admin`, find that screen directly and create a real token, confirming it works by calling `POST /_emdash/api/auth/invite` with it via `curl` (`Authorization: Bearer <token>`, body `{"email":"...","role":10}`) and confirming a new Subscriber-role user is created.
3. Only after that succeeds, write the settings page's help text (Step 3b) to name the actual screen and scope — don't ship the placeholder wording below without replacing it based on what you actually found.

- [ ] **Step 3b: Extend the `admin` route to branch on page**

**Modify** `plugins/class-signups/src/sandbox-entry.ts`. Read the current file fully first (it's reproduced in the design spec's research notes, but re-read live). Rename the existing dashboard-rendering logic into its own function, add a `renderSettings` function following the exact shape used in the newsletter plugin's settings page (see the companion plan, Task 2), and branch the `admin` route handler on `interaction.page`:

```typescript
interface BlockInteraction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

async function renderSignupsDashboard(ctx: PluginContext) {
	// ...move the existing admin route body here verbatim, unchanged...
}

async function renderPaymentSettings(ctx: PluginContext) {
	const stripeSecretKey = (await ctx.kv.get<string>("settings:stripeSecretKey")) ?? "";
	const emdashInviteToken = (await ctx.kv.get<string>("settings:emdashInviteToken")) ?? "";
	return {
		blocks: [
			{ type: "header", text: "Payment Settings" },
			{
				type: "section",
				// PLACEHOLDER — replace with the real screen name and scope found in Step 3a
				// before this ships. Do not leave this guess in place.
				text: "The invite token is an EmDash personal access token with permission to invite users. See Step 3a of the implementation plan for how to create one.",
			},
			{
				type: "form",
				block_id: "settings",
				fields: [
					{
						type: "secret_input",
						action_id: "stripeSecretKey",
						label: "Stripe Secret Key",
						initial_value: stripeSecretKey,
					},
					{
						type: "secret_input",
						action_id: "emdashInviteToken",
						label: "EmDash Invite Token",
						initial_value: emdashInviteToken,
					},
				],
				submit: { label: "Save", action_id: "save" },
			},
		],
	};
}
```

Replace the `admin` route's handler with:

```typescript
admin: {
	handler: async (routeCtx: any, ctx: PluginContext) => {
		const interaction = (routeCtx.input ?? {}) as BlockInteraction;

		if (interaction.type === "page_load") {
			return interaction.page === "/settings"
				? renderPaymentSettings(ctx)
				: renderSignupsDashboard(ctx);
		}

		if (interaction.type === "form_submit" && interaction.action_id === "save") {
			for (const [key, value] of Object.entries(interaction.values ?? {})) {
				if (typeof value === "string") {
					await ctx.kv.set(`settings:${key}`, value);
				}
			}
			return {
				...(await renderPaymentSettings(ctx)),
				toast: { message: "Settings saved", type: "success" },
			};
		}

		return { blocks: [] };
	},
},
```

- [ ] **Step 4: Verify the settings page renders**

Run: `npx emdash dev`
Visit `http://localhost:4321/_emdash/admin`, find **Class Signups → Payment Settings** in the sidebar, confirm the form renders with two secret fields, and that **Class Signups** (the original dashboard) still renders its existing content unchanged.

- [ ] **Step 5: Commit**

```bash
git add plugins/class-signups astro.config.mjs
git commit -m "Add Stripe/invite settings page to class-signups plugin"
```

---

### Task 3: Branch the `signup` route on `price_cents`

**Files:**
- Modify: `plugins/class-signups/src/sandbox-entry.ts`

- [ ] **Step 1: Extend `getClass` to read `price_cents`**

In the `ClassInfo` interface, add `priceCents: number`, and in `getClass()`, parse it:

```typescript
interface ClassInfo {
	id: string;
	title: string;
	startTime: Date | null;
	capacity: number;
	priceCents: number;
}
```

```typescript
const priceCents = Number(data.price_cents);
```

```typescript
return {
	id: String(entry.id ?? classId),
	title: String(data.title ?? "Untitled class"),
	startTime: start && !Number.isNaN(start.getTime()) ? start : null,
	capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : Infinity,
	priceCents: Number.isFinite(priceCents) && priceCents > 0 ? priceCents : 0,
};
```

- [ ] **Step 2: Add a `classUrl` input**

The class detail page is reached by slug, but the plugin only ever receives `classId` (the ULID) — there's no way to reconstruct the page's own URL from inside the plugin. So the frontend (Task 4) will pass its own current URL along with the signup, and this route uses it directly for Stripe's `success_url`/`cancel_url` instead of trying to rebuild it.

Add to the input parsing near the top of the `signup` handler, alongside the existing `notes` line:

```typescript
const classUrl = typeof input.classUrl === "string" ? input.classUrl.trim() : "";
```

Add a validation check alongside the existing ones (`if (!classId) return fail(...)`, etc.):

```typescript
if (!classUrl) return fail("Missing classUrl.");
```

- [ ] **Step 3: Branch the `signup` route after the existing capacity check**

The existing route (read it fully before editing) currently does, in order: validate input → load class → check closed → compute `const id = signupId(cls.id, email)` and check dedupe (`ctx.storage.signups.exists(id)`) → check capacity (`if (taken >= cls.capacity) { ... }`) → build `const record: Signup = { ... }` → `ctx.storage.signups.put(id, record)` → return. Both `id` and `taken` are already declared above the capacity check, so insert the Stripe branch **directly before the existing `const record: Signup = { ... }` line** (immediately after the capacity check's closing brace) — not before the `const id = ...` line, which is declared earlier and must not be duplicated:

```typescript
if (cls.priceCents > 0) {
	const stripeSecretKey = await ctx.kv.get<string>("settings:stripeSecretKey");
	if (!stripeSecretKey || !ctx.http) {
		ctx.log.error("Paid class signup attempted with Stripe not configured", { classId: cls.id });
		return fail("Signups for this class aren't available right now.");
	}

	const params = new URLSearchParams();
	params.set("mode", "payment");
	params.set("success_url", `${classUrl}?checkout=success`);
	params.set("cancel_url", `${classUrl}?checkout=cancelled`);
	params.set("customer_email", email);
	params.set("line_items[0][quantity]", "1");
	params.set("line_items[0][price_data][currency]", "usd");
	params.set("line_items[0][price_data][unit_amount]", String(cls.priceCents));
	params.set("line_items[0][price_data][product_data][name]", cls.title);
	params.set("metadata[classId]", cls.id);
	params.set("metadata[name]", name);
	params.set("metadata[email]", email);
	if (notes) params.set("metadata[notes]", notes);

	try {
		const res = await ctx.http.fetch("https://api.stripe.com/v1/checkout/sessions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${stripeSecretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			ctx.log.error("Stripe checkout session creation failed", { status: res.status, body });
			return fail("Something went wrong starting checkout. Please try again.");
		}

		const session = (await res.json()) as { url?: string };
		if (!session.url) {
			return fail("Something went wrong starting checkout. Please try again.");
		}

		return { success: true, checkoutUrl: session.url };
	} catch (err) {
		ctx.log.error("Stripe checkout session request threw", { error: String(err) });
		return fail("Something went wrong starting checkout. Please try again.");
	}
}

// Free class continues exactly as before, starting from the existing
// `const record: Signup = { ... }` line — no changes below this point.
```

- [ ] **Step 4: Commit**

```bash
git add plugins/class-signups/src/sandbox-entry.ts
git commit -m "Branch class signup route to Stripe Checkout for priced classes"
```

---

### Task 4: Update the class detail page frontend

**Files:**
- Modify: `src/pages/classes/[slug].astro`

- [ ] **Step 1: Pass `classUrl` in the signup request**

In the `<script>` block's fetch call to `/signup`, add `classUrl: window.location.href` to the JSON body:

```typescript
body: JSON.stringify({
	classId,
	classUrl: window.location.href,
	name: formData.get("name"),
	email: formData.get("email"),
	notes: formData.get("notes") || undefined,
}),
```

- [ ] **Step 2: Redirect to Stripe on `checkoutUrl`**

In the `then` branch that currently handles `res.ok && data?.success`, add a check for `data.checkoutUrl` before the existing success-message logic:

```typescript
if (res.ok && data?.success) {
	if (data.checkoutUrl) {
		window.location.href = data.checkoutUrl;
		return;
	}
	if (data.alreadyRegistered) {
		successMessage.textContent =
			"You're already signed up for this class — see you there.";
	}
	form.hidden = true;
	spotsLine.hidden = true;
	successBox.hidden = false;
} else {
	// ...unchanged...
}
```

- [ ] **Step 3: Show a message if the visitor lands back on the page after cancelling checkout**

Add to the frontmatter, alongside the existing `start`/`end`/`isPast` computations:

```typescript
const checkoutStatus = Astro.url.searchParams.get("checkout");
```

Add a conditional block just above the `<section class="signup" id="signup">` element:

```astro
{
	checkoutStatus === "cancelled" && (
		<p class="checkout-cancelled-note">
			Checkout was cancelled — your spot wasn't reserved. You can try again below.
		</p>
	)
}
```

Add a matching style near `.signup-closed-note`:

```css
.checkout-cancelled-note {
	margin-bottom: var(--spacing-lg);
	color: var(--color-danger);
	font-size: var(--font-size-sm);
}
```

Note: a `checkout=success` landing is a weaker signal than the webhook — Stripe recommends treating the webhook as the source of truth for whether payment actually completed, since a visitor can hit the success URL without payment having been confirmed server-side yet (or manually navigate to it). This plan doesn't show a special "you're confirmed" message on `checkout=success` for that reason; the visitor's confirmation is the invite email, which only fires after the webhook (Chunk 3) processes the real payment confirmation.

- [ ] **Step 4: Manual verification with Stripe test mode**

Set `STRIPE_SECRET_KEY`... actually, this plugin reads its Stripe key from plugin KV settings (Task 2), not an env var — go to the plugin's Payment Settings admin page and enter a Stripe **test-mode** secret key (starts with `sk_test_`).

In the admin UI, create or edit a class with `price_cents` set to a positive value (e.g. `1000` for $10). Visit that class's page, fill out the signup form, submit, and confirm the browser redirects to a real Stripe Checkout page showing $10.00. Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC, to complete a test payment, and confirm it redirects back to the class page with `?checkout=success` in the URL (the signup itself won't be recorded yet — that's Chunk 3).

- [ ] **Step 5: Verify the free-class path is unaffected**

Sign up for a class with no `price_cents` set. Confirm it behaves exactly as before (no redirect, inline success message, no Stripe involvement) — check `.astro/dev.log` for any unexpected Stripe-related log lines during this signup.

- [ ] **Step 6: Commit**

```bash
git add src/pages/classes/[slug].astro
git commit -m "Redirect paid class signups to Stripe Checkout"
```

---

## Chunk 3: Stripe webhook and membership grant

This chunk implements the two-layer webhook architecture from the design spec: a plain Astro endpoint does raw-body Stripe signature verification (impossible inside the plugin sandbox — confirmed via docs that `SandboxedRequest` exposes no body-reading method), then hands verified data to a new plugin route that does the actual signup-recording and membership-granting.

**Security note not spelled out in the spec, resolved here:** the plugin route the Astro endpoint calls into (`webhooks/confirm`) must be reachable without an EmDash session (the Astro endpoint is server-to-server, no browser cookie), which per the plugin API docs means marking it `public: true` — but a `public: true` route is callable by *anyone* on the internet, and `webhooks/confirm` itself never checks a Stripe signature (that already happened upstream). Without another layer, anyone could `curl` `webhooks/confirm` directly with a made-up email and grant themselves membership for free. This plan closes that gap with a shared secret known only to the Astro endpoint and the plugin (`INTERNAL_WEBHOOK_SECRET`), sent as a header and checked before anything else runs.

### Task 5: Shared secrets and the plain Astro webhook endpoint

**Files:**
- Create: `src/pages/api/webhooks/stripe.ts`
- Create or modify: `.dev.vars` (local Wrangler-style env file — see note below)
- Modify: `plugins/class-signups/src/index.ts`, `plugins/class-signups/src/sandbox-entry.ts` (add the shared-secret setting)

- [ ] **Step 1: Confirm how this project reads runtime env vars under the Cloudflare adapter**

`astro.config.mjs` uses `adapter: cloudflare()`. On Cloudflare Workers, secrets set via `wrangler secret put` (production) or a local `.dev.vars` file (Wrangler's dev-time convention — distinct from a plain `.env` file, which Vite/Astro reads at *build* time, not *request* time) are exposed at request time as `context.locals.runtime.env`, not `import.meta.env`. This plan writes the webhook endpoint assuming that shape. Before relying on it: run the dev server, temporarily log `JSON.stringify(Object.keys(context.locals.runtime?.env ?? {}))` from a scratch endpoint, and confirm `locals.runtime.env` is actually populated in this project's setup (the `@astrojs/cloudflare` version and any `env.d.ts` type references matter here). If it isn't populated the way expected, adjust Step 3 below to whatever the confirmed mechanism is — don't ship a webhook handler that silently reads `undefined` for its secrets.

- [ ] **Step 2: Add local secrets to `.dev.vars`**

Create (or add to) `.dev.vars` in the project root — check `.gitignore` first to confirm it's already excluded from version control (Wrangler's convention is that `.dev.vars` is never committed; if it's not already gitignored, add it before creating the file, since it will hold real secrets):

```
STRIPE_WEBHOOK_SECRET=whsec_...
INTERNAL_WEBHOOK_SECRET=...
```

For local development, `STRIPE_WEBHOOK_SECRET` comes from the Stripe CLI (Task 7 below prints one when you run `stripe listen`). Generate `INTERNAL_WEBHOOK_SECRET` yourself — any long random string, e.g. `openssl rand -hex 32`.

- [ ] **Step 3: Write the webhook endpoint**

`src/pages/api/webhooks/stripe.ts`:

```typescript
import type { APIRoute } from "astro";

export const prerender = false;

async function verifyStripeSignature(
	rawBody: string,
	sigHeader: string,
	secret: string,
): Promise<boolean> {
	// Stripe's header can carry more than one `v1=` pair during secret
	// rotation (the payload is signed with both the old and new endpoint
	// secrets for an overlap window) — collect ALL v1 values, don't keep only
	// the last one the way a naive Object.fromEntries over the split pairs
	// would.
	let timestamp: string | undefined;
	const signatures: string[] = [];
	for (const kv of sigHeader.split(",")) {
		const [key, value] = kv.split("=");
		if (key === "t") timestamp = value;
		if (key === "v1" && value) signatures.push(value);
	}
	if (!timestamp || signatures.length === 0) return false;

	// Reject stale signatures (Stripe's own recommended replay-attack guard).
	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(age) || age > 300) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signedPayload = `${timestamp}.${rawBody}`;
	const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
	const expectedHex = [...new Uint8Array(sigBuffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Match against ANY of the provided v1 signatures, not just one.
	return signatures.some((signature) => {
		if (expectedHex.length !== signature.length) return false;
		let mismatch = 0;
		for (let i = 0; i < expectedHex.length; i++) {
			mismatch |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
		}
		return mismatch === 0;
	});
}

export const POST: APIRoute = async (context) => {
	const env = context.locals.runtime?.env as
		| { STRIPE_WEBHOOK_SECRET?: string; INTERNAL_WEBHOOK_SECRET?: string }
		| undefined;
	const webhookSecret = env?.STRIPE_WEBHOOK_SECRET;
	const internalSecret = env?.INTERNAL_WEBHOOK_SECRET;

	if (!webhookSecret || !internalSecret) {
		console.error("Stripe webhook endpoint called with secrets not configured");
		return new Response("Not configured", { status: 500 });
	}

	const signature = context.request.headers.get("stripe-signature");
	if (!signature) {
		return new Response("Missing signature", { status: 400 });
	}

	const rawBody = await context.request.text();
	const valid = await verifyStripeSignature(rawBody, signature, webhookSecret);
	if (!valid) {
		return new Response("Invalid signature", { status: 400 });
	}

	let event: any;
	try {
		event = JSON.parse(rawBody);
	} catch {
		return new Response("Invalid payload", { status: 400 });
	}

	if (event.type !== "checkout.session.completed") {
		return new Response(null, { status: 200 });
	}

	const session = event.data?.object ?? {};
	const metadata = session.metadata ?? {};

	const confirmRes = await fetch(
		new URL("/_emdash/api/plugins/class-signups/webhooks/confirm", context.request.url),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
				"X-Internal-Webhook-Secret": internalSecret,
			},
			body: JSON.stringify({
				stripeSessionId: session.id,
				classId: metadata.classId,
				name: metadata.name,
				email: metadata.email,
				notes: metadata.notes,
			}),
		},
	);

	// IMPORTANT: per this project's plugin API (see CLAUDE.md's documented
	// quirks), a route handler that *returns* `{ success: false, error }`
	// instead of throwing still comes back as a normal 200 wrapped in the
	// standard `{ success: true, data: <value> }` envelope. `confirmRes.ok`
	// alone would never catch a handler-level failure (wrong shared secret,
	// bad metadata, missing class) — only network errors or an actual thrown
	// Response. Unwrap the envelope and check the inner result explicitly.
	let confirmBody: any = null;
	try {
		confirmBody = await confirmRes.json();
	} catch {
		// leave confirmBody null — treated as failure below
	}
	const confirmData =
		confirmBody && typeof confirmBody === "object" && "data" in confirmBody
			? confirmBody.data
			: confirmBody;

	if (!confirmRes.ok || !confirmData?.success) {
		// Non-2xx (or a handler-level failure) tells Stripe to retry the webhook
		// later — appropriate for what's likely a transient or misconfiguration
		// failure (e.g. the shared secret drifted out of sync, or the confirm
		// route errored).
		console.error("class-signups webhook confirm failed", JSON.stringify(confirmBody));
		return new Response("Confirm failed", { status: 500 });
	}

	return new Response(null, { status: 200 });
};
```

- [ ] **Step 4: Add `internalWebhookSecret` to the plugin's Payment Settings page**

**Modify** `plugins/class-signups/src/sandbox-entry.ts`'s `renderPaymentSettings()` (from Chunk 2, Task 2): add a third field to the settings form, alongside `stripeSecretKey` and `emdashInviteToken`:

```typescript
const internalWebhookSecret = (await ctx.kv.get<string>("settings:internalWebhookSecret")) ?? "";
```

```typescript
{
	type: "secret_input",
	action_id: "internalWebhookSecret",
	label: "Internal Webhook Secret",
	initial_value: internalWebhookSecret,
},
```

The `form_submit` handler already loops over `Object.entries(interaction.values ?? {})` generically, so no other code change is needed there — it'll pick up the new field automatically.

- [ ] **Step 5: Enter matching secrets in both places**

In the admin UI's Payment Settings page, enter the **same** value for "Internal Webhook Secret" that you put in `.dev.vars`'s `INTERNAL_WEBHOOK_SECRET`. These must match exactly — Task 6 will reject the request otherwise. (Yes, this means updating two places when rotating it; that's the cost of the plugin sandbox not sharing env vars with the rest of the site.)

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/webhooks/stripe.ts plugins/class-signups/src/sandbox-entry.ts .gitignore
git commit -m "Add Stripe webhook endpoint with raw-body signature verification"
```

(Do not add `.dev.vars` itself — it holds real secrets and must stay untracked.)

---

### Task 6: The `webhooks/confirm` plugin route

**Files:**
- Modify: `plugins/class-signups/src/index.ts` (add a dedicated storage collection for webhook idempotency)
- Modify: `plugins/class-signups/src/sandbox-entry.ts`

- [ ] **Step 1: Add a separate storage collection for processed Stripe sessions**

Don't reuse the `signups` collection to track which Stripe session IDs have already been processed — a marker record living alongside real signups would corrupt `countSignups()` (capacity checks) and the admin dashboard's per-class listing, both of which query `ctx.storage.signups` directly. Add a second, dedicated collection instead.

**Modify** `plugins/class-signups/src/index.ts`:

```typescript
storage: {
	signups: {
		indexes: ["classId", "createdAt"],
	},
	processedStripeSessions: {
		indexes: ["createdAt"],
	},
},
```

- [ ] **Step 2: Extend the `Signup` record shape**

**Modify** `plugins/class-signups/src/sandbox-entry.ts`. Add fields to the existing `Signup` interface to track payment/oversold state:

```typescript
interface Signup {
	classId: string;
	className: string;
	name: string;
	email: string;
	notes?: string;
	createdAt: string;
	stripeSessionId?: string;
	paid?: boolean;
	oversold?: boolean;
}
```

- [ ] **Step 3: Implement the `webhooks/confirm` route**

Add a small constant-time string comparison helper near the top of the file, alongside `EMAIL_RE`/`fail` — used for the shared-secret check below (matching the same constant-time-comparison approach already used for the Stripe HMAC check in `src/pages/api/webhooks/stripe.ts`, for consistency rather than because the threat model strictly demands it here):

```typescript
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
```

Add a new route to the `routes` object, alongside `signup`/`availability`/`admin`. It must be `public: true` (no session available, called server-to-server), but is protected by the shared secret from Task 5:

```typescript
"webhooks/confirm": {
	public: true,
	handler: async (routeCtx: any, ctx: PluginContext) => {
		if (routeCtx.request.method !== "POST") {
			return fail("Method not allowed.");
		}

		const sharedSecret = await ctx.kv.get<string>("settings:internalWebhookSecret");
		const providedSecret = routeCtx.request.headers["x-internal-webhook-secret"] ?? "";
		if (!sharedSecret || !timingSafeEqual(providedSecret, sharedSecret)) {
			ctx.log.error("webhooks/confirm called with missing or wrong internal secret");
			return fail("Unauthorized.");
		}

		const input = (routeCtx.input ?? {}) as Record<string, unknown>;
		const stripeSessionId =
			typeof input.stripeSessionId === "string" ? input.stripeSessionId.trim() : "";
		const classId = typeof input.classId === "string" ? input.classId.trim() : "";
		const name = typeof input.name === "string" ? input.name.trim() : "";
		const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
		const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 1000) : "";

		if (!stripeSessionId || !classId || !EMAIL_RE.test(email)) {
			ctx.log.error("webhooks/confirm called with invalid payload", { classId, email });
			return fail("Invalid payload.");
		}

		// Idempotency: Stripe may redeliver the same event, and can even deliver
		// duplicates concurrently. Check-then-claim as early as possible — before
		// recording the signup or touching membership — to keep the race window
		// (two concurrent requests both passing the `exists()` check before
		// either `put()`s the claim) as narrow as practical. `ctx.storage`
		// doesn't document an atomic compare-and-swap primitive, so this can't
		// be made fully race-proof; the residual risk is a duplicate invite call
		// on the rare true-concurrent redelivery, which is harmless (EmDash's
		// invite endpoint no-ops or errors harmlessly for an email that's
		// already invited) — not the capacity-oversell race, which is a
		// separate, already-acknowledged limitation.
		if (await ctx.storage.processedStripeSessions.exists(stripeSessionId)) {
			return { success: true, alreadyProcessed: true };
		}
		await ctx.storage.processedStripeSessions.put(stripeSessionId, {
			classId,
			email,
			createdAt: new Date().toISOString(),
		});

		const cls = await getClass(ctx, classId);
		if (!cls) {
			ctx.log.error("webhooks/confirm: class not found", { classId });
			return fail("Class not found.");
		}

		const id = signupId(cls.id, email);
		const alreadySignedUp = await ctx.storage.signups.exists(id);

		if (!alreadySignedUp) {
			const taken = await countSignups(ctx, cls.id);
			const oversold = taken >= cls.capacity;
			if (oversold) {
				ctx.log.error("Paid signup recorded past capacity — needs manual resolution", {
					classId: cls.id,
					email,
				});
			}

			const record: Signup = {
				classId: cls.id,
				className: cls.title,
				name,
				email,
				notes: notes || undefined,
				createdAt: new Date().toISOString(),
				stripeSessionId,
				paid: true,
				oversold: oversold || undefined,
			};
			await ctx.storage.signups.put(id, record);
		}

		// Grant membership if this email has no EmDash user yet.
		if (ctx.users && ctx.http) {
			try {
				const existingUser = await ctx.users.getByEmail(email);
				if (!existingUser) {
					const inviteToken = await ctx.kv.get<string>("settings:emdashInviteToken");
					if (!inviteToken) {
						ctx.log.error("No invite token configured — cannot auto-invite paying member", {
							email,
						});
					} else {
						const inviteRes = await ctx.http.fetch(ctx.url("/_emdash/api/auth/invite"), {
							method: "POST",
							headers: {
								Authorization: `Bearer ${inviteToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ email, role: 10 }),
						});
						if (!inviteRes.ok) {
							ctx.log.error("EmDash invite call failed", {
								email,
								status: inviteRes.status,
								body: await inviteRes.text().catch(() => ""),
							});
						}
					}
				}
			} catch (err) {
				ctx.log.error("Membership invite check/call threw", { email, error: String(err) });
			}
		}

		return { success: true };
	},
},
```

Note the invite failure path only logs — per the design spec, a failed invite doesn't fail the whole webhook (the payment and signup record are already durable at that point); Jess can invite the payer manually from **Settings → Users** as a fallback, which is why Task 7 includes a check that this failure path is visible somewhere, not just swallowed into a log line nobody reads.

- [ ] **Step 4: Surface paid/oversold state on the admin dashboard**

**Modify** `renderSignupsDashboard()` (the function Chunk 2 Task 2 extracted from the old inline `admin` handler). In the per-signup table row mapping, add a "Paid" column, and add a warning block per class group when any signup in it is `oversold`:

```typescript
columns: [
	{ key: "name", label: "Name" },
	{ key: "email", label: "Email" },
	{ key: "paid", label: "Paid" },
	{ key: "notes", label: "Notes" },
	{ key: "createdAt", label: "Signed up" },
],
rows: group.signups.map((s) => ({
	name: s.name,
	email: s.email,
	paid: s.paid ? "Yes" : "—",
	notes: s.notes ?? "",
	createdAt: new Date(s.createdAt).toLocaleString("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
	}),
})),
```

Before the `table` block, add:

```typescript
if (group.signups.some((s) => s.oversold)) {
	blocks.push({
		type: "section",
		text: "⚠️ One or more paid signups for this class were recorded past capacity. Resolve manually (refund or accept the overage) — see the design spec's overselling note.",
	});
}
```

- [ ] **Step 5: Commit**

```bash
git add plugins/class-signups
git commit -m "Add webhooks/confirm route: idempotent signup recording and membership grant"
```

---

### Task 7: End-to-end verification with the Stripe CLI

**Files:** none (verification only)

- [ ] **Step 1: Install and authenticate the Stripe CLI**

If not already available: follow Stripe's CLI install instructions for the local OS, then run `stripe login` and complete the browser auth flow.

- [ ] **Step 2: Forward webhooks to the local dev server**

Run (in a separate terminal, left running):
```bash
stripe listen --forward-to localhost:4321/api/webhooks/stripe
```
Expected: prints a webhook signing secret (`whsec_...`). Copy it into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`, then restart `npx emdash dev` so the new value is picked up.

- [ ] **Step 3: Complete a real test payment**

With the dev server running, sign up for a paid test class through the actual UI (as in Chunk 2 Task 4 Step 4) using Stripe's test card `4242 4242 4242 4242`. Watch the `stripe listen` terminal for a `checkout.session.completed` event, and the dev server log (`.astro/dev.log`) for the webhook endpoint and `webhooks/confirm` route firing.

- [ ] **Step 4: Verify the signup was recorded**

In the admin UI, open **Class Signups** and confirm the new signup appears with "Paid: Yes".

- [ ] **Step 5: Verify membership was granted**

Check **Settings → Users** (or wherever user management lives) for a new user with the test email and Subscriber role, in an "invited" or "pending" state. If email is configured for this dev environment, check that an invite email was sent (or check the plugin/dev logs for the invite call's response).

- [ ] **Step 6: Verify idempotency**

Run:
```bash
stripe events resend <event-id>
```
(the event ID is printed by `stripe listen` for the event from Step 3). Confirm in the admin UI that no duplicate signup was created, and check `.astro/dev.log` for the `alreadyProcessed: true` short-circuit rather than a second invite attempt.

- [ ] **Step 7: Verify the unauthorized-caller path is actually blocked**

This is the security property Task 5/6 exist for — confirm it directly, don't just trust the code:
```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/class-signups/webhooks/confirm \
  -H "Content-Type: application/json" \
  -H "X-EmDash-Request: 1" \
  -d '{"stripeSessionId":"fake","classId":"whatever","email":"attacker@example.com","name":"Attacker"}'
```
Expected: a failure response (missing/wrong internal secret), and no user created for `attacker@example.com`. This confirms the route can't be used to grant free membership by calling it directly.

- [ ] **Step 8: Verify a desynced shared secret is actually reported as a failure, not silently swallowed**

This exercises the fix for the envelope-unwrapping bug caught in review: a route handler that returns `{ success: false }` instead of throwing still comes back as a normal HTTP 200 from EmDash's plugin dispatcher, so `src/pages/api/webhooks/stripe.ts` must unwrap the response body and check the inner `success` field, not just `res.ok`.

Temporarily change the "Internal Webhook Secret" value in the plugin's Payment Settings page to something different from what's in `.dev.vars` (don't change `.dev.vars` itself). Trigger another real test payment (or `stripe events resend` a fresh one). Confirm:
- The `stripe listen` terminal shows the delivery to `/api/webhooks/stripe` getting a **500** response (meaning Stripe will retry it) — not a 200.
- `.astro/dev.log` shows the "webhook confirm failed" log line with the unauthorized/wrong-secret error inside it.
- No new signup or invite happened for this attempt.

Then restore the matching secret value and re-trigger to confirm it succeeds normally, restoring the passing state from Step 3-6 before moving on.

- [ ] **Step 9: No commit needed for Steps 1-8** — they're verification only. If any step surfaced a bug, it should already have been fixed and committed in Task 5/6 before reaching this point.

---

## Chunk 4: Gated content and member login

This chunk has two genuinely unconfirmed pieces the design spec flagged and this plan cannot resolve without live access to a running EmDash instance: the exact request/response shape of the passkey REST endpoints, and where EmDash's magic-link verify redirects afterward. Both are called out explicitly below with a live-verification step before the surrounding code is trusted — don't skip those steps.

### Task 8: A shared "current session" helper

**Files:**
- Create: `src/lib/session.ts`

There's no confirmed public API for reading the current visitor's session/role from arbitrary site page code (EmDash's own admin shell middleware does this internally via a `getSession()` that isn't confirmed as a public export). The one confirmed, documented way to check "who is this request authenticated as" from any server context is the REST endpoint `GET /_emdash/api/auth/me`. This helper wraps that as a same-origin server-to-server call, forwarding the visitor's cookies.

- [ ] **Step 1: Check for a more direct API before using the HTTP fallback**

Before writing the fallback below, spend a few minutes checking whether `emdash` exports something more direct for site (not just admin) pages — search the docs MCP for "getSession export public locals.user site pages" and skim `node_modules/emdash`'s type declarations (installed by now, from earlier chunks) for any exported session-reading function. If one exists, use it instead of the HTTP round-trip below — it'll be faster and avoids the cookie-forwarding edge cases noted in Step 3. If nothing turns up, proceed with the fallback.

- [ ] **Step 2: Write the helper**

`src/lib/session.ts`:

```typescript
export interface CurrentUser {
	id: string;
	email: string;
	role: number;
}

const SUBSCRIBER_ROLE = 10;

export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
	const cookie = request.headers.get("cookie");
	if (!cookie) return null;

	try {
		const res = await fetch(new URL("/_emdash/api/auth/me", request.url), {
			headers: { cookie },
		});
		if (!res.ok) return null;

		const body = await res.json();
		const data = body && typeof body === "object" && "data" in body ? body.data : body;
		if (!data || typeof data !== "object" || typeof data.role !== "number") return null;

		return { id: String(data.id ?? ""), email: String(data.email ?? ""), role: data.role };
	} catch {
		return null;
	}
}

export function isMember(user: CurrentUser | null): boolean {
	return user !== null && user.role >= SUBSCRIBER_ROLE;
}
```

**Note:** this assumes `/api/auth/me`'s response includes a numeric `role` field directly on the user object (matching the role-level numbers documented in the authentication guide — Subscriber = 10). Confirm this against a real response in Task 9's verification (log in as any user locally and hit this endpoint directly) before trusting the `isMember()` check in production — if the field is named differently or nested, fix it here.

- [ ] **Step 3: Commit**

```bash
git add src/lib/session.ts
git commit -m "Add shared session-check helper for gated pages"
```

---

### Task 9: Gated `dispatches` pages

**Files:**
- Create: `src/pages/dispatches/index.astro`
- Create: `src/pages/dispatches/[slug].astro`

- [ ] **Step 1: Write the index page**

`src/pages/dispatches/index.astro` — public teaser list, modeled on the structure of `src/pages/work/index.astro`/`classes/index.astro` (read one of those first for the established grid/heading pattern and token usage before writing this):

```astro
---
import { getEmDashCollection } from "emdash";
import { Image } from "emdash/ui";
import Base from "../../layouts/Base.astro";

const { entries: dispatches, error, cacheHint } = await getEmDashCollection("dispatches");

if (error) {
	console.error("Failed to load dispatches:", error);
}

if (Astro.cache?.enabled) Astro.cache.set(cacheHint);

const sorted = [...(dispatches ?? [])].sort((a, b) => {
	const at = a.data.published_on ? new Date(String(a.data.published_on)).getTime() : 0;
	const bt = b.data.published_on ? new Date(String(b.data.published_on)).getTime() : 0;
	return bt - at;
});
---

<Base title="Dispatches" description="Members-only essays, recordings, and resources.">
	<div class="dispatches-page">
		<header class="dispatches-header">
			<h1 class="dispatches-title">Dispatches</h1>
			<p class="dispatches-intro">
				Longer, members-only writing. Full dispatches unlock the moment you pay
				for any class — see <a href="/classes">upcoming classes</a>. Already a
				member? <a href="/members/login">Log in</a>.
			</p>
		</header>

		<div class="dispatches-grid">
			{
				sorted.map((entry) => (
					<article class="dispatch-card">
						{entry.data.featured_image && (
							<div class="dispatch-card-image">
								<Image image={entry.data.featured_image} />
							</div>
						)}
						<h2 class="dispatch-card-title">
							<a href={`/dispatches/${entry.id}`}>{entry.data.title}</a>
						</h2>
						{entry.data.summary && <p class="dispatch-card-summary">{entry.data.summary}</p>}
					</article>
				))
			}
		</div>
	</div>
</Base>

<style>
	.dispatches-page {
		max-width: var(--wide-width);
		margin: 0 auto;
		padding: var(--spacing-2xl) var(--spacing-lg) var(--spacing-4xl);
	}

	.dispatches-header {
		max-width: var(--max-width);
		margin-bottom: var(--spacing-3xl);
	}

	.dispatches-title {
		font-family: var(--font-heading);
		font-size: var(--font-size-4xl);
		font-weight: var(--font-weight-display);
		line-height: var(--leading-tight);
		margin-bottom: var(--spacing-lg);
	}

	.dispatches-intro {
		font-size: var(--font-size-lg);
		color: var(--color-muted);
		line-height: var(--leading-normal);
	}

	.dispatches-intro a {
		color: var(--color-text);
	}

	.dispatches-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: var(--spacing-2xl);
	}

	.dispatch-card-image img {
		width: 100%;
		height: auto;
		border-radius: var(--radius);
		margin-bottom: var(--spacing-md);
	}

	.dispatch-card-title {
		font-family: var(--font-heading);
		font-size: var(--font-size-xl);
		font-weight: var(--font-weight-heading);
		margin-bottom: var(--spacing-sm);
	}

	.dispatch-card-title a {
		color: var(--color-text);
		text-decoration: none;
	}

	.dispatch-card-title a:hover {
		color: var(--color-brand);
	}

	.dispatch-card-summary {
		color: var(--color-muted);
		font-size: var(--font-size-base);
		line-height: var(--leading-normal);
	}
</style>
```

Before writing this, actually read `src/pages/work/index.astro` (or `classes/index.astro`) to confirm the real grid-layout token names and adjust the style block to match established conventions exactly rather than trusting the guesses above verbatim.

- [ ] **Step 2: Write the gated detail page**

`src/pages/dispatches/[slug].astro`. This is the security-critical page: the full `content` field must never be included in the rendered HTML for a non-member request — not fetched-then-hidden with CSS, actually not present in the response.

```astro
---
import { getEmDashEntry, decodeSlug } from "emdash";
import { Image, PortableText } from "emdash/ui";
import Base from "../../layouts/Base.astro";
import { getCurrentUser, isMember } from "../../lib/session";

const slug = decodeSlug(Astro.params.slug);

if (!slug) {
	return Astro.redirect("/404");
}

const { entry, cacheHint } = await getEmDashEntry("dispatches", slug);

if (!entry) {
	return Astro.redirect("/404");
}

if (Astro.cache?.enabled) Astro.cache.set(cacheHint);

const user = await getCurrentUser(Astro.request);
const member = isMember(user);

function getImageSrc(img: unknown): string | undefined {
	if (!img || typeof img !== "object") return undefined;
	const image = img as Record<string, unknown>;
	return typeof image.src === "string" ? image.src : undefined;
}
---

<Base
	title={entry.data.title}
	description={entry.data.summary}
	image={getImageSrc(entry.data.featured_image)}
>
	<article class="dispatch-page">
		<h1 class="dispatch-title">{entry.data.title}</h1>

		{
			entry.data.featured_image && (
				<div class="featured-image">
					<Image image={entry.data.featured_image} />
				</div>
			)
		}

		{entry.data.summary && <p class="dispatch-summary">{entry.data.summary}</p>}

		{
			member ? (
				entry.data.content && (
					<div class="dispatch-content">
						<PortableText value={entry.data.content} />
					</div>
				)
			) : (
				<div class="member-gate">
					<h2>This dispatch is for members</h2>
					<p>
						Full dispatches unlock the moment you pay for any class.{" "}
						<a href="/classes">See upcoming classes</a>, or if you're already a
						member, <a href="/members/login">log in</a>.
					</p>
				</div>
			)
		}
	</article>
</Base>

<style>
	.dispatch-page {
		max-width: var(--max-width);
		margin: 0 auto;
		padding: var(--spacing-2xl) var(--spacing-lg) var(--spacing-4xl);
	}

	.dispatch-title {
		font-family: var(--font-heading);
		font-size: var(--font-size-4xl);
		font-weight: var(--font-weight-display);
		line-height: var(--leading-tight);
		margin-bottom: var(--spacing-lg);
	}

	.featured-image {
		margin-bottom: var(--spacing-2xl);
	}

	.featured-image img {
		width: 100%;
		height: auto;
		border-radius: var(--radius);
	}

	.dispatch-summary {
		font-size: var(--font-size-lg);
		color: var(--color-muted);
		line-height: var(--leading-normal);
		margin-bottom: var(--spacing-2xl);
	}

	.dispatch-content {
		font-size: var(--font-size-base);
		line-height: var(--leading-relaxed);
	}

	.dispatch-content :global(p) {
		margin-bottom: 1.5em;
	}

	.member-gate {
		padding: var(--spacing-2xl);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
	}

	.member-gate h2 {
		font-family: var(--font-heading);
		font-size: var(--font-size-xl);
		font-weight: var(--font-weight-heading);
		margin-bottom: var(--spacing-sm);
	}

	.member-gate p {
		color: var(--color-muted);
	}

	.member-gate a {
		color: var(--color-text);
	}
</style>
```

- [ ] **Step 3: Verify the gate is real, not just visual**

Run: `npx emdash dev`. Create a test `dispatches` entry with distinctive placeholder text in `content` (something greppable, e.g. `"MEMBERS-ONLY-MARKER-TEXT"`), publish it. As a logged-out browser (or `curl http://localhost:4321/dispatches/<slug>` with no cookies), fetch the page and confirm the marker text does **not** appear anywhere in the raw HTML response — not commented out, not in a hidden `<div>`, entirely absent. This is the one check in this whole plan that most directly protects against actually leaking paid content, so don't skip it or eyeball it in a browser only (view-source or curl, to see exactly what the server sent).

- [ ] **Step 4: Commit**

```bash
git add src/pages/dispatches
git commit -m "Add gated dispatches content pages"
```

---

### Task 10: `/members/login` page

**Files:**
- Create: `src/pages/members/login.astro`
- Modify: `package.json` (new dependency)

- [ ] **Step 1: Confirm the passkey REST payload shapes before wiring the client**

The REST API reference confirms these endpoints exist (`POST /_emdash/api/auth/passkey/options`, `POST /_emdash/api/auth/passkey/verify`, `POST /_emdash/api/auth/magic-link/send`, `GET /_emdash/api/auth/magic-link/verify`) but not their exact request/response bodies. WebAuthn's challenge/credential encoding is fiddly and easy to get subtly wrong by hand, so this plan uses `@simplewebauthn/browser` (a small, standard client library most WebAuthn server implementations are designed to pair with) rather than hand-rolling base64url/ArrayBuffer conversions — but that only works if EmDash's `options` response is shaped as a standard `PublicKeyCredentialRequestOptionsJSON` (the shape `@simplewebauthn/server` emits, which is a very common server-side counterpart). Before writing Step 3, call the endpoint directly and inspect the shape:

```bash
curl -X POST http://localhost:4321/_emdash/api/auth/passkey/options -H "Content-Type: application/json" -d '{}'
```

If the response matches `@simplewebauthn`'s expected shape (an object with `challenge`, `rpId`, `allowCredentials`, etc. as base64url strings), proceed with Step 3 as written. If it doesn't, adjust Step 3 to hand-construct the request instead — don't force a mismatched library onto a differently-shaped API.

- [ ] **Step 2: Add the WebAuthn client library**

Run: `pnpm add @simplewebauthn/browser`
Expected: adds one small dependency to `package.json`/`pnpm-lock.yaml`.

- [ ] **Step 3: Write the login page**

`src/pages/members/login.astro`:

```astro
---
import Base from "../../layouts/Base.astro";
---

<Base title="Member Login" description="Log in to read member-only content.">
	<div class="login-page">
		<h1 class="login-title">Member Login</h1>

		<button type="button" data-passkey-login class="login-button">
			Log in with a passkey
		</button>
		<p class="login-error" data-passkey-error hidden></p>

		<div class="login-divider"><span>or</span></div>

		<form data-magic-link-form>
			<div class="form-field">
				<label for="magic-link-email">Email</label>
				<input
					type="email"
					id="magic-link-email"
					name="email"
					required
					placeholder="you@example.com"
					autocomplete="email"
				/>
			</div>
			<button type="submit" class="login-button" data-magic-link-submit>
				Email me a login link
			</button>
			<p class="login-message" data-magic-link-message hidden></p>
		</form>
	</div>
</Base>

<script>
	import { startAuthentication } from "@simplewebauthn/browser";

	const unwrap = (payload: unknown): any => {
		if (payload && typeof payload === "object" && "data" in payload) {
			return (payload as { data: unknown }).data;
		}
		return payload;
	};

	const passkeyButton = document.querySelector<HTMLButtonElement>("[data-passkey-login]");
	const passkeyError = document.querySelector<HTMLElement>("[data-passkey-error]")!;

	passkeyButton?.addEventListener("click", async () => {
		passkeyError.hidden = true;
		try {
			const optionsRes = await fetch("/_emdash/api/auth/passkey/options", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({}),
			});
			const options = unwrap(await optionsRes.json());
			if (!optionsRes.ok || !options) {
				throw new Error("Could not start passkey login.");
			}

			const credential = await startAuthentication({ optionsJSON: options });

			const verifyRes = await fetch("/_emdash/api/auth/passkey/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify(credential),
			});
			const result = unwrap(await verifyRes.json());

			if (verifyRes.ok && result?.success !== false) {
				window.location.href = "/dispatches";
			} else {
				throw new Error(result?.error ?? "Passkey login failed.");
			}
		} catch (err) {
			passkeyError.textContent =
				err instanceof Error ? err.message : "Passkey login failed. Try the email link instead.";
			passkeyError.hidden = false;
		}
	});

	const magicLinkForm = document.querySelector<HTMLFormElement>("[data-magic-link-form]");
	const magicLinkMessage = document.querySelector<HTMLElement>("[data-magic-link-message]")!;

	magicLinkForm?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const submitButton = magicLinkForm.querySelector<HTMLButtonElement>("[data-magic-link-submit]")!;
		const email = new FormData(magicLinkForm).get("email");

		submitButton.disabled = true;
		try {
			const res = await fetch("/_emdash/api/auth/magic-link/send", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({ email }),
			});
			const data = unwrap(await res.json());
			magicLinkMessage.textContent =
				res.ok && data?.success !== false
					? "Check your email for a login link."
					: (data?.error ?? "Something went wrong. Please try again.");
			magicLinkMessage.hidden = false;
		} catch {
			magicLinkMessage.textContent = "Something went wrong. Please try again.";
			magicLinkMessage.hidden = false;
		} finally {
			submitButton.disabled = false;
		}
	});
</script>

<style>
	.login-page {
		max-width: 400px;
		margin: 0 auto;
		padding: var(--spacing-3xl) var(--spacing-lg);
	}

	.login-title {
		font-family: var(--font-heading);
		font-size: var(--font-size-3xl);
		font-weight: var(--font-weight-display);
		margin-bottom: var(--spacing-2xl);
		text-align: center;
	}

	.login-button {
		width: 100%;
		padding: var(--spacing-md) var(--spacing-xl);
		font-family: inherit;
		font-size: var(--font-size-sm);
		font-weight: 500;
		color: var(--color-bg);
		background: var(--color-text);
		border: none;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.login-button:hover:not(:disabled) {
		background: var(--color-brand);
		color: var(--color-on-brand);
	}

	.login-button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.login-divider {
		display: flex;
		align-items: center;
		gap: var(--spacing-md);
		margin: var(--spacing-xl) 0;
		color: var(--color-muted);
		font-size: var(--font-size-sm);
	}

	.login-divider::before,
	.login-divider::after {
		content: "";
		flex: 1;
		height: 1px;
		background: var(--color-border);
	}

	.form-field {
		display: flex;
		flex-direction: column;
		gap: var(--spacing-sm);
		margin-bottom: var(--spacing-lg);
	}

	.form-field label {
		font-size: var(--font-size-sm);
		font-weight: 500;
	}

	.form-field input {
		padding: var(--spacing-md);
		font-family: inherit;
		font-size: var(--font-size-base);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
	}

	.login-error {
		margin-top: var(--spacing-sm);
		color: var(--color-danger);
		font-size: var(--font-size-sm);
	}

	.login-message {
		margin-top: var(--spacing-sm);
		color: var(--color-muted);
		font-size: var(--font-size-sm);
	}
</style>
```

- [ ] **Step 4: Verify passkey login end-to-end**

Using a test Subscriber account created via the invite flow from Chunk 3's Task 7 verification (which should have a passkey registered by now, from accepting the invite email), visit `http://localhost:4321/members/login` and click "Log in with a passkey." Confirm the browser's platform passkey prompt appears, completing it redirects to `/dispatches`, and that the previously-gated dispatch from Task 9 Step 3 now shows its full content (re-run the raw-HTML check from that step, this time confirming the marker text **is** present).

- [ ] **Step 5: Verify magic-link request (and flag the redirect-destination gap)**

Submit the magic-link form with the test member's email. Confirm the "check your email" message appears, and (if email is configured for this dev environment) that an email actually arrives. Click the link and confirm it logs the browser in — but note where it lands: EmDash's magic-link verify endpoint controls the post-login redirect, and this plan doesn't know whether that's configurable per-request. If it lands somewhere unhelpful (e.g. `/_emdash/admin`, which a Subscriber can't do much with), that's a known, acceptable rough edge for this plan — the member is still logged in and can navigate to `/dispatches` manually. Note it for a possible follow-up rather than blocking on it here.

- [ ] **Step 6: Commit**

```bash
git add src/pages/members package.json pnpm-lock.yaml
git commit -m "Add member login page with passkey and magic-link authentication"
```

---

## Handoff

All four chunks are implemented and manually verified end-to-end: schema changes, Stripe-backed paid class signups, webhook-driven permanent membership via EmDash's own Subscriber role, and gated dispatches content. Two rough edges are explicitly flagged rather than silently accepted:

1. **Oversold paid signups** surface on the admin dashboard for manual resolution (refund or capacity exception) — there's no automated refund flow by design.
2. **Magic-link post-login redirect destination** is controlled by EmDash itself and wasn't confirmed to be configurable — a returning member using the magic-link path (rather than a passkey) may land somewhere other than `/dispatches` after logging in.

Before this goes live for real: set `STRIPE_SECRET_KEY` to a **live** (not test) key in the plugin's Payment Settings, set `STRIPE_WEBHOOK_SECRET`/`INTERNAL_WEBHOOK_SECRET` in the real deployment's secret store (not `.dev.vars`, which is dev-only), and register the production webhook endpoint URL in the Stripe dashboard pointing at `/api/webhooks/stripe` on the real domain.
