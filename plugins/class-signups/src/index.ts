import type { PluginDescriptor } from "emdash";

export function classSignupsPlugin(): PluginDescriptor {
	return {
		id: "class-signups",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@jess/plugin-class-signups/sandbox",
		options: {},
		capabilities: ["content:read"],
		storage: {
			signups: {
				indexes: ["classId", "createdAt"],
			},
		},
		adminPages: [{ path: "/signups", label: "Class Signups", icon: "list" }],
	};
}
