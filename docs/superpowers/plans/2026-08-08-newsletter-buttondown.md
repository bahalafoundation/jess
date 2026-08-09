# Buttondown Newsletter Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "subscribe to the newsletter" form to the contact page, backed by a small EmDash plugin that posts the email to Buttondown.

**Architecture:** A new sandboxed plugin (`newsletter`), modeled directly on the existing `class-signups` plugin (`plugins/class-signups/`) — same workspace-package shape, same `{ success, error }` return convention, and the same Block Kit `admin` route pattern `class-signups` already uses for its dashboard, here repurposed to hold a settings form for the secret API key (sandboxed plugins can't use the native-only `admin.settingsSchema` shortcut). One public route (`subscribe`). The contact page gets a second form calling that route via `fetch`, matching how `src/pages/classes/[slug].astro`'s signup form already calls its own plugin's routes.

**Tech Stack:** EmDash sandboxed plugin API (`emdash/plugin`), Astro, pnpm workspace package, Buttondown's subscribers API (`POST https://api.buttondown.com/v1/subscribers`, `Authorization: Token <key>`).

**Testing note:** This repo has no test runner (`package.json` has no `test` script, no vitest/jest, no `*.test.*` files anywhere). Verification steps in this plan are manual — dev server + `curl`/browser — following the project's own documented convention (CLAUDE.md: "start the dev server and use the feature in a browser"). Don't introduce a test framework as part of this plan; that would be unrelated scope.

---

## Chunk 1: Newsletter plugin + contact page integration

### Task 1: Scaffold the plugin package

**Files:**
- Create: `plugins/newsletter/package.json`
- Create: `plugins/newsletter/tsconfig.json`
- Create: `plugins/newsletter/src/index.ts`

- [ ] **Step 1: Create the package manifest**

Copy the shape of `plugins/class-signups/package.json` exactly, renaming the package:

```json
{
	"name": "@jess/plugin-newsletter",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./sandbox": "./src/sandbox-entry.ts"
	},
	"peerDependencies": {
		"emdash": "*"
	},
	"devDependencies": {
		"emdash": "^0.30.0"
	}
}
```

- [ ] **Step 2: Copy the tsconfig**

Copy `plugins/class-signups/tsconfig.json` to `plugins/newsletter/tsconfig.json` verbatim (read it first to confirm there's nothing class-signups-specific in it before copying).

- [ ] **Step 3: Write the plugin descriptor**

`plugins/newsletter/src/index.ts`:

`settingsSchema` is a **native-plugin-only** shortcut (confirmed via the EmDash docs: "The auto-generated `settingsSchema` form is native-only — for sandboxed plugins, expose the read/write through routes and render the form in Block Kit"). `class-signups` is a sandboxed plugin (`format: "standard"`) and this one is too, so settings need their own admin page + Block Kit route instead — built in Task 2.

```typescript
import type { PluginDescriptor } from "emdash";

export function newsletterPlugin(): PluginDescriptor {
	return {
		id: "newsletter",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@jess/plugin-newsletter/sandbox",
		options: {},
		capabilities: ["network:request"],
		allowedHosts: ["api.buttondown.com"],
		adminPages: [{ path: "/settings", label: "Newsletter Settings", icon: "mail" }],
	};
}
```

- [ ] **Step 4: Register the plugin in `pnpm-workspace.yaml` and root `package.json`**

Check `pnpm-workspace.yaml` for how `plugins/class-signups` is listed as a workspace member (it's almost certainly a glob like `plugins/*` already, in which case no change is needed — verify before editing). Add `"@jess/plugin-newsletter": "workspace:*"` to the root `package.json` `dependencies`, alongside the existing `"@jess/plugin-class-signups": "workspace:*"` entry.

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: completes without error; `node_modules/@jess/plugin-newsletter` symlinked to the workspace package.

- [ ] **Step 6: Commit**

```bash
git add plugins/newsletter package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "Scaffold newsletter plugin package"
```

---

### Task 2: Implement the `subscribe` route and Block Kit settings page

**Files:**
- Create: `plugins/newsletter/src/sandbox-entry.ts`

- [ ] **Step 1: Write the route handlers**

Mirror `plugins/class-signups/src/sandbox-entry.ts`'s conventions: the `fail()` helper, the comment explaining why failures are returned instead of thrown, and reuse the same `EMAIL_RE` validation pattern. The settings page follows the exact Block Kit pattern documented at `/plugins/creating-plugins/settings/` — a `page_load` interaction renders the form, `form_submit` saves it to KV — which is the same `routes.admin` shape `class-signups` already uses for its (read-only) signups dashboard.

**Note on the Buttondown "already subscribed" response:** the branch below guesses that a duplicate subscribe attempt returns HTTP 400 with a body shaped like `{ email: ["..."] }` containing the word "already". This is *not* verified against a real Buttondown response — confirm the actual shape with a live test call in Step 6 below and adjust the condition if it doesn't match. Until confirmed, a duplicate subscribe will fall through to the generic failure message, which is safe (if unfriendly) — it will never wrongly report success for an unrelated 400.

```typescript
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 0.30 turns thrown Responses into opaque INTERNAL_ERRORs, so user-facing
// failures are returned as { success: false, error } instead.
function fail(error: string) {
	return { success: false as const, error };
}

interface BlockInteraction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

async function renderSettings(ctx: PluginContext) {
	const apiKey = (await ctx.kv.get<string>("settings:apiKey")) ?? "";
	return {
		blocks: [
			{ type: "header", text: "Newsletter Settings" },
			{
				type: "form",
				block_id: "settings",
				fields: [
					{
						type: "secret_input",
						action_id: "apiKey",
						label: "Buttondown API Key",
						initial_value: apiKey,
					},
				],
				submit: { label: "Save", action_id: "save" },
			},
		],
	};
}

export default {
	routes: {
		subscribe: {
			public: true,
			handler: async (routeCtx: any, ctx: PluginContext) => {
				if (routeCtx.request.method !== "POST") {
					return fail("Method not allowed.");
				}

				const input = (routeCtx.input ?? {}) as Record<string, unknown>;
				const email = typeof input.email === "string" ? input.email.trim() : "";
				if (!EMAIL_RE.test(email)) {
					return fail("Please provide a valid email address.");
				}

				const apiKey = await ctx.kv.get<string>("settings:apiKey");
				if (!apiKey) {
					ctx.log.error("Newsletter signup attempted with no Buttondown API key configured");
					return fail("Newsletter signups aren't available right now.");
				}

				if (!ctx.http) {
					return fail("Newsletter signups aren't available right now.");
				}

				try {
					const res = await ctx.http.fetch("https://api.buttondown.com/v1/subscribers", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Token ${apiKey}`,
						},
						body: JSON.stringify({ email }),
					});

					if (res.ok) {
						return { success: true };
					}

					// UNVERIFIED — confirm this shape against a real Buttondown 400 response
					// (Step 6) before relying on it; see the note above the code block.
					const body = await res.json().catch(() => null);
					const alreadySubscribed =
						res.status === 400 &&
						Array.isArray((body as any)?.email) &&
						(body as any).email.some((msg: string) => /already/i.test(msg));

					if (alreadySubscribed) {
						return { success: true, alreadySubscribed: true };
					}

					ctx.log.error("Buttondown subscribe failed", { status: res.status });
					return fail("Something went wrong. Please try again.");
				} catch (err) {
					ctx.log.error("Buttondown subscribe request threw", { error: String(err) });
					return fail("Something went wrong. Please try again.");
				}
			},
		},

		admin: {
			handler: async (routeCtx: any, ctx: PluginContext) => {
				const interaction = (routeCtx.input ?? {}) as BlockInteraction;

				if (interaction.type === "page_load") {
					return renderSettings(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save") {
					const apiKey = interaction.values?.apiKey;
					if (typeof apiKey === "string") {
						await ctx.kv.set("settings:apiKey", apiKey);
					}
					return {
						...(await renderSettings(ctx)),
						toast: { message: "Settings saved", type: "success" },
					};
				}

				return { blocks: [] };
			},
		},
	},
} satisfies SandboxedPlugin;
```

- [ ] **Step 2: Register the plugin in `astro.config.mjs`**

**Modify:** `astro.config.mjs`

Add the import and register alongside the existing plugin:

```javascript
import { classSignupsPlugin } from "@jess/plugin-class-signups";
import { newsletterPlugin } from "@jess/plugin-newsletter";
```

```javascript
plugins: [classSignupsPlugin(), newsletterPlugin()],
```

- [ ] **Step 3: Start the dev server**

Run: `npx emdash dev`
Expected: starts without error; logs land in `.astro/dev.log`.

- [ ] **Step 4: Set the Buttondown API key**

In the admin UI (`http://localhost:4321/_emdash/admin`), find the **Newsletter Settings** page (registered via `adminPages` in Task 1 — it should appear in the sidebar under the plugin's section), and use the Block Kit form to enter a real (or Buttondown test-mode) API key, then Save. If you don't have a Buttondown account to test against yet, use a syntactically-plausible placeholder for now and revisit this step before shipping — the failure-path check in Step 6 below still works either way. This is also the point to confirm the "already subscribed" response shape noted in Task 2 Step 1: submit the same real email twice via the curl command in Step 5 and inspect the actual Buttondown response body on the second attempt, adjusting the `alreadySubscribed` check in `sandbox-entry.ts` if it doesn't match.

