import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

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

interface ClassInfo {
	id: string;
	title: string;
	startTime: Date | null;
	capacity: number;
	priceCents: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface BlockInteraction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

// 0.30 turns thrown Responses into opaque INTERNAL_ERRORs, so user-facing
// failures are returned as { success: false, error } instead.
function fail(error: string) {
	return { success: false as const, error };
}

// Constant-time string comparison for the shared-secret check below — matching
// the same constant-time-comparison approach used for the Stripe HMAC check in
// src/pages/api/webhooks/stripe.ts, for consistency rather than because the
// threat model strictly demands it here.
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

// Normalizes a content entry from ctx.content.get into the bits we need.
async function getClass(ctx: PluginContext, classId: string): Promise<ClassInfo | null> {
	if (!ctx.content) return null;
	let entry: any;
	try {
		entry = await ctx.content.get("classes", classId);
	} catch {
		return null;
	}
	if (!entry) return null;
	const data = entry.data && typeof entry.data === "object" ? entry.data : entry;
	const capacity = Number(data.capacity);
	const priceCents = Number(data.price_cents);
	const start = data.start_time ? new Date(data.start_time) : null;
	return {
		id: String(entry.id ?? classId),
		title: String(data.title ?? "Untitled class"),
		startTime: start && !Number.isNaN(start.getTime()) ? start : null,
		capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : Infinity,
		priceCents: Number.isFinite(priceCents) && priceCents > 0 ? priceCents : 0,
	};
}

async function countSignups(ctx: PluginContext, classId: string): Promise<number> {
	return ctx.storage.signups.count({ classId });
}

function signupId(classId: string, email: string): string {
	return `${classId}:${email.trim().toLowerCase()}`;
}

async function renderSignupsDashboard(ctx: PluginContext) {
	// Drain all signups (bounded — a portfolio site's class list stays small)
	const all: Array<{ id: string; data: Signup }> = [];
	let cursor: string | undefined;
	do {
		const result = await ctx.storage.signups.query({
			orderBy: { createdAt: "desc" },
			limit: 200,
			cursor,
		});
		all.push(...(result.items as Array<{ id: string; data: Signup }>));
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor && all.length < 2000);

	const byClass = new Map<string, Array<Signup>>();
	for (const item of all) {
		const list = byClass.get(item.data.classId) ?? [];
		list.push(item.data);
		byClass.set(item.data.classId, list);
	}

	const blocks: any[] = [
		{ type: "header", text: "Class Signups" },
		{
			type: "stats",
			stats: [
				{ label: "Total signups", value: String(all.length) },
				{ label: "Classes with signups", value: String(byClass.size) },
			],
		},
	];

	if (all.length === 0) {
		blocks.push({
			type: "section",
			text: "No signups yet. They'll appear here as soon as someone registers through the site.",
		});
		return { blocks };
	}

	// Sort class groups by soonest upcoming session first
	const groups = await Promise.all(
		[...byClass.entries()].map(async ([classId, signups]) => ({
			classId,
			signups,
			cls: await getClass(ctx, classId),
		})),
	);
	groups.sort((a, b) => {
		const ta = a.cls?.startTime?.getTime() ?? 0;
		const tb = b.cls?.startTime?.getTime() ?? 0;
		return ta - tb;
	});

	for (const group of groups) {
		const title = group.cls?.title ?? group.signups[0]?.className ?? "Unknown class";
		const when = group.cls?.startTime
			? group.cls.startTime.toLocaleString("en-US", {
					dateStyle: "medium",
					timeStyle: "short",
				})
			: "unscheduled";
		blocks.push({ type: "divider" });
		blocks.push({ type: "section", text: `${title} — ${when}` });
		if (group.cls && group.cls.capacity !== Infinity) {
			blocks.push({
				type: "meter",
				label: "Spots filled",
				value: group.signups.length,
				max: group.cls.capacity,
				custom_value: `${group.signups.length} / ${group.cls.capacity}`,
			});
		}
		if (group.signups.some((s) => s.oversold)) {
			blocks.push({
				type: "section",
				text: "⚠️ One or more paid signups for this class were recorded past capacity. Resolve manually (refund or accept the overage) — see the design spec's overselling note.",
			});
		}
		blocks.push({
			type: "table",
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
		});
	}

	return { blocks };
}

async function renderPaymentSettings(ctx: PluginContext) {
	const stripeSecretKey = (await ctx.kv.get<string>("settings:stripeSecretKey")) ?? "";
	const emdashInviteToken = (await ctx.kv.get<string>("settings:emdashInviteToken")) ?? "";
	const internalWebhookSecret = (await ctx.kv.get<string>("settings:internalWebhookSecret")) ?? "";
	return {
		blocks: [
			{ type: "header", text: "Payment Settings" },
			{
				type: "section",
				text: "The invite token is an EmDash personal access token with permission to invite users. Paste a Personal Access Token created from the admin panel (Settings → API Tokens, or wherever your EmDash version puts it).",
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
					{
						type: "secret_input",
						action_id: "internalWebhookSecret",
						label: "Internal Webhook Secret",
						initial_value: internalWebhookSecret,
					},
				],
				submit: { label: "Save", action_id: "save" },
			},
		],
	};
}

