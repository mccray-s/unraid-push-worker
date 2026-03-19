/**
 * Builds a UTC day key (YYYY-MM-DD) for daily message aggregation.
 */
export function getTodayString(): string {
	const date = new Date();
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Generates a unique webhook token for server registration.
 */
export async function generateUniqueToken(db: D1Database): Promise<string> {
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

	while (true) {
		let token = '';
		const randomValues = new Uint8Array(10);
		crypto.getRandomValues(randomValues);

		for (let index = 0; index < randomValues.length; index += 1) {
			token += chars[randomValues[index] % chars.length];
		}

		const existing = await db.prepare('SELECT 1 FROM servers WHERE webhook_token = ?').bind(token).first();
		if (!existing) {
			return token;
		}
	}
}

