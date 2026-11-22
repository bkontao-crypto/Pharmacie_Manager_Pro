'use strict';
class AppError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { AppError, wrap };
