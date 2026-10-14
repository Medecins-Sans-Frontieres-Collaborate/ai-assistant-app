const http = require('http');

// Identity stubs deliberately leave taint intact: only the query's modeled
// barriers can suppress these flows. This tests the model, not the helpers.
function sanitizeForLog(value) {
  return value;
}

function sanitizeForLogMultiple(...values) {
  return values;
}

http.createServer((req, res) => {
  console.log(req.url); // Alert: unsanitized remote input.
  console.log(sanitizeForLog(req.url)); // No alert: project barrier.
  console.log(sanitizeForLogMultiple(req.url)[0]); // No alert: array helper.
  console.log(`${sanitizeForLog(req.url)} ${req.url}`); // Alert: mixed input.
  console.log('constant'); // No alert: trusted value.
  res.end();
});