- [ ] **Step 5: Verify the happy path manually**

Run:
```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/newsletter/subscribe \
  -H "Content-Type: application/json" \
  -H "X-EmDash-Request: 1" \
  -d '{"email":"test@example.com"}'
```
Expected: `{"success":true,"data":{"success":true}}` (or the `alreadySubscribed` variant on a second run with the same email) if the API key is real; if using a placeholder key, expect `{"success":true,"data":{"success":false,"error":"Something went wrong. Please try again."}}` — confirm it's a clean handled failure, not a 500 or stack trace.

- [ ] **Step 6: Verify the invalid-email path**

Run:
```bash
curl -X POST http://localhost:4321/_emdash/api/plugins/newsletter/subscribe \
  -H "Content-Type: application/json" \
  -H "X-EmDash-Request: 1" \
  -d '{"email":"not-an-email"}'
```
Expected: `{"success":true,"data":{"success":false,"error":"Please provide a valid email address."}}`

- [ ] **Step 7: Commit**

```bash
git add plugins/newsletter astro.config.mjs
git commit -m "Add Buttondown subscribe route to newsletter plugin"
```

---

### Task 3: Wire the contact page form

**Files:**
- Modify: `src/pages/contact.astro`

- [ ] **Step 1: Add the newsletter form markup**

