import * as jose from 'jose';

export interface Env {
	DB: D1Database;
	APNS_TEAM_ID: string;
	APNS_KEY_ID: string;
	APNS_BUNDLE_ID: string;
	APNS_P8_KEY: string;
	ADMIN_SECRET: string;
	APNS_HOST: string;
	APP_SECRET: string;
}

interface RegisterRequest {
	deck_id: string;
	device_token?: string;
	is_enabled?: boolean;
	server_ids?: string[];
}

interface WebhookRotateRequest {
	server_id: string;
}

interface WebhookPayload {
	title?: string;
	message?: string;
	importance?: string;
	timestamp?: string;
	link?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		try {
			if (path === '/register' && method === 'POST') {
				return await handleRegister(request, env);
			}

			const webhookRotateRegex = /^\/webhook\/([^/]+)\/rotate$/;
			const webhookRotateMatch = path.match(webhookRotateRegex);
			if (webhookRotateMatch && method === 'POST') {
				const [, token] = webhookRotateMatch;
				return await handleWebhookRotate(request, env, token);
			}

			const webhookTokenRegex = /^\/webhook\/([^/]+)$/;
			const webhookTokenMatch = path.match(webhookTokenRegex);
			if (webhookTokenMatch && method === 'POST') {
				const [, token] = webhookTokenMatch;
				return await handleWebhookToken(request, env, ctx, token);
			}

			if (path === '/stats' && method === 'GET') {
				return await handleStats(request, env);
			}

			return new Response('Not Found', { status: 404 });
		} catch (error: any) {
			console.error('Unhandled Global Error:', error);
			return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
		}
	},
};

// ==========================================
// Handlers
// ==========================================

/**
 * Handle Device Registration and Subscription
 * POST /register
 */
