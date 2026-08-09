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
      "slug": "published_at",
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
