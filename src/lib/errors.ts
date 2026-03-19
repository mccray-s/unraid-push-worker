/**
 * Converts unknown errors into stable strings for logs and HTTP responses.
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (typeof error === 'string' && error.length > 0) {
		return error;
	}

	return fallback;
}

