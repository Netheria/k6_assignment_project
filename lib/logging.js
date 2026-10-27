import { CONFIG } from './config.js';
import { safeStringify } from './utils.js';

/**
 * @brief Structured debug logger for k6 scenarios.
 *
 * @details
 * Lightweight helper for verbose debugging during development/debug runs.
 * Logs are emitted only when CONFIG.DEBUG === true to avoid impacting load performance.
 *
 * Automatically enriches logs with:
 *  - ISO timestamp
 *  - log level
 *  - current VU id (__VU)
 *  - script/scenario name
 *  - optional agent id
 *  - safely stringified payload
 *
 * Usage examples:
 * @code
 * debugLogger({ rawText: 'connected' });
 * debugLogger({ script: 'agents-ws', agent: 92, rawText: 'WS opened' });
 * debugLogger({ level: 'error', script: 'agents-ws', rawText: err });
 * @endcode
 * Usage example with a small wrapper:
 * @code
 * const log = (opts) =>
 *   debugLogger({ script: 'agents-ws-scenario', ...opts });
 * log({ rawText: 'connected' });
 * log({ level: 'error', rawText: err });
 * @endcode
 *
 * @param {Object} params
 * @param {string} [params.level='info']     Log level: 'info' | 'warn' | 'error'
 * @param {string} [params.script='unknown'] Script/scenario name for filtering
 * @param {?number} [params.agent=null]      Optional agent identifier
 * @param {?number} [params.client=null]     Optional client identifier
 * @param {*} params.rawText                 Message payload (string/object/any)
 */
export function debugLogger({
  level = 'info',
  script = 'unknown',
  agent = null,
  client = null,
  rawText = '',
} = {}) {
  if (!CONFIG.DEBUG) return;

  const ts = new Date().toISOString();
  const vu = typeof __VU !== 'undefined' ? __VU : '-';

  const msg = typeof rawText === 'string' ? rawText : safeStringify(rawText);

  const parts = [`[${ts}]`, `[${level.toUpperCase()}]`, `[VU:${vu}]`, `[script:${script}]`];

  if (agent != null) parts.push(`[Agent:${agent}]`);
  if (client != null) parts.push(`[Client:${client}]`);

  parts.push(msg);

  const out = parts.join(' ');

  switch (level) {
    case 'warn':
      console.warn(out);
      break;
    case 'error':
      console.error(out);
      break;
    default:
      console.log(out);
  }
}

export function maskHeaders(
  headers,
  maskKeys = ['api_access_token', 'authorization', 'Authorization'],
) {
  if (!headers) return headers;
  const safe = {};
  for (const k of Object.keys(headers)) {
    if (maskKeys.includes(k)) safe[k] = '***';
    else safe[k] = headers[k];
  }
  return safe;
}

/**
 * @brief Format HTTP request and response details for logging or debugging
 *
 * @details
 * Produces a multi-line string representation of an HTTP exchange. Combines request
 * metadata (URL, method, headers, body) with response metadata (status, headers, body,
 * timings) in a readable format. Request/response bodies and headers are truncated to
 * avoid overwhelming logs with large payloads. Sensitive headers can be masked on demand.
 *
 * Handles both direct (req, res) parameters and res.request convenience forms.
 * Non-string bodies are JSON-stringified; if stringification fails, falls back to String().
 * Long bodies (default: >10000 chars) are truncated with an ellipsis marker.
 *
 * @param {?Object} req HTTP request object (may be null/undefined if res.request is used)
 * @param {?Object} res HTTP response object with optional nested request
 * @param {Object} [opts] Configuration options
 * @param {boolean} [opts.mask=true] Whether to mask sensitive headers (via maskHeaders)
 * @param {number} [opts.maxBodyLength=10000] Max character length before truncating bodies
 *
 * @returns {string} Multi-line formatted request/response exchange
 *
 * @example
 * const res = http.post(url, body, headers);
 * console.log(prettyReqRes(null, res, { mask: true, maxBodyLength: 5000 }));
 */
