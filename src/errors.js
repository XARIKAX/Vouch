// ApiError carries the HTTP status and the error code from the docs. It lives
// in its own module so config and validation helpers can throw typed 400s
// without importing the engine (which would be a circular import).
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
