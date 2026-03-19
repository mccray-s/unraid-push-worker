import { handleRegister } from './handlers/register-handler';
import { handleStats } from './handlers/stats-handler';
import { handleWebhookRotate, handleWebhookToken } from './handlers/webhook-handler';
import type { Env } from './index';

/**
 * Resolves route + method to the corresponding request handler.
 */
export async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	if (path === '/register' && method === 'POST') {
		return handleRegister(request, env);
	}

	const webhookRotateMatch = path.match(/^\/webhook\/([^/]+)\/rotate$/);
	if (webhookRotateMatch && method === 'POST') {
		const [, token] = webhookRotateMatch;
		return handleWebhookRotate(request, env, token);
	}

	const webhookTokenMatch = path.match(/^\/webhook\/([^/]+)$/);
	if (webhookTokenMatch && method === 'POST') {
		const [, token] = webhookTokenMatch;
		return handleWebhookToken(request, env, ctx, token);
	}

	if (path === '/stats' && method === 'GET') {
		return handleStats(request, env);
	}

	return new Response('Not Found', { status: 404 });
}

