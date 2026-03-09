import * as jose from 'jose';

/**
 * Environment variables and bindings for the Worker.
 */
export interface Env {
	DECK_KV: KVNamespace;
	APNS_TEAM_ID: string;
	APNS_KEY_ID: string;
	APNS_BUNDLE_ID: string;
	APNS_P8_KEY: string;
	ADMIN_SECRET: string;
	APNS_HOST: string;
}

/**
 * User data structure stored in KV.
 */
interface UserData {
	device_token?: string;
	servers?: Record<string, { name: string; webhook_token: string } | string>; // Support old and new format
	is_enabled?: boolean;
	created_at?: string;
	updated_at?: string;
}

/**
 * Main Fetch Handler
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		try {
			// 1. Route: POST /register
			if (path === '/register' && method === 'POST') {
				return await handleRegister(request, env);
			}

			// 2. Route: POST /webhook/:token
			const webhookTokenRegex = /^\/webhook\/([^/]+)$/;
			const webhookTokenMatch = path.match(webhookTokenRegex);
			if (webhookTokenMatch && method === 'POST') {
				const [, token] = webhookTokenMatch;
				return await handleWebhookToken(request, env, ctx, token);
			}

			// 3. Route: GET /stats
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
 * Handles device registration/update.
 * POST /register
 */
