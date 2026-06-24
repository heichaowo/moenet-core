import type { Context } from "hono";

/**
 * Standard response codes
 */
export enum ResponseCode {
	SUCCESS = 0,
	UNAUTHORIZED = 401,
	FORBIDDEN = 403,
	NOT_FOUND = 404,
	VALIDATION_ERROR = 422,
	INTERNAL_ERROR = 500,
}

/**
 * Standard API response format
 */
export interface ApiResponse<T = unknown> {
	code: ResponseCode;
	message: string;
	data?: T;
}

/**
 * Create a standard API response
 */
export function makeResponse<T>(
	c: Context,
	code: ResponseCode,
	data?: T,
	message?: string,
): Response {
	const messages: Record<ResponseCode, string> = {
		[ResponseCode.SUCCESS]: "Success",
		[ResponseCode.UNAUTHORIZED]: "Unauthorized",
		[ResponseCode.FORBIDDEN]: "Forbidden",
		[ResponseCode.NOT_FOUND]: "Not Found",
		[ResponseCode.VALIDATION_ERROR]: "Validation Error",
		[ResponseCode.INTERNAL_ERROR]: "Internal Server Error",
	};

	const response: ApiResponse<T> = {
		code,
		message: message || messages[code],
	};

	if (data !== undefined) {
		response.data = data;
	}

	const statusCode = code === ResponseCode.SUCCESS ? 200 : code;
	return c.json(response, statusCode as 200);
}

/**
 * Success response helper
 */
export function success<T>(
	c: Context,
	data?: T,
	message = "Success",
): Response {
	return makeResponse(c, ResponseCode.SUCCESS, data, message);
}

/**
 * Error response helper
 */
export function error(
	c: Context,
	code: ResponseCode,
	message?: string,
): Response {
	return makeResponse(c, code, undefined, message);
}
