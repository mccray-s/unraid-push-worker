import { getErrorMessage } from '../lib/errors';
import { jsonResponse } from '../lib/http';
import type { Env } from '../index';
import { dispatchApnsBatch, generateApnsJwt } from '../services/apns-service';
import {
	buildApnsPayload,
	getWebhookDispatchContext,
	recordMessageStats,
	rotateWebhookToken,
} from '../services/webhook-service';
import type { WebhookPayload, WebhookRotateRequest } from '../types';

/**
 * Handles POST /webhook/:token/rotate and issues a new token.
 */
export async function handleWebhookRotate(request: Request, env: Env, currentToken: string): Promise<Response> {
	let body: WebhookRotateRequest;
	try {
		body = (await request.json()) as WebhookRotateRequest;
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	if (!body.server_id) {
		return new Response('Missing server_id', { status: 400 });
	}

	const newToken = await rotateWebhookToken(env, currentToken, body.server_id);
	if (!newToken) {
		return new Response('Forbidden', { status: 403 });
	}

	return jsonResponse({ success: true, new_token: newToken });
}

/**
 * Handles POST /webhook/:token and broadcasts notifications to subscribed devices.
 */
export async function handleWebhookToken(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	webhookToken: string,
): Promise<Response> {
	let payload: WebhookPayload;
	try {
		payload = (await request.json()) as WebhookPayload;
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const dispatchContext = await getWebhookDispatchContext(env, webhookToken);
	if (!dispatchContext) {
		return new Response('Invalid webhook token', { status: 404 });
	}

	const apnsPayload = buildApnsPayload(dispatchContext.serverId, payload);

	try {
		const jwt = await generateApnsJwt(env.APNS_P8_KEY, env.APNS_KEY_ID, env.APNS_TEAM_ID);
		const apnsHost = env.APNS_HOST || 'api.push.apple.com';
		const dispatch = await dispatchApnsBatch(env, {
			serverId: dispatchContext.serverId,
			deviceTokens: dispatchContext.deviceTokens,
			apnsHost,
			jwt,
			topic: env.APNS_BUNDLE_ID,
			payload: apnsPayload,
		});

		ctx.waitUntil(recordMessageStats(env, webhookToken));

		return jsonResponse({
			success: dispatch.summary.failed === 0,
			broadcast_count: dispatch.summary.success,
			failed_count: dispatch.summary.failed,
			retried_count: dispatch.summary.retried,
			summary: dispatch.summary,
			results: dispatch.results,
		});
	} catch (error: unknown) {
		const message = getErrorMessage(error);
		console.error('APNs Request Failure:', error);
		return new Response(`APNs Communication Error: ${message}`, { status: 500 });
	}
}