async function handleRegister(request: Request, env: Env): Promise<Response> {
	let body: any;
	try {
		body = await request.json();
	} catch (e) {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { deck_id, device_token, servers, is_enabled } = body;
	if (!deck_id) {
		return new Response('Missing deck_id', { status: 400 });
	}

	// Fetch existing user data
	const existingDataStr = await env.DECK_KV.get(deck_id);
	const isNewUser = !existingDataStr;

	let userData: UserData = {};
	const now = new Date().toISOString();

	if (existingDataStr) {
		try {
			userData = JSON.parse(existingDataStr);
		} catch (e) {
			userData = {};
		}
	}

	// Initialize created_at if not present
	if (!userData.created_at) {
		userData.created_at = now;
	}

	// Validate new tokens for collisions before saving anything
	if (servers) {
		for (const serverId of Object.keys(servers)) {
			const serverData = servers[serverId];
			if (typeof serverData === 'object' && serverData.webhook_token) {
				const tokenKey = `token:${serverData.webhook_token}`;
				const existingTokenStr = await env.DECK_KV.get(tokenKey);

				if (existingTokenStr) {
					try {
						const existingTokenInfo = JSON.parse(existingTokenStr);
						// If the token exists but belongs to a different device or server, it's a collision
						if (existingTokenInfo.deck_id !== deck_id || existingTokenInfo.server_id !== serverId) {
							return jsonResponse({
								success: false,
								error: 'Token collision detected',
								collided_token: serverData.webhook_token
							}, 409);
						}
					} catch (e) {
						// Invalid JSON in KV, safe to overwrite
					}
				}
			}
		}
	}

	// Find orphaned tokens that need to be deleted
	const tokensToDelete: string[] = [];
	if (servers && existingDataStr) {
		for (const serverId of Object.keys(userData.servers || {})) {
			const oldServerData = (userData.servers as any)[serverId];
			const newServerData = servers[serverId];

			// If server was deleted, or token changed
			if (typeof oldServerData === 'object' && oldServerData.webhook_token) {
				const oldToken = oldServerData.webhook_token;
				const isDeleted = !newServerData;
				const isChanged = newServerData && typeof newServerData === 'object' && newServerData.webhook_token !== oldToken;

				if (isDeleted || isChanged) {
					tokensToDelete.push(`token:${oldToken}`);
				}
			}
		}
	}

	// Update fields selectively
	if (device_token !== undefined) userData.device_token = device_token;
	if (servers !== undefined) userData.servers = servers;
	if (is_enabled !== undefined) userData.is_enabled = is_enabled;

	userData.updated_at = now;

	// Persist User Data to KV
	await env.DECK_KV.put(deck_id, JSON.stringify(userData));

	// Save new token mappings
	if (servers) {
		for (const serverId of Object.keys(servers)) {
			const serverData = servers[serverId];
			if (typeof serverData === 'object' && serverData.webhook_token) {
				const tokenInfo = { deck_id, server_id: serverId };
				await env.DECK_KV.put(`token:${serverData.webhook_token}`, JSON.stringify(tokenInfo));
			}
		}
	}

	// Clean up orphaned tokens
	for (const oldTokenKey of tokensToDelete) {
		await env.DECK_KV.delete(oldTokenKey);
	}

	// If new user, update global and daily registration stats
	if (isNewUser) {
		const today = getTodayString();
		await incrementKvCounter(env.DECK_KV, 'stats:users:total');
		await incrementKvCounter(env.DECK_KV, `stats:users:${today}`);
	}

	return jsonResponse({ success: true, is_new_user: isNewUser });
}

/**
 * Handles Unraid webhook alerts via short token.
 * POST /webhook/:token
 */
async function handleWebhookToken(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	token: string
): Promise<Response> {
	// 1. Look up deck_id and server_id from token
	const tokenDataStr = await env.DECK_KV.get(`token:${token}`);
	if (!tokenDataStr) {
		return new Response(`Invalid webhook token: ${token}`, { status: 404 });
	}

	let tokenInfo;
	try {
		tokenInfo = JSON.parse(tokenDataStr);
	} catch (e) {
		return new Response(`Corrupted token data`, { status: 500 });
	}

	const { deck_id, server_id } = tokenInfo;
	if (!deck_id || !server_id) {
		return new Response(`Invalid token mapping`, { status: 500 });
	}

	// 2. Forward to the main webhook handler
	return handleWebhook(request, env, ctx, deck_id, server_id);
}

/**
 * Handles Unraid webhook alerts and forwards them to APNs.
 * POST /webhook/:deck_id/:server_id
 */
async function handleWebhook(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	deckId: string,
	serverId: string
): Promise<Response> {
	let payload: any;
	try {
		payload = await request.json();
	} catch (e) {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { event, subject, description, importance } = payload;

	// Validate user and permissions
	const userDataStr = await env.DECK_KV.get(deckId);
	if (!userDataStr) {
		return new Response(`Device not found for deck_id: ${deckId}`, { status: 404 });
	}

	let userData: UserData;
	try {
		userData = JSON.parse(userDataStr);
	} catch (e) {
		return new Response(`Corrupted data for deck_id: ${deckId}`, { status: 500 });
	}

	// Check if user has disabled notifications
	if (userData.is_enabled === false) {
		return new Response(`Notifications disabled for deck_id: ${deckId}`, { status: 403 });
	}

	const deviceToken = userData.device_token;
	if (!deviceToken) {
		return new Response(`No device token for deck_id: ${deckId}`, { status: 400 });
	}

	// Check if server is authorized for this device
	const serverEntry = userData.servers?.[serverId];
	const serverName = typeof serverEntry === 'object' ? serverEntry.name : serverEntry;

	if (!serverName) {
		return new Response(`Unauthorized: Server ID ${serverId} is not registered.`, { status: 403 });
	}

	const apnsPayload = {
		aps: {
			alert: {
				title: subject || 'Unraid Server Alert',
				subtitle: serverName, // Display server name in subtitle
				body: description || `Event: ${event || 'Unknown'}`,
			},
			sound: 'default',
			'interruption-level': (importance === 'warning' || importance === 'alert') ? 'active' : 'active',
			'thread-id': serverId, // Group notifications by server
			'mutable-content': 1 // Essential for iOS Service Extension badge updates
		},
		server_id: serverId,
		server_name: serverName,
		event,
		importance
	};

	try {
		const jwt = await generateApnsJwt(env.APNS_P8_KEY, env.APNS_KEY_ID, env.APNS_TEAM_ID);
		const apnsHost = env.APNS_HOST || 'api.push.apple.com';
		const url = `https://${apnsHost}/3/device/${deviceToken}`;

		const apnsResponse = await fetch(url, {
			method: 'POST',
			headers: {
				'authorization': `bearer ${jwt}`,
				'apns-topic': env.APNS_BUNDLE_ID,
				'apns-push-type': 'alert',
				'apns-priority': '10',
			},
			body: JSON.stringify(apnsPayload),
		});

		if (!apnsResponse.ok) {
			const errorText = await apnsResponse.text();
			console.error(`APNs Gateway Error: ${apnsResponse.status} - ${errorText}`);
			// Note: 410 Unregistered should ideally trigger token cleanup in a production system.
			return new Response(`APNs delivery failed: ${errorText}`, { status: apnsResponse.status });
		}

		// Update message statistics asynchronously
		ctx.waitUntil((async () => {
			const today = getTodayString();
			await incrementKvCounter(env.DECK_KV, `stats:msg:${today}`);
		})());

		return jsonResponse({ success: true });
	} catch (error: any) {
		console.error('APNs Request Failure:', error);
		return new Response(`APNs Communication Error: ${error.message}`, { status: 500 });
	}
}

/**
 * Retrieves aggregate statistics.
 * GET /stats
 */
async function handleStats(request: Request, env: Env): Promise<Response> {
	// Authentication
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	// Fetch all keys with 'stats:' prefix
	const statsList = await env.DECK_KV.list({ prefix: 'stats:' });
	const keys = statsList.keys.map(k => k.name);

	// Fetch all values in parallel for better performance
	const values = await Promise.all(keys.map(key => env.DECK_KV.get(key)));

	const result: any = {
		total_users: 0,
		daily_stats: {}
	};

	keys.forEach((key, index) => {
		const val = parseInt(values[index] || '0', 10);
		if (key === 'stats:users:total') {
			result.total_users = val;
		} else if (key.startsWith('stats:users:')) {
			const date = key.replace('stats:users:', '');
			ensureDateStat(result.daily_stats, date);
			result.daily_stats[date].new_users = val;
		} else if (key.startsWith('stats:msg:')) {
			const date = key.replace('stats:msg:', '');
			ensureDateStat(result.daily_stats, date);
			result.daily_stats[date].messages = val;
		}
	});

	return jsonResponse(result);
}

// ==========================================
// Helpers
// ==========================================

/**
 * Generates an APNs compliant JWT.
 */
async function generateApnsJwt(pkcs8Pem: string, kid: string, iss: string): Promise<string> {
	let formattedPem = pkcs8Pem;
	// Add PEM headers if missing
	if (!formattedPem.includes('-----BEGIN PRIVATE KEY-----')) {
		formattedPem = `-----BEGIN PRIVATE KEY-----\n${formattedPem}\n-----END PRIVATE KEY-----`;
	}
	// Normalize escaped newlines
	formattedPem = formattedPem.replace(/\\n/g, '\n');

	const privateKey = await jose.importPKCS8(formattedPem, 'ES256');

	return await new jose.SignJWT({})
		.setProtectedHeader({ alg: 'ES256', kid })
		.setIssuedAt()
		.setIssuer(iss)
		.sign(privateKey);
}

/**
 * Returns the current date in YYYY-MM-DD format.
 */
function getTodayString(): string {
	const date = new Date();
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Atomic-like increment for KV counters.
 */
async function incrementKvCounter(kv: KVNamespace, key: string): Promise<void> {
	const currentVal = await kv.get(key) || '0';
	const newVal = (parseInt(currentVal, 10) + 1).toString();
	await kv.put(key, newVal);
}

/**
 * Utility to ensure daily_stats object is initialized for a specific date.
 */
function ensureDateStat(stats: any, date: string) {
	if (!stats[date]) {
		stats[date] = { new_users: 0, messages: 0 };
	}
}

/**
 * Standard JSON response helper.
 */
function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
