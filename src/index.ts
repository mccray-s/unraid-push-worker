import { getErrorMessage } from './lib/errors';
import { routeRequest } from './router';

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

/**
 * Worker entrypoint. Delegates route handling and preserves a global error boundary.
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await routeRequest(request, env, ctx);
		} catch (error: unknown) {
			console.error('Unhandled Global Error:', error);
			return new Response(`Internal Server Error: ${getErrorMessage(error)}`, { status: 500 });
		}
	},
};

