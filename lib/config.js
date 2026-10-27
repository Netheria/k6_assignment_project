/**
 * @file lib/config.js
 * @brief Centralized configuration for KNIME workflow performance testing.
 *
 * Reads environment variables via __ENV (k6 runtime) and provides frozen CONFIG object.
 * All tunables: test execution parameters, API endpoints, credentials, reporting settings.
 *
 * @usage
 * import { CONFIG } from './lib/config.js';
 * const baseUrl = CONFIG.KNIME_BASE_URL;
 */

// ==============================================================================
// DEBUG & RUN MODES
// ==============================================================================

const DEBUG = Boolean(__ENV.DEBUG === 'true') || false;

// ==============================================================================
// TEST EXECUTION PARAMETERS
// ==============================================================================

/** @brief Read a positive integer environment variable with a default. */
function positiveIntegerEnv(name, defaultValue) {
  const rawValue = __ENV[name] || String(defaultValue);
  const parsedValue = Number.parseInt(rawValue, 10);
  if (
    !Number.isInteger(parsedValue) ||
    parsedValue <= 0 ||
    String(parsedValue) !== String(rawValue).trim()
  ) {
    throw new Error(`${name} must be a positive integer; received '${rawValue}'.`);
  }
  return parsedValue;
}

/** @brief Number of concurrent VUs. Default: 100. */
const CONCURRENT_VUS = positiveIntegerEnv('CONCURRENT_VUS', 100);

/** @brief Maximum time to observe a workflow's terminal state. Default: 5 minutes. */
const WORKFLOW_POLL_TIMEOUT_MS = positiveIntegerEnv('WORKFLOW_POLL_TIMEOUT_MS', 300000);

/** @brief Delay between workflow-state polls. Default: 2 seconds. */
const WORKFLOW_POLL_INTERVAL_MS = positiveIntegerEnv('WORKFLOW_POLL_INTERVAL_MS', 2000);

if (WORKFLOW_POLL_INTERVAL_MS >= WORKFLOW_POLL_TIMEOUT_MS) {
  throw new Error('WORKFLOW_POLL_INTERVAL_MS must be less than WORKFLOW_POLL_TIMEOUT_MS.');
}

/** @brief VU ramp-up duration. Default: '1m'. */
const RAMPUP_DURATION = __ENV.RAMPUP_DURATION || '1m';

/** @brief Think time between workflow steps (k6 format). Default: '1s'. */
const THINK_TIME = __ENV.THINK_TIME || '1s';

// ==============================================================================
// KNIME ENDPOINTS
// ==============================================================================

/** @brief KNIME base URL (main application). */
const KNIME_BASE_URL = __ENV.KNIME_BASE_URL || 'https://excercise.bhub-test.cloudops.knime.com';

/** @brief KNIME auth service URL. */
const KNIME_AUTH_URL =
  __ENV.KNIME_AUTH_URL || 'https://auth.excercise.bhub-test.cloudops.knime.com';

/** @brief KNIME API service URL. */
const KNIME_API_URL = __ENV.KNIME_API_URL || 'https://api.excercise.bhub-test.cloudops.knime.com';

/** @brief KNIME apps service URL (workflow execution results). */
const KNIME_APPS_URL =
  __ENV.KNIME_APPS_URL || 'https://apps.excercise.bhub-test.cloudops.knime.com';

// ==============================================================================
// AUTHENTICATION
// ==============================================================================

/** @brief Credentials must be supplied at runtime; never commit them. */
const KNIME_USERNAME = __ENV.KNIME_USERNAME || '';
const KNIME_PASSWORD = __ENV.KNIME_PASSWORD || '';

// ==============================================================================
// INFLUXDB (OPTIONAL - METRICS)
// ==============================================================================

/** @brief InfluxDB HTTP endpoint URL. */
const INFLUXDB_URL = __ENV.INFLUXDB_URL || 'http://127.0.0.1:8087';

/** @brief InfluxDB database name for k6 metrics. */
const INFLUXDB_DB = __ENV.INFLUXDB_DB || 'k6';

/**
 * @brief Frozen configuration object exported for use throughout the project.
 */
export const CONFIG = Object.freeze({
  DEBUG,
  CONCURRENT_VUS,
  WORKFLOW_POLL_TIMEOUT_MS,
  WORKFLOW_POLL_INTERVAL_MS,
  RAMPUP_DURATION,
  THINK_TIME,
  KNIME_BASE_URL,
  KNIME_AUTH_URL,
  KNIME_API_URL,
  KNIME_APPS_URL,
  KNIME_USERNAME,
  KNIME_PASSWORD,
  INFLUXDB_URL,
  INFLUXDB_DB,
});
