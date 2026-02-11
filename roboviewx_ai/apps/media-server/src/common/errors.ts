export class AppError extends Error {
    constructor(public code: number, message: string) {
        super(message);
        this.name = 'AppError';
    }
}

export const Errors = {
    UNKNOWN: 500,
    INVALID_REQUEST: 400,
    NOT_FOUND: 404,
    AUTH_FAILED: 401,
    ROOM_FULL: 403,
    ALREADY_EXISTS: 409,
};
