import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";

export const prerender = false;

async function verifyStripeSignature(
	rawBody: string,
	sigHeader: string,
	secret: string,
): Promise<boolean> {
	// Stripe's header can carry more than one `v1=` pair during secret
	// rotation (the payload is signed with both the old and new endpoint
	// secrets for an overlap window) — collect ALL v1 values, don't keep only
	// the last one the way a naive Object.fromEntries over the split pairs
	// would.
	let timestamp: string | undefined;
	const signatures: string[] = [];
	for (const kv of sigHeader.split(",")) {
		const [key, value] = kv.split("=");
		if (key === "t") timestamp = value;
		if (key === "v1" && value) signatures.push(value);
	}
	if (!timestamp || signatures.length === 0) return false;

	// Reject stale signatures (Stripe's own recommended replay-attack guard).
	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(age) || age > 300) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signedPayload = `${timestamp}.${rawBody}`;
	const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
	const expectedHex = [...new Uint8Array(sigBuffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Match against ANY of the provided v1 signatures, not just one.
	return signatures.some((signature) => {
		if (expectedHex.length !== signature.length) return false;
		let mismatch = 0;
		for (let i = 0; i < expectedHex.length; i++) {
			mismatch |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
		}
		return mismatch === 0;
	});
}

export const POST: APIRoute = async (context) => {
	// NOTE (deviation from plan): the plan assumed request-time secrets arrive
	// via `context.locals.runtime.env`, but in this @astrojs/cloudflare version
	// createLocals() only populates `cfContext` — locals.runtime.env is never
	// set. The confirmed request-time secret mechanism here is `getSecret` from
	// `astro:env/server`, which reads any key from the adapter's runtime env
	// (`_getEnv(key)` -> createGetEnv(globalEnv)(key) -> globalEnv[key],
	// including .dev.vars in dev). See Task 5 Step 1's "adjust to the
	// confirmed mechanism" instruction.
	const webhookSecret = getSecret("STRIPE_WEBHOOK_SECRET");
	const internalSecret = getSecret("INTERNAL_WEBHOOK_SECRET");

	if (!webhookSecret || !internalSecret) {
		console.error("Stripe webhook endpoint called with secrets not configured");
		return new Response("Not configured", { status: 500 });
	}

	const signature = context.request.headers.get("stripe-signature");
	if (!signature) {
		return new Response("Missing signature", { status: 400 });
	}

	const rawBody = await context.request.text();
	const valid = await verifyStripeSignature(rawBody, signature, webhookSecret);
	if (!valid) {
		return new Response("Invalid signature", { status: 400 });
	}

	let event: any;
	try {
		event = JSON.parse(rawBody);
	} catch {
		return new Response("Invalid payload", { status: 400 });
	}

	if (event.type !== "checkout.session.completed") {
		return new Response(null, { status: 200 });
	}

	const session = event.data?.object ?? {};
	const metadata = session.metadata ?? {};

	const confirmRes = await fetch(
		new URL("/_emdash/api/plugins/class-signups/webhooks/confirm", context.request.url),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
				"X-Internal-Webhook-Secret": internalSecret,
			},
			body: JSON.stringify({
				stripeSessionId: session.id,
				classId: metadata.classId,
				name: metadata.name,
				email: metadata.email,
				notes: metadata.notes,
			}),
		},
	);

	// IMPORTANT: per this project's plugin API (see CLAUDE.md's documented
	// quirks), a route handler that *returns* `{ success: false, error }`
	// instead of throwing still comes back as a normal 200 wrapped in the
	// standard `{ success: true, data: <value> }` envelope. `confirmRes.ok`
	// alone would never catch a handler-level failure (wrong shared secret,
	// bad metadata, missing class) — only network errors or an actual thrown
	// Response. Unwrap the envelope and check the inner result explicitly.
	let confirmBody: any = null;
	try {
		confirmBody = await confirmRes.json();
	} catch {
		// leave confirmBody null — treated as failure below
	}
	const confirmData =
		confirmBody && typeof confirmBody === "object" && "data" in confirmBody
			? confirmBody.data
			: confirmBody;

	if (!confirmRes.ok || !confirmData?.success) {
		// Non-2xx (or a handler-level failure) tells Stripe to retry the webhook
		// later — appropriate for what's likely a transient or misconfiguration
		// failure (e.g. the shared secret drifted out of sync, or the confirm
		// route errored).
		console.error("class-signups webhook confirm failed", JSON.stringify(confirmBody));
		return new Response("Confirm failed", { status: 500 });
	}

	return new Response(null, { status: 200 });
};
