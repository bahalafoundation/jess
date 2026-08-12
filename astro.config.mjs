import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { classSignupsPlugin } from "@jess/plugin-class-signups";
import { newsletterPlugin } from "@jess/plugin-newsletter";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

// The canonical origin. Passkeys bind to this host as their WebAuthn rpId and
// magic-link URLs are built from it, so it must be the domain people log in on
// -- serving the same deployment on a second registrable domain (a workers.dev
// subdomain) strands credentials registered against the other one.
const siteUrl =
	process.env.SITE_URL ??
	(process.env.NODE_ENV === "production" ? "https://jesscole.net" : "http://localhost:4321");

// The plugin calls back into the site's own /_emdash/api/auth/invite endpoint
// (server-to-server) and needs Stripe's API, so it must allow both hosts.
// Computed here, outside the sandbox, so the allowlist matches the real origin.
const siteHost = new URL(siteUrl).host;

export default defineConfig({
	site: siteUrl,
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			siteUrl,
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [
				classSignupsPlugin({ siteHost }),
				newsletterPlugin(),
				// Without an email:deliver provider the only handler on Workers is a
				// dev console stub, so magic-link login and invites fail in production.
				cloudflareEmail({ from: { email: "noreply@jesscole.net", name: "Jess Cole" } }),
			],
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
