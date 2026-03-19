import { isTimestampWithinWindow, verifyHmacSignature } from '../lib/auth';
import { jsonErrorResponse, jsonResponse } from '../lib/http';
import type { Env } from '../index';
import { registerDeviceAndSubscriptions } from '../services/register-service';
import type { RegisterRequest } from '../types';

/**
 * Handles POST /register and applies signed registration updates.
 */
export async function handleRegister(request: Request, env: Env): Promise<Response> {
	const signature = request.headers.get('X-Signature');
	if (!signature) {
		return new Response('Unauthorized', { status: 401 });
	}

	const rawBody = await request.text();
	const isSignatureValid = await verifyHmacSignature(rawBody, signature, env.APP_SECRET);
	if (!isSignatureValid) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body: RegisterRequest;
	try {
		body = JSON.parse(rawBody) as RegisterRequest;
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	if (!body.deck_id) {
		return new Response('Missing deck_id', { status: 400 });
	}

	if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
		return new Response('Missing or invalid timestamp', { status: 400 });
	}

	if (!isTimestampWithinWindow(body.timestamp)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const result = await registerDeviceAndSubscriptions(env, body);
	if (!result.ok) {
		return jsonErrorResponse(result.status, result.code, result.message);
	}

	return jsonResponse({ success: true, tokens: result.tokens });
}

