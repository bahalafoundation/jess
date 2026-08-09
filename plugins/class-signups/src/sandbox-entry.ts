import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

interface Signup {
	classId: string;
	className: string;
	name: string;
	email: string;
	notes?: string;
	createdAt: string;
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
		blocks.push({
			type: "table",
			columns: [
				{ key: "name", label: "Name" },
				{ key: "email", label: "Email" },
				{ key: "notes", label: "Notes" },
				{ key: "createdAt", label: "Signed up" },
			],
			rows: group.signups.map((s) => ({
				name: s.name,
				email: s.email,
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
