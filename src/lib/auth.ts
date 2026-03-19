const DEFAULT_TIMESTAMP_WINDOW_SECONDS = 120;

/**
 * Verifies HMAC-SHA256 signature over the raw request body.
 */
export async function verifyHmacSignature(rawBody: string, signatureHex: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);

	const signatureBytes = hexToBytes(signatureHex);
	if (!signatureBytes) {
		return false;
	}

	return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(rawBody));
}

/**
 * Checks whether the request timestamp is within the allowed drift window.
 */
export function isTimestampWithinWindow(
	timestampSeconds: number,
	windowSeconds = DEFAULT_TIMESTAMP_WINDOW_SECONDS,
): boolean {
	const nowSeconds = Math.floor(Date.now() / 1000);
	const drift = Math.abs(nowSeconds - Math.floor(timestampSeconds));
	return drift <= windowSeconds;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0) {
		return null;
	}

	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < hex.length; index += 2) {
		const parsed = Number.parseInt(hex.slice(index, index + 2), 16);
		if (Number.isNaN(parsed)) {
			return null;
		}
		bytes[index / 2] = parsed;
	}

	return bytes;
}

