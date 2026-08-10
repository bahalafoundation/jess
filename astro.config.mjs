import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { classSignupsPlugin } from "@jess/plugin-class-signups";
import { newsletterPlugin } from "@jess/plugin-newsletter";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

// The plugin calls back into the site's own /_emdash/api/auth/invite endpoint
// (server-to-server) and needs Stripe's API, so it must allow both hosts.
// Computed here (outside the sandbox) from SITE_URL with a localhost fallback
// for dev; a real SITE_URL must be set for deployment.
const siteHost = new URL(process.env.SITE_URL ?? "http://localhost:4321").host;

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [classSignupsPlugin({ siteHost }), newsletterPlugin()],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Playfair Display",
			cssVariable: "--font-heading",
			weights: [400, 500, 600, 700],
			fallbacks: ["serif"],
		},
	],
	devToolbar: { enabled: false },
});