export default {
	routes: {
		signup: {
			public: true,
			handler: async (routeCtx: any, ctx: PluginContext) => {
				if (routeCtx.request.method !== "POST") {
					return fail("Method not allowed.");
				}

				const input = (routeCtx.input ?? {}) as Record<string, unknown>;
				const classId = typeof input.classId === "string" ? input.classId.trim() : "";
				const name = typeof input.name === "string" ? input.name.trim() : "";
				const email = typeof input.email === "string" ? input.email.trim() : "";
				const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 1000) : "";
				const classUrl = typeof input.classUrl === "string" ? input.classUrl.trim() : "";

				if (!classId) return fail("Missing classId.");
				if (!name || name.length > 200) return fail("Please provide your name.");
				if (!EMAIL_RE.test(email)) return fail("Please provide a valid email address.");
				if (!classUrl) return fail("Missing classUrl.");

				const cls = await getClass(ctx, classId);
				if (!cls) return fail("Class not found.");

				if (cls.startTime && cls.startTime.getTime() < Date.now()) {
					return { success: false, error: "Signups for this class have closed." };
				}

				const id = signupId(cls.id, email);
				if (await ctx.storage.signups.exists(id)) {
					return { success: true, alreadyRegistered: true };
				}

				const taken = await countSignups(ctx, cls.id);
				if (taken >= cls.capacity) {
					return { success: false, full: true, error: "This class is full." };
				}

				if (cls.priceCents > 0) {
					const stripeSecretKey = await ctx.kv.get<string>("settings:stripeSecretKey");
					if (!stripeSecretKey || !ctx.http) {
						ctx.log.error("Paid class signup attempted with Stripe not configured", {
							classId: cls.id,
						});
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
							ctx.log.error("Stripe checkout session creation failed", {
								status: res.status,
								body,
							});
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

				const record: Signup = {
					classId: cls.id,
					className: cls.title,
					name,
					email: email.toLowerCase(),
					notes: notes || undefined,
					createdAt: new Date().toISOString(),
				};
				await ctx.storage.signups.put(id, record);
				ctx.log.info(`New signup for ${cls.title}`, { classId: cls.id });

				const remaining = cls.capacity === Infinity ? null : cls.capacity - taken - 1;
				return { success: true, remaining };
			},
		},

		availability: {
			public: true,
			handler: async (routeCtx: any, ctx: PluginContext) => {
				// GET requests don't populate routeCtx.input — read the query string
				const url = new URL(routeCtx.request.url);
				const classId = url.searchParams.get("classId")?.trim() ?? "";
				if (!classId) return fail("Missing classId.");

				const cls = await getClass(ctx, classId);
				if (!cls) return fail("Class not found.");

				const taken = await countSignups(ctx, cls.id);
				const unlimited = cls.capacity === Infinity;
				const closed = cls.startTime ? cls.startTime.getTime() < Date.now() : false;
				return {
					capacity: unlimited ? null : cls.capacity,
					taken,
					remaining: unlimited ? null : Math.max(0, cls.capacity - taken),
					full: unlimited ? false : taken >= cls.capacity,
					closed,
				};
			},
		},

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
	},
} satisfies SandboxedPlugin;
