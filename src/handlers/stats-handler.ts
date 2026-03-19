import { jsonResponse } from '../lib/http';
import type { Env } from '../index';
import { fetchStatsPayload } from '../services/stats-service';

/**
 * Handles GET /stats and returns aggregate usage metrics for admins.
 */
export async function handleStats(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	const payload = await fetchStatsPayload(env);
	return jsonResponse(payload);
}

