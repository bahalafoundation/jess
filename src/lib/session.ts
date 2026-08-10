/**
 * Shared "current session" helper for gated pages.
 *
 * EmDash wires its auth middleware (`emdash/middleware/auth`, order "pre") into
 * Astro's chain, and that middleware soft-sets `App.Locals.user` for public
 * (site) routes whenever a valid session cookie is present — it never blocks
 * the request. So on any server-rendered page we can read `Astro.locals.user`
 * directly instead of doing a same-origin HTTP round-trip to
 * `GET /_emdash/api/auth/me`. This is faster and avoids the cookie-forwarding
 * edge cases of a self-fetch.
 *
 * The auth middleware resolves the session via the `astro-session` cookie, so
 * a logged-in visitor's request to any public page carries `locals.user`.
 */

export interface CurrentUser {
	id: string;
	email: string;
	role: number;
	name: string | null;
}

/** EmDash role levels — Subscriber = 10 and above unlock member content. */
const SUBSCRIBER_ROLE = 10;

/**
 * Extract the current authenticated user from the request's locals.
 * `Astro.locals` is typed as `App.Locals` (augmented by `emdash/locals`).
 */
export function getCurrentUser(locals: App.Locals): CurrentUser | null {
	const user = locals.user;
	if (!user) return null;
	return {
		id: user.id,
		email: user.email,
		role: user.role,
		name: user.name ?? null,
	};
}

export function isMember(user: CurrentUser | null): boolean {
	return user !== null && user.role >= SUBSCRIBER_ROLE;
}
