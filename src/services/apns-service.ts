import * as jose from 'jose';

import { getErrorMessage } from '../lib/errors';
import type { Env } from '../index';
import type { ApnsDispatchResult, ApnsPayload, ApnsSendResult } from '../types';

interface DispatchApnsBatchParams {
	serverId: string;
	deviceTokens: string[];
	apnsHost: string;
	jwt: string;
	topic: string;
	payload: ApnsPayload;
}

interface SendToDeviceParams {
	serverId: string;
	deviceToken: string;
	apnsHost: string;
	jwt: string;
	topic: string;
	payload: ApnsPayload;
}

/**
 * Builds an APNs ES256 JWT from the configured .p8 key and metadata.
 */
export async function generateApnsJwt(pkcs8Pem: string, kid: string, iss: string): Promise<string> {
	let formattedPem = pkcs8Pem;
	if (!formattedPem.includes('-----BEGIN PRIVATE KEY-----')) {
		formattedPem = `-----BEGIN PRIVATE KEY-----\n${formattedPem}\n-----END PRIVATE KEY-----`;
	}
	formattedPem = formattedPem.replace(/\\n/g, '\n');

	const privateKey = await jose.importPKCS8(formattedPem, 'ES256');

	return new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid }).setIssuedAt().setIssuer(iss).sign(privateKey);
}

/**
 * Sends the APNs payload to every device token and aggregates delivery results.
 */
export async function dispatchApnsBatch(env: Env, params: DispatchApnsBatchParams): Promise<ApnsDispatchResult> {
	const { serverId, deviceTokens, apnsHost, jwt, topic, payload } = params;

	const settled = await Promise.allSettled(
		deviceTokens.map((deviceToken) =>
			sendToDeviceWithRetry(env, {
				serverId,
				deviceToken,
				apnsHost,
				jwt,
				topic,
				payload,
			}),
		),
	);

	const results: ApnsSendResult[] = settled.map((entry, index) => {
		if (entry.status === 'fulfilled') {
			return entry.value;
		}

		const token = deviceTokens[index] ?? 'unknown';
		return {
			token: redactToken(token),
			ok: false,
			status: null,
			reason: getErrorMessage(entry.reason, 'unknown_error'),
			attempts: 1,
			retryable: true,
		};
	});

	return {
		summary: {
			total: deviceTokens.length,
			success: results.filter((result) => result.ok).length,
			failed: results.filter((result) => !result.ok).length,
			retried: results.filter((result) => result.attempts > 1).length,
			invalid_token_removed: results.filter((result) => result.status === 410).length,
		},
		results,
	};
}

async function sendToDeviceWithRetry(env: Env, params: SendToDeviceParams): Promise<ApnsSendResult> {
	const { serverId, deviceToken, apnsHost, jwt, topic, payload } = params;
	const requestUrl = `https://${apnsHost}/3/device/${deviceToken}`;

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const apnsResponse = await fetch(requestUrl, {
				method: 'POST',
				headers: {
					authorization: `bearer ${jwt}`,
					'apns-topic': topic,
					'apns-push-type': 'alert',
					'apns-priority': '10',
				},
				body: JSON.stringify(payload),
			});

			if (apnsResponse.ok) {
				return {
					token: redactToken(deviceToken),
					ok: true,
					status: apnsResponse.status,
					reason: 'ok',
					attempts: attempt,
					retryable: false,
				};
			}

			const errorText = await apnsResponse.text();
			const reason = parseApnsReason(errorText);
			const retryable = isRetryableStatus(apnsResponse.status);

			console.error(
				`[apns] send_failed server_id=${serverId} token=${redactToken(deviceToken)} attempt=${attempt} status=${apnsResponse.status} retryable=${retryable} reason=${reason}`,
			);

			if (apnsResponse.status === 410) {
				await env.DB.prepare(`DELETE FROM devices WHERE device_token = ?`).bind(deviceToken).run();
			}

			if (retryable && attempt < 3) {
				await sleep(retryDelayMs(attempt));
				continue;
			}

			return {
				token: redactToken(deviceToken),
				ok: false,
				status: apnsResponse.status,
				reason,
				attempts: attempt,
				retryable,
			};
		} catch (error: unknown) {
			const reason = getErrorMessage(error, 'network_error');
			const retryable = true;

			console.error(
				`[apns] send_exception server_id=${serverId} token=${redactToken(deviceToken)} attempt=${attempt} retryable=${retryable} reason=${reason}`,
			);

			if (attempt < 3) {
				await sleep(retryDelayMs(attempt));
				continue;
			}

			return {
				token: redactToken(deviceToken),
				ok: false,
				status: null,
				reason,
				attempts: attempt,
				retryable,
			};
		}
	}

	return {
		token: redactToken(deviceToken),
		ok: false,
		status: null,
		reason: 'unknown',
		attempts: 3,
		retryable: true,
	};
}

function parseApnsReason(errorText: string): string {
	if (!errorText) {
		return 'unknown';
	}

	try {
		const parsed = JSON.parse(errorText) as { reason?: string };
		return parsed.reason || errorText;
	} catch {
		return errorText;
	}
}

function redactToken(token: string): string {
	if (token.length <= 12) {
		return `${token.slice(0, 4)}...`;
	}
	return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number): number {
	const delays = [200, 500, 1000];
	return delays[Math.min(attempt - 1, delays.length - 1)];
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

