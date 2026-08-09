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