async function handleRegister(request: Request, env: Env): Promise<Response> {
	// HMAC signature verification
	const signature = request.headers.get('X-Signature');
	if (!signature) {
		return new Response('Unauthorized', { status: 401 });
	}
	const bodyText = await request.text();
	const isValid = await verifyHmacSignature(bodyText, signature, env.APP_SECRET);
	if (!isValid) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body: RegisterRequest;
	try {
		body = JSON.parse(bodyText);
	} catch (e) {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { deck_id, device_token, is_enabled } = body;
	if (!deck_id) {
		return new Response('Missing deck_id', { status: 400 });
	}

	const serverIds: string[] = Array.isArray(body.server_ids) ? body.server_ids : [];
	const isEnabledInt = is_enabled !== false ? 1 : 0;

	if (device_token) {
		await env.DB.prepare(
			`
			INSERT INTO devices (deck_id, device_token, is_enabled) 
			VALUES (?1, ?2, ?3)
			ON CONFLICT(deck_id) DO UPDATE SET 
				device_token = ?2,
				is_enabled = ?3,
				updated_at = CURRENT_TIMESTAMP
		`,
		)
			.bind(deck_id, device_token, isEnabledInt)
			.run();
	} else {
		await env.DB.prepare(
			`
            UPDATE devices SET is_enabled = ?2, updated_at = CURRENT_TIMESTAMP WHERE deck_id = ?1
        `,
		)
			.bind(deck_id, isEnabledInt)
			.run();
	}

	const assignedTokens: Record<string, string> = {};

	for (const serverId of serverIds) {
		const newToken = await generateUniqueToken(env.DB);

		await env.DB.prepare(
			`
            INSERT INTO servers (server_id, webhook_token)
            VALUES (?1, ?2)
            ON CONFLICT(server_id) DO NOTHING
        `,
		)
			.bind(serverId, newToken)
			.run();

		const tokenObj = await env.DB.prepare(
			`
            SELECT webhook_token FROM servers WHERE server_id = ?
        `,
		)
			.bind(serverId)
			.first('webhook_token');

		if (tokenObj) {
			assignedTokens[serverId] = tokenObj as string;
		}

		await env.DB.prepare(
			`
            INSERT INTO server_subscriptions (server_id, deck_id)
            VALUES (?1, ?2)
            ON CONFLICT(server_id, deck_id) DO NOTHING
        `,
		)
			.bind(serverId, deck_id)
			.run();
	}

	if (serverIds.length > 0) {
		const placeholders = serverIds.map(() => '?').join(',');
		await env.DB.prepare(
			`
            DELETE FROM server_subscriptions 
            WHERE deck_id = ? AND server_id NOT IN (${placeholders})
        `,
		)
			.bind(deck_id, ...serverIds)
			.run();
	} else {
		await env.DB.prepare(`DELETE FROM server_subscriptions WHERE deck_id = ?`).bind(deck_id).run();
	}

	return jsonResponse({ success: true, tokens: assignedTokens });
}

/**
 * Handle Webhook Token Rotation
 * POST /webhook/rotate
 */
async function handleWebhookRotate(request: Request, env: Env, currentToken: string): Promise<Response> {
	let body: WebhookRotateRequest;
	try {
		body = await request.json();
	} catch (e) {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { server_id } = body;
	if (!server_id) return new Response('Missing server_id', { status: 400 });

	// Verify that the provided token matches the server_id in DB
	const existing = await env.DB.prepare(
		`SELECT 1 FROM servers WHERE server_id = ? AND webhook_token = ?`,
	)
		.bind(server_id, currentToken)
		.first();

	if (!existing) {
		return new Response('Forbidden', { status: 403 });
	}

	const newToken = await generateUniqueToken(env.DB);

	await env.DB.prepare(`UPDATE servers SET webhook_token = ?1 WHERE server_id = ?2`)
		.bind(newToken, server_id)
		.run();

	return jsonResponse({ success: true, new_token: newToken });
}

/**
 * Handle Unraid Webhook Push Broadcasting
 * POST /webhook/:token
 */
async function handleWebhookToken(request: Request, env: Env, ctx: ExecutionContext, token: string): Promise<Response> {
	let payload: WebhookPayload;
	try {
		payload = await request.json();
	} catch (e) {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { title, message, importance, timestamp, link } = payload;

	const results = await env.DB.prepare(
		`
		SELECT s.server_id, d.device_token FROM servers s
		LEFT JOIN server_subscriptions sub ON s.server_id = sub.server_id
		LEFT JOIN devices d ON sub.deck_id = d.deck_id AND d.is_enabled = 1
		WHERE s.webhook_token = ?
	`,
	)
		.bind(token)
		.all();

	if (!results.results || results.results.length === 0) {
		return new Response(`Invalid webhook token`, { status: 404 });
	}

	const serverId = results.results[0].server_id as string;
	const deviceTokens = results.results.map((r) => r.device_token as string).filter((t) => !!t);

	const apnsPayload = {
		aps: {
			alert: {
				title: title || 'Unraid Server Alert',
				body: message || '',
			},
			sound: 'default',
			'interruption-level': importance?.toLowerCase() === 'warning' || importance?.toLowerCase() === 'alert' ? 'time-sensitive' : 'active',
			'thread-id': serverId,
			'mutable-content': 1,
		},
		server_id: serverId,
		importance,
		timestamp,
		link,
	};

	try {
		const jwt = await generateApnsJwt(env.APNS_P8_KEY, env.APNS_KEY_ID, env.APNS_TEAM_ID);
		const apnsHost = env.APNS_HOST || 'api.push.apple.com';

		const sendPromises = deviceTokens.map(async (deviceToken) => {
			const url = `https://${apnsHost}/3/device/${deviceToken}`;
			const apnsResponse = await fetch(url, {
				method: 'POST',
				headers: {
					authorization: `bearer ${jwt}`,
					'apns-topic': env.APNS_BUNDLE_ID,
					'apns-push-type': 'alert',
					'apns-priority': '10',
				},
				body: JSON.stringify(apnsPayload),
			});

			if (!apnsResponse.ok) {
				const errorText = await apnsResponse.text();
				console.error(`APNs Error for ${deviceToken}: ${apnsResponse.status} - ${errorText}`);

				if (apnsResponse.status === 410) {
					await env.DB.prepare(`DELETE FROM devices WHERE device_token = ?`).bind(deviceToken).run();
				}
			}
		});

		await Promise.all(sendPromises);

		ctx.waitUntil(
			(async () => {
				const today = getTodayString();

				await env.DB.prepare(
					`
				UPDATE servers SET message_count = message_count + 1 WHERE webhook_token = ?
			`,
				)
					.bind(token)
					.run();

				await env.DB.prepare(
					`
                INSERT INTO message_stats (date, message_count) VALUES (?1, 1)
                ON CONFLICT(date) DO UPDATE SET message_count = message_count + 1
            `,
				)
					.bind(today)
					.run();
			})(),
		);

		return jsonResponse({ success: true, broadcast_count: deviceTokens.length });
	} catch (error: any) {
		console.error('APNs Request Failure:', error);
		return new Response(`APNs Communication Error: ${error.message}`, { status: 500 });
	}
}

/**
 * Retrieves aggregate statistics from D1.
 * GET /stats
 */
async function handleStats(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	const totalUsers = await env.DB.prepare(`SELECT count(*) as total FROM devices`).first('total');

	const userStats = await env.DB.prepare(
		`
        SELECT date(created_at) as date, count(*) as count 
        FROM devices 
        GROUP BY date
        ORDER BY date DESC
        LIMIT 30
    `,
	).all();

	const msgStats = await env.DB.prepare(
		`
        SELECT date, message_count as count 
        FROM message_stats 
        ORDER BY date DESC
        LIMIT 30
    `,
	).all();

	const topServers = await env.DB.prepare(
		`
        SELECT server_id, message_count as count
        FROM servers
        ORDER BY message_count DESC
        LIMIT 10
    `,
	).all();

	const daily_stats: Record<string, { new_users: number; messages: number }> = {};

	for (const row of userStats.results) {
		const d = row.date as string;
		if (!daily_stats[d]) daily_stats[d] = { new_users: 0, messages: 0 };
		daily_stats[d].new_users = Number(row.count);
	}

	for (const row of msgStats.results) {
		const d = row.date as string;
		if (!daily_stats[d]) daily_stats[d] = { new_users: 0, messages: 0 };
		daily_stats[d].messages = Number(row.count);
	}

	return jsonResponse({
		total_users: Number(totalUsers || 0),
		top_active_servers: topServers.results,
		daily_stats,
	});
}

// ==========================================
// Helpers
// ==========================================

/**
 * Verify HMAC-SHA256 signature: HMAC(body, APP_SECRET)
 */
async function verifyHmacSignature(body: string, signature: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	const sigBytes = hexToBytes(signature);
	if (!sigBytes) return false;
	return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

async function generateApnsJwt(pkcs8Pem: string, kid: string, iss: string): Promise<string> {
	let formattedPem = pkcs8Pem;
	if (!formattedPem.includes('-----BEGIN PRIVATE KEY-----')) {
		formattedPem = `-----BEGIN PRIVATE KEY-----\n${formattedPem}\n-----END PRIVATE KEY-----`;
	}
	formattedPem = formattedPem.replace(/\\n/g, '\n');

	const privateKey = await jose.importPKCS8(formattedPem, 'ES256');

	return await new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid }).setIssuedAt().setIssuer(iss).sign(privateKey);
}

function getTodayString(): string {
	const date = new Date();
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

async function generateUniqueToken(db: D1Database): Promise<string> {
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

	while (true) {
		let token = '';
		const randomValues = new Uint8Array(10);
		crypto.getRandomValues(randomValues);
		for (let i = 0; i < 10; i++) {
			token += chars[randomValues[i] % chars.length];
		}

		const existing = await db.prepare('SELECT 1 FROM servers WHERE webhook_token = ?').bind(token).first();
		if (!existing) {
			return token;
		}
	}
}

function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
