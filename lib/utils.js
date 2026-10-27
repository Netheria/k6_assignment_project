/**
 * @file Utility functions for load test scenarios
 *
 * @brief Common (general purpose) helper functions
 *
 * @details
 * Provides reusable utilities across all load-test scenarios and monitors:
 * - Time parsing and rounding for think-time configuration
 * - Safe JSON serialization with circular reference and buffer handling
 *
 * All functions are designed to be called frequently under load with minimal overhead.
 * Think-time parsing supports multiple formats (ms/s/m) for configuration flexibility.
 */

/**
 * @brief Safely serialize objects to JSON with circular reference detection
 *
 * @details
 * Handles circular references and oversized buffers gracefully, preventing
 * serialization crashes during error logging or debug output. Replaces circular
 * references with '[Circular]' and truncates long strings at 2000 characters.
 * Falls back to String(obj) if JSON.stringify fails, and returns '[unserializable]'
 * if all serialization methods fail.
 *
 * @param {*} obj Any JavaScript value to serialize
 * @returns {string} JSON string representation (or fallback string if serialization fails)
 *
 * @example
 * const circular = { a: 1 };
 * circular.self = circular;
 * console.log(safeStringify(circular)); // { "a": 1, "self": "[Circular]" }
 */
export function safeStringify(obj) {
  try {
    const cache = new Set();
    return JSON.stringify(
      obj,
      (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (cache.has(v)) return '[Circular]';
          cache.add(v);
        }
        // avoid large buffers: truncate long strings
        if (typeof v === 'string' && v.length > 2000) return v.slice(0, 2000) + '...[truncated]';
        return v;
      },
      2,
    );
  } catch (e) {
    try {
      return String(obj);
    } catch (e2) {
      return '[unserializable]';
    }
  }
}

/**
 * @brief Round a number up at a given decimal scale
 * @details
 * Rounds a number "up" in a BigDecimal-like sense by scaling it and applying:
 * - Math.ceil for positive numbers
 * - Math.floor for negative numbers
 *
 * This effectively rounds away from zero (BigDecimal RoundingMode.UP). For strictly
 * positive values (like percentages), this matches CEILING as well.
 *
 * @param {number} value Input number
 * @param {number} decimals Number of digits after decimal point to keep (>= 0)
 * @returns {number} Rounded-up number; returns 0 for non-finite inputs
 */
export function roundUp(value, decimals = 0) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const epsilon = 1e-12;
  const roundedScaled = scaled >= 0 ? Math.ceil(scaled - epsilon) : Math.floor(scaled + epsilon);
  return roundedScaled / factor;
}

/**
 * @brief Parser for think time sleeps
 * @details Does accept string representations of time and parses them to seconds
 * Format examples:
 * - milliseconds: "125" or "20504ms"
 * - seconds: "1s" or "1.5s"
 * - minutes: "2m" or "1.5m"
 *
 * @param {string} val String representation of time like "5s" or "1m"
 * @returns {Number} seconds (as float) for sleep()
 */
export function parseThinkTimeToSeconds(val) {
  if (val === undefined || val === null || val === '' || !val.match(/^\d+(\.\d+)?(ms|s|m)?$/i)) {
    throw new Error('Think time cannot be empty!');
  }
  if (typeof val !== 'string') {
    throw new Error(
      'Think time must be in string format like "1500ms", "5s", "1.5s", "2m" or a number as ms.',
    );
  }

  const v = val.trim().toLowerCase();

  // pure numeric string as ms: 125
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) / 1000;
  // ms: 20504ms
  if (/^\d+(\.\d+)?ms$/.test(v)) return Number(v.replace(/ms$/, '')) / 1000;
  // seconds, integer or float: 1s or 1.5s
  if (/^\d+(\.\d+)?s$/.test(v)) return Number(v.replace(/s$/, ''));
  // minutes: 2m
  if (/^\d+(\.\d+)?m$/.test(v)) return Number(v.replace(/m$/, '')) * 60;

  throw new Error(
    'Think time has invalid format. Use "1500ms", "5s", "1.5s", "2m" or a number as ms.',
  );
}

/**
 * @brief Extract a metric value from k6 summary data
 *
 * @param {Object} data k6 summary data object
 * @param {string} name Metric name (e.g., 'submission_start_offset_ms')
 * @param {string} key Metric key (e.g., 'min', 'max', 'count')
 * @returns {*} Metric value or 'n/a' if not found
 */
export function metricValue(data, name, key) {
  const metric = data.metrics && data.metrics[name];
  const value = metric && metric.values ? metric.values[key] : undefined;
  return value === undefined || value === null ? 'n/a' : value;
}

/**
 * @brief Format a number to fixed decimal places
 *
 * @param {*} value Value to format
 * @param {number} digits Number of decimal places (default: 2)
 * @returns {string|*} Formatted number or original value if not finite
 */
export function pretty(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : value;
}

/**
 * @brief Format a decimal value as a percentage string
 *
 * @param {*} value Decimal value to format (0.0-1.0 range)
 * @returns {string} Formatted percentage or 'n/a' if not a finite number
 */
export function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${pretty(value * 100)}%` : 'n/a';
}