export function prettyReqRes(req, res, opts = {}) {
  // opts: { mask: true|false, maxBodyLength: number }
  const mask = opts.mask === undefined ? true : Boolean(opts.mask);
  const maxLen = typeof opts.maxBodyLength === 'number' ? opts.maxBodyLength : 10000;

  // request info - prefer res.request if present, otherwise use separate vars
  const r = res && res.request ? res.request : req || {};
  const reqUrl = r.url || (req && req.url) || 'n/a';
  const reqMethod = r.method || (req && req.method) || 'n/a';
  const reqHeaders = mask
    ? maskHeaders(r.headers || (req && req.headers))
    : r.headers || (req && req.headers);
  let reqBody = r.body || (req && req.body) || null;
  if (reqBody && typeof reqBody !== 'string') {
    try {
      reqBody = JSON.stringify(reqBody);
    } catch (e) {
      reqBody = String(reqBody);
    }
  }
  if (reqBody && reqBody.length > maxLen) reqBody = reqBody.slice(0, maxLen) + '... (truncated)';

  // response info
  const status = res ? res.status : 'n/a';
  const respHeaders = res && res.headers ? res.headers : null;
  let respBody = res && res.body ? res.body : null;
  if (respBody && typeof respBody !== 'string') {
    try {
      respBody = JSON.stringify(respBody);
    } catch (e) {
      respBody = String(respBody);
    }
  }
  if (respBody && respBody.length > maxLen)
    respBody = respBody.slice(0, maxLen) + '... (truncated)';

  const timings = res && res.timings ? res.timings : null;

  // build multi-line string
  return [
    `--> REQUEST ${reqMethod} ${reqUrl}`,
    `    Request headers: ${JSON.stringify(reqHeaders, null, 2)}`,
    `    Request body: ${reqBody === null ? 'null' : reqBody}`,
    `<-- RESPONSE status=${status}`,
    `    Response headers: ${JSON.stringify(respHeaders, null, 2)}`,
    `    Response body: ${respBody === null ? 'null' : respBody}`,
    `    Timings: ${timings ? JSON.stringify(timings, null, 2) : 'n/a'}`,
  ].join('\n');
}

/**
 * @brief Emit a structured execution result line for per-VU evidence tracking
 *
 * @details
 * Logs one structured JSON line per VU iteration to stdout. Each line contains
 * the execution outcome, job ID, workflow state, HTTP status, timing metrics,
 * and optional reason for unknown outcomes. This format enables the run log to
 * serve as per-job evidence without storing credentials, cookies, or payloads.
 *
 * @param {Object} result Execution result object
 * @param {string} result.outcome Workflow outcome: 'SUCCESS' | 'FAILURE' | 'CANCELLED' | 'SUBMISSION_FAILED' | 'UNKNOWN'
 * @param {?string} result.jobId Job ID assigned by the API, or null if submission failed
 * @param {?string} result.finalState Final workflow execution state (e.g., 'EXECUTION_FINISHED')
 * @param {?number} result.httpStatus HTTP status code of the submission request
 * @param {?number} result.submissionDurationMs Duration in ms of the workflow submission POST
 * @param {?number} result.submissionToTerminalObservationMs Duration in ms from submission start to terminal state observation
 * @param {?string} result.reason Optional reason for unknown outcomes (e.g., 'poll_timeout', 'status_http_401')
 *
 * @example
 * emitResult({
 *   outcome: 'SUCCESS',
 *   jobId: '12345',
 *   finalState: 'EXECUTION_FINISHED',
 *   httpStatus: 201,
 *   submissionDurationMs: 150,
 *   submissionToTerminalObservationMs: 5200,
 *   reason: null,
 * });
 */
export function emitResult(result) {
  console.log(
    `EXECUTION_RESULT ${JSON.stringify({
      timestamp: new Date().toISOString(),
      vu: __VU,
      iteration: __ITER,
      ...result,
    })}`,
  );
}
