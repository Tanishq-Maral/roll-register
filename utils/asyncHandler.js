// Express doesn't automatically catch rejected promises thrown inside async
// route handlers - an unhandled rejection there would just hang the
// request. Wrapping a handler in this forwards any error to Express's
// error-handling middleware (see server.js), same as a synchronous throw.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
