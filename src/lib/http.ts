/**
 * Serializes payloads as JSON responses.
 */
export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * Builds a structured error response for machine-readable client handling.
 */
export function jsonErrorResponse(status: number, code: string, message: string): Response {
	return jsonResponse(
		{
			success: false,
			error: {
				code,
				message,
			},
		},
		status,
	);
}

