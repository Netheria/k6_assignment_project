import { CONFIG } from '../lib/config.js';
import { metricValue, pretty, formatPercent } from '../lib/utils.js';
import { knimeSetup } from './knime-setup.js';
import { knimeWorkload } from './knime-workload.js';

/**
 * @file scripts/knime-main.js
 * @brief Entry point for the KNIME candidate-environment load test.
 *
 * The setup function authenticates and discovers the provided workflow once.
 * The workload runs one Ad-Hoc execution request per VU, then observes each
 * job's workflow state separately until a terminal state or a timeout.
 *
 * @usage
 * k6 run scripts/knime-main.js \
 *   -e DEBUG=false \
 *   -e CONCURRENT_VUS=100 \
 *   -e USERNAME=user \
 *   -e PASSWORD=pass
 */
export const options = {
  scenarios: {
    knimeWorkloadScenario: {
      executor: 'per-vu-iterations',
      exec: 'knimeWorkloadScenario',
      vus: CONFIG.CONCURRENT_VUS,
      iterations: 1,
      maxDuration: '10m',
    },
  },
  // This is a workload-completeness check, not a service-performance SLA.
  // Success/failure outcomes are reported as measurements rather than used as
  // k6 thresholds, so a failed workflow still produces useful evidence.
  thresholds: {
    execution_attempts: [`count==${CONFIG.CONCURRENT_VUS}`],
  },
  setupTimeout: '60s',
  teardownTimeout: '10s',
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function setup() {
  const authContext = knimeSetup();
  return {
    ...authContext,
    // Used only to measure the spread of request-start times across VUs.
    testStartTimeMs: Date.now(),
  };
}

export function knimeWorkloadScenario(dataFromSetup) {
  knimeWorkload(dataFromSetup);
}

export function handleSummary(data) {
  const firstOffset = metricValue(data, 'submission_start_offset_ms', 'min');
  const lastOffset = metricValue(data, 'submission_start_offset_ms', 'max');
  const spread =
    typeof firstOffset === 'number' && typeof lastOffset === 'number'
      ? `${pretty(lastOffset - firstOffset)} ms`
      : 'n/a';

  const summary = [
    'KNIME Ad-Hoc workflow execution summary',
    `Configured VUs: ${CONFIG.CONCURRENT_VUS}`,
    `Execution attempts: ${metricValue(data, 'execution_attempts', 'count')}`,
    `Jobs created: ${metricValue(data, 'NUMBER_OF_JOBS', 'count')}`,
    `Workflow successes: ${metricValue(data, 'workflow_successes', 'count')}`,
    `Workflow failures: ${metricValue(data, 'workflow_failures', 'count')}`,
    `Workflow cancellations: ${metricValue(data, 'workflow_cancelled', 'count')}`,
    `Unknown workflow outcomes: ${metricValue(data, 'workflow_outcomes_unknown', 'count')}`,
    `Submission errors: ${metricValue(data, 'execution_submission_errors', 'count')}`,
    `Submission-start spread: ${spread}`,
    `Submission duration p95: ${pretty(metricValue(data, 'workflow_submission_duration', 'p(95)'))} ms`,
    `Submission-to-terminal-observation duration p95: ${pretty(metricValue(data, 'submission_to_terminal_observation_time', 'p(95)'))} ms`,
    `HTTP request failure rate: ${formatPercent(metricValue(data, 'http_req_failed', 'rate'))}`,
    `HTTP request duration p95: ${pretty(metricValue(data, 'http_req_duration', 'p(95)'))} ms`,
    `Status-poll requests: ${metricValue(data, 'workflow_status_poll_requests', 'count')}`,
    `Status-poll errors: ${metricValue(data, 'workflow_status_poll_errors', 'count')}`,
    '',
    'See results/summary.json for the complete k6 summary.',
    'Per-VU EXECUTION_RESULT lines are printed to stdout and can be retained in results/console.log.',
    '',
  ].join('\n');

  return {
    'results/summary.json': JSON.stringify(data, null, 2),
    stdout: summary,
  };
}
