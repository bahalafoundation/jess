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
	({ adminPages: [{ path: "/settings", label: "Newsletter Settings", icon: "mail" }],
	};
}