Read the current file first (it's reproduced in the design spec's research, but re-read live since this plan doesn't repeat it verbatim). Add a new section inside `<aside class="contact-info">`, after the existing `info-section` blocks (Location, Classes, Elsewhere) and before the closing `</aside>`:

```astro
<div class="info-section">
	<h3>Newsletter</h3>
	<form method="post" data-newsletter-form>
		<div class="newsletter-row">
			<input
				type="email"
				name="email"
				required
				placeholder="you@example.com"
				aria-label="Email address"
				data-newsletter-input
			/>
			<button type="submit" data-newsletter-submit>Subscribe</button>
		</div>
		<p class="newsletter-message" data-newsletter-message hidden></p>
	</form>
</div>
```

- [ ] **Step 2: Add the client-side script**

Add a `<script>` block after the existing markup (before the `<style>` block), following the same `fetch`/`unwrap` pattern used in `src/pages/classes/[slug].astro`:

```astro
<script>
	const form = document.querySelector<HTMLFormElement>("[data-newsletter-form]");

	if (form) {
		const input = form.querySelector<HTMLInputElement>("[data-newsletter-input]")!;
		const submitButton = form.querySelector<HTMLButtonElement>("[data-newsletter-submit]")!;
		const message = form.querySelector<HTMLElement>("[data-newsletter-message]")!;

		const unwrap = (payload: unknown): any => {
			if (payload && typeof payload === "object" && "data" in payload) {
				return (payload as { data: unknown }).data;
			}
			return payload;
		};

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			submitButton.disabled = true;
			submitButton.textContent = "Subscribing…";
			message.hidden = true;

			try {
				const res = await fetch("/_emdash/api/plugins/newsletter/subscribe", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-EmDash-Request": "1",
					},
					body: JSON.stringify({ email: input.value }),
				});
				const data = unwrap(await res.json());

				if (res.ok && data?.success) {
					message.textContent = data.alreadySubscribed
						? "You're already on the list."
						: "You're subscribed.";
					message.classList.remove("newsletter-error");
					message.hidden = false;
					form.reset();
				} else {
					message.textContent =
						typeof data?.error === "string" ? data.error : "Something went wrong. Please try again.";
					message.classList.add("newsletter-error");
					message.hidden = false;
				}
			} catch {
				message.textContent = "Something went wrong. Please try again.";
				message.classList.add("newsletter-error");
				message.hidden = false;
			} finally {
				submitButton.disabled = false;
				submitButton.textContent = "Subscribe";
			}
		});
	}
</script>
```

- [ ] **Step 3: Add styles**

Add to the existing `<style>` block, following the file's existing token usage:

```css
.newsletter-row {
	display: flex;
	gap: var(--spacing-sm);
}

.newsletter-row input {
	flex: 1;
	min-width: 0;
	padding: var(--spacing-sm) var(--spacing-md);
	font-family: inherit;
	font-size: var(--font-size-sm);
	color: var(--color-text);
	background: var(--color-surface);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
}

.newsletter-row input:focus {
	outline: none;
	border-color: var(--color-brand);
	box-shadow: 0 0 0 3px var(--color-brand-ring);
}

.newsletter-row button {
	padding: var(--spacing-sm) var(--spacing-md);
	font-family: inherit;
	font-size: var(--font-size-sm);
	font-weight: 500;
	color: var(--color-bg);
	background: var(--color-text);
	border: none;
	border-radius: var(--radius);
	cursor: pointer;
	white-space: nowrap;
}

.newsletter-row button:hover:not(:disabled) {
	background: var(--color-brand);
	color: var(--color-on-brand);
}

.newsletter-row button:disabled {
	opacity: 0.6;
	cursor: not-allowed;
}

.newsletter-message {
	margin-top: var(--spacing-sm);
	font-size: var(--font-size-sm);
	color: var(--color-muted);
}

.newsletter-message.newsletter-error {
	color: var(--color-danger);
}
```

- [ ] **Step 4: Verify in the browser**

Run: `npx emdash dev` (if not already running)
Visit `http://localhost:4321/contact`, enter an email in the newsletter field, submit. Confirm the message updates in place without a page reload, both for a valid submission and (temporarily typing an invalid address) for the validation-error path.

- [ ] **Step 5: Confirm the existing contact-message form still works**

Submit the existing name/email/message form on the same page. Confirm it still redisplays with its success state — the newsletter form's script must not interfere with it (different `<form>` element, no shared IDs).

- [ ] **Step 6: Commit**

```bash
git add src/pages/contact.astro
git commit -m "Add newsletter signup form to contact page"
```

---

## Handoff

Newsletter plugin is complete and independently shippable — it has no dependency on the membership/paid-classes work in the companion plan (`2026-08-08-membership-paid-classes-gated-content.md`).

Before considering this done for real (not just locally verified): get a real Buttondown API key into the plugin's admin settings in whatever environment this deploys to, and do one live end-to-end check against the actual Buttondown account (confirm the subscriber shows up in Buttondown's dashboard).
