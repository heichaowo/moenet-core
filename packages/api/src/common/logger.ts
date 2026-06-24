/**
 * Structured Logger
 *
 * JSON-formatted logging with request context support.
 * Compatible with cloud logging services (CloudWatch, Stackdriver, etc.)
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
	requestId?: string;
	userId?: string;
	asn?: string;
	router?: string;
	[key: string]: unknown;
}

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	requestId?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
	error?: {
		name: string;
		message: string;
		stack?: string;
	};
}

// AsyncLocalStorage for request context (if available)
let currentContext: LogContext = {};

/**
 * Set logging context for current request
 */
export function setLogContext(ctx: LogContext): void {
	currentContext = { ...currentContext, ...ctx };
}

/**
 * Clear logging context
 */
export function clearLogContext(): void {
	currentContext = {};
}

/**
 * Get current log context
 */
export function getLogContext(): LogContext {
	return currentContext;
}

/**
 * Format log entry as JSON
 */
function formatLogEntry(
	level: LogLevel,
	message: string,
	metadata?: Record<string, unknown>,
	error?: Error,
): string {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		...currentContext,
	};

	if (metadata && Object.keys(metadata).length > 0) {
		entry.metadata = metadata;
	}

	if (error) {
		entry.error = {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	return JSON.stringify(entry);
}

/**
 * Determine if we should use JSON output
 */
function isProduction(): boolean {
	return process.env.NODE_ENV === "production";
}

/**
 * Output log to console
 */
function output(level: LogLevel, formatted: string): void {
	switch (level) {
		case "debug":
			console.debug(formatted);
			break;
		case "info":
			console.info(formatted);
			break;
		case "warn":
			console.warn(formatted);
			break;
		case "error":
			console.error(formatted);
			break;
	}
}

/**
 * Structured logger instance
 */
export const logger = {
	/**
	 * Debug level logging (not shown in production)
	 */
	debug(message: string, metadata?: Record<string, unknown>): void {
		if (isProduction()) return;
		output("debug", formatLogEntry("debug", message, metadata));
	},

	/**
	 * Info level logging
	 */
	info(message: string, metadata?: Record<string, unknown>): void {
		output("info", formatLogEntry("info", message, metadata));
	},

	/**
	 * Warning level logging
	 */
	warn(message: string, metadata?: Record<string, unknown>): void {
		output("warn", formatLogEntry("warn", message, metadata));
	},

	/**
	 * Error level logging
	 */
	error(
		message: string,
		error?: Error | unknown,
		metadata?: Record<string, unknown>,
	): void {
		const err = error instanceof Error ? error : undefined;
		if (error && !(error instanceof Error)) {
			// If error is not an Error instance, include it in metadata
			metadata = { ...metadata, errorValue: error };
		}
		output("error", formatLogEntry("error", message, metadata, err));
	},

	/**
	 * Create a child logger with additional context
	 */
	child(ctx: LogContext) {
		return {
			debug: (msg: string, meta?: Record<string, unknown>) => {
				setLogContext(ctx);
				logger.debug(msg, meta);
			},
			info: (msg: string, meta?: Record<string, unknown>) => {
				setLogContext(ctx);
				logger.info(msg, meta);
			},
			warn: (msg: string, meta?: Record<string, unknown>) => {
				setLogContext(ctx);
				logger.warn(msg, meta);
			},
			error: (
				msg: string,
				err?: Error | unknown,
				meta?: Record<string, unknown>,
			) => {
				setLogContext(ctx);
				logger.error(msg, err, meta);
			},
		};
	},
};

export default logger;
