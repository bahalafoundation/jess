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
