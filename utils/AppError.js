class AppError extends Error {
  constructor(message, status = 500, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
    this.expose = status < 500;
  }
}

module.exports = AppError;
