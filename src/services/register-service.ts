import { generateUniqueToken } from '../lib/db';
import type { Env } from '../index';
import type { RegisterRequest, RegisterServiceResult } from '../types';

/**
 * Applies register payload changes to devices, servers, and server subscriptions.
 */
export async function registerDeviceAndSubscriptions(env: Env, payload: RegisterRequest): Promise<RegisterServiceResult> {
	const deckId = payload.deck_id;
	const serverIds = Array.isArray(payload.server_ids) ? payload.server_ids : [];
	const isEnabledInt = payload.is_enabled !== false ? 1 : 0;
	const hasDeviceToken = typeof payload.device_token === 'string' && payload.device_token.length > 0;

	let deviceExists = false;
	if (hasDeviceToken) {
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
			.bind(deckId, payload.device_token as string, isEnabledInt)
			.run();
		deviceExists = true;
	} else {
		const existingDevice = await env.DB.prepare(`SELECT 1 FROM devices WHERE deck_id = ?1`).bind(deckId).first();
		deviceExists = !!existingDevice;

		if (deviceExists) {
			await env.DB.prepare(
				`
					UPDATE devices
					SET is_enabled = ?2, updated_at = CURRENT_TIMESTAMP
					WHERE deck_id = ?1
				`,
			)
				.bind(deckId, isEnabledInt)
				.run();
		}
	}

	if (!deviceExists && isEnabledInt === 1) {
		return {
			ok: false,
			status: 409,
			code: 'DEVICE_NOT_REGISTERED',
			message: 'Device must register with APNs device_token before enabling push subscriptions.',
		};
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

		const tokenValue = await env.DB.prepare(
			`
				SELECT webhook_token
				FROM servers
				WHERE server_id = ?1
			`,
		)
			.bind(serverId)
			.first('webhook_token');

		if (typeof tokenValue === 'string' && tokenValue.length > 0) {
			assignedTokens[serverId] = tokenValue;
		}

		if (deviceExists) {
			await env.DB.prepare(
				`
					INSERT INTO server_subscriptions (server_id, deck_id)
					VALUES (?1, ?2)
					ON CONFLICT(server_id, deck_id) DO NOTHING
				`,
			)
				.bind(serverId, deckId)
				.run();
		}
	}

	if (deviceExists && serverIds.length > 0) {
		const placeholders = serverIds.map(() => '?').join(',');
		await env.DB.prepare(
			`
				DELETE FROM server_subscriptions
				WHERE deck_id = ? AND server_id NOT IN (${placeholders})
			`,
		)
			.bind(deckId, ...serverIds)
			.run();
	} else if (deviceExists) {
		await env.DB.prepare(`DELETE FROM server_subscriptions WHERE deck_id = ?`).bind(deckId).run();
	}

	return { ok: true, tokens: assignedTokens };
}

