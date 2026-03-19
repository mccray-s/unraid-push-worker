import { generateUniqueToken, getTodayString } from '../lib/db';
import type { Env } from '../index';
import type { ApnsPayload, WebhookDispatchContext, WebhookPayload } from '../types';

/**
 * Rotates webhook token when the caller proves ownership of the current token.
 */
export async function rotateWebhookToken(env: Env, currentToken: string, serverId: string): Promise<string | null> {
	const existing = await env.DB.prepare(`SELECT 1 FROM servers WHERE server_id = ? AND webhook_token = ?`)
		.bind(serverId, currentToken)
		.first();

	if (!existing) {
		return null;
	}

	const newToken = await generateUniqueToken(env.DB);
	await env.DB.prepare(`UPDATE servers SET webhook_token = ?1 WHERE server_id = ?2`).bind(newToken, serverId).run();
	return newToken;
}

/**
 * Resolves server and subscribed device tokens from a webhook token.
 */
export async function getWebhookDispatchContext(
	env: Env,
	webhookToken: string,
): Promise<WebhookDispatchContext | null> {
	const result = await env.DB.prepare(
		`
			SELECT s.server_id, d.device_token
			FROM servers s
			LEFT JOIN server_subscriptions sub ON s.server_id = sub.server_id
			LEFT JOIN devices d ON sub.deck_id = d.deck_id AND d.is_enabled = 1
			WHERE s.webhook_token = ?
		`,
	)
		.bind(webhookToken)
		.all();

	if (!result.results || result.results.length === 0) {
		return null;
	}

	const serverId = result.results[0].server_id as string;
	const deviceTokens = result.results
		.map((row) => row.device_token as string | null)
		.filter((token): token is string => typeof token === 'string' && token.length > 0);

	return { serverId, deviceTokens };
}

/**
 * Creates APNs payload from webhook event fields.
 */
export function buildApnsPayload(serverId: string, payload: WebhookPayload): ApnsPayload {
	const importance = payload.importance?.toLowerCase();
	const interruptionLevel = importance === 'warning' || importance === 'alert' ? 'time-sensitive' : 'active';

	return {
		aps: {
			alert: {
				title: payload.title || 'Unraid Server Alert',
				body: payload.message || '',
			},
			sound: 'default',
			'interruption-level': interruptionLevel,
			'thread-id': serverId,
			'mutable-content': 1,
		},
		server_id: serverId,
		importance: payload.importance,
		timestamp: payload.timestamp,
		link: payload.link,
	};
}

/**
 * Updates per-server and per-day message counters asynchronously.
 */
export async function recordMessageStats(env: Env, webhookToken: string): Promise<void> {
	const today = getTodayString();

	await env.DB.prepare(`UPDATE servers SET message_count = message_count + 1 WHERE webhook_token = ?`)
		.bind(webhookToken)
		.run();

	await env.DB.prepare(
		`
            INSERT INTO message_stats (date, message_count) VALUES (?1, 1)
            ON CONFLICT(date) DO UPDATE SET message_count = message_count + 1
        `,
	)
		.bind(today)
		.run();
}

