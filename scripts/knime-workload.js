import { group, check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { CONFIG } from '../lib/config.js';
import { debugLogger } from '../lib/logging.js';
import { emitResult } from '../lib/logging.js';
import { buildJobExecutionRequest } from '../lib/helpers.js';

// Assignment-completeness and outcome counters
const EXECUTION_ATTEMPTS = new Counter('execution_attempts');
const NUMBER_OF_JOBS = new Counter('NUMBER_OF_JOBS');
const EXECUTION_SUBMISSION_ERRORS = new Counter('execution_submission_errors');
const WORKFLOW_SUCCESSES = new Counter('workflow_successes');
const WORKFLOW_FAILURES = new Counter('workflow_failures');
const WORKFLOW_CANCELLED = new Counter('workflow_cancelled');
const WORKFLOW_OUTCOMES_UNKNOWN = new Counter('workflow_outcomes_unknown');

// Diagnostic state and monitoring metric counters
const JOB_STATE = new Counter('JOB_STATE');
const WORKFLOW_STATE = new Counter('WORKFLOW_STATE');
const WORKFLOW_STATUS_POLL_REQUESTS = new Counter('workflow_status_poll_requests');
const WORKFLOW_STATUS_POLL_ERRORS = new Counter('workflow_status_poll_errors');
const MONITOR_ENDPOINT_ERRORS = new Counter('monitor_endpoint_errors');
const WORKFLOW_SUBMISSION_DURATION = new Trend('workflow_submission_duration', true);
const SUBMISSION_TO_TERMINAL_OBSERVATION_TIME = new Trend(
  'submission_to_terminal_observation_time',
  true,
);
const SUBMISSION_START_OFFSET = new Trend('submission_start_offset_ms', true);

const SUCCESS_STATE = 'EXECUTION_FINISHED';
const FAILURE_STATES = new Set(['EXECUTION_FAILED', 'EXECUTION_FAILED_WITH_CONTENT']);
const CANCELLED_STATE = 'EXECUTION_CANCELLED';

/**
 * @file scripts/knime-workload.js
 * @brief Per-VU workload: submit one Ad-Hoc workflow execution, then monitor until terminal state.
 *
 * @details
 * Each virtual user (VU) executes this function once per iteration. The workload consists of two
 * main phases:
 *
 * **Phase 1: Execute Workflow (measured request)**
 * - POST /execution/jobs with workflow configuration and parameters
 * - Expects HTTP 201 with job ID in response body
 * - Records submission duration and HTTP status
 * - Fails fast if job creation does not produce a job ID
 *
 * **Phase 2: Monitor Execution (diagnostic requests)**
 * - All monitoring requests are tagged separately so they don't inflate workload metrics
 * - Probes 5 endpoints to simulate a user navigating the job execution dashboard:
 *   1. GET /execution/jobs — View job state in execution list
 *   2. GET /w/{workflow}~{id}/{jobId} — View job page in apps domain
 *   3. GET /_/env — Fetch app environment data
 *   4. GET /workflow/wizard/current-page (polled) — Extract workflow final state
 *   5. GET /repository/{workflowId} — Refresh workflow metadata
 *
 * **Polling Strategy**
 * - Polls the wizard endpoint (request 4) until one of three terminal states is confirmed:
 *   - EXECUTION_FINISHED → 'SUCCESS' outcome
 *   - EXECUTION_FAILED or EXECUTION_FAILED_WITH_CONTENT → 'FAILURE' outcome
 *   - EXECUTION_CANCELLED → 'CANCELLED' outcome
 * - Polling respects CONFIG.WORKFLOW_POLL_TIMEOUT_MS deadline
 * - Non-terminal states (RUNNING, EXECUTING) trigger another poll iteration
 * - Permanent HTTP errors (401, 403, 404) break polling immediately
 * - Other errors are logged and retried within the deadline
 *
 * **Metrics Recorded (all tagged for outcome analysis)**
 * - execution_attempts — Count of VU attempts (always 1 per iteration)
 * - NUMBER_OF_JOBS — Count of successfully created jobs
 * - execution_submission_errors — Count and reason for submission failures
 * - SUBMISSION_START_OFFSET — Milliseconds from test start to VU submission (spread across VUs)
 * - workflow_submission_duration — HTTP duration of POST /execution/jobs (workload metric)
 * - SUBMISSION_TO_TERMINAL_OBSERVATION_TIME — Duration from submission to terminal state confirmation
 * - workflow_successes, workflow_failures, workflow_cancelled — Terminal outcome counters
 * - workflow_outcomes_unknown — Timed-out outcomes with reason
 * - JOB_STATE, WORKFLOW_STATE — Observed state transitions (diagnostic)
 * - WORKFLOW_STATUS_POLL_REQUESTS — Total polling request count
 * - WORKFLOW_STATUS_POLL_ERRORS — Poll request failures and reasons
 * - MONITOR_ENDPOINT_ERRORS — Endpoint-specific failures during monitoring phase
 *
 * **Result Emission**
 * - One structured EXECUTION_RESULT JSON line per VU per iteration to stdout
 * - Contains outcome, job ID, final state, HTTP status, timing, and optional reason
 * - Enables per-job evidence tracking in the test log without storing credentials
 *
 * @param {Object} authContext Authentication and workflow context from setup()
 * @param {string} authContext.knimeHubAuth Authenticated session token
 * @param {Object} authContext.workflowMetadata Discovered workflow details
 *   - workflowName, workflowId, spaceId, space, accountId, executionContextId
 * @param {number} authContext.testStartTimeMs Timestamp when test started (for spread metrics)
 *
 * @throws {Error} Only thrown if JSON parsing or internal state validation fails
 *   - HTTP errors, timeouts, and workflow failures are recorded as outcomes, not thrown
 */
export function knimeWorkload(authContext) {
  const log = (opts) => debugLogger({ script: 'workload', ...opts });
  const { knimeHubAuth, workflowMetadata, testStartTimeMs } = authContext;

  let submissionStartedAtMs = null;
  let jobId = null;
  let submissionStatus = null;
  let submissionDurationMs = null;
  let submissionError = null;

  // ========== EXECUTE WORKFLOW GROUP ==========
  group('Execute Workflow', () => {
    const jobRequest = buildJobExecutionRequest(CONFIG.KNIME_API_URL, workflowMetadata);
    submissionStartedAtMs = Date.now();
    SUBMISSION_START_OFFSET.add(
      Math.max(0, submissionStartedAtMs - (testStartTimeMs || submissionStartedAtMs)),
    );
    EXECUTION_ATTEMPTS.add(1);

    const res = http.post(jobRequest.url, jobRequest.body, {
      headers: jobRequest.headers,
      cookies: { knime_hub_auth: knimeHubAuth },
      tags: { name: 'execute_workflow' },
    });

    submissionStatus = res.status;
    submissionDurationMs = res.timings.duration;
    WORKFLOW_SUBMISSION_DURATION.add(submissionDurationMs);

    const jobCreated = check(res, {
      'job creation returned HTTP 201': (r) => r.status === 201,
    });

    if (!jobCreated) {
      submissionError = `unexpected_http_status_${res.status}`;
      EXECUTION_SUBMISSION_ERRORS.add(1, { reason: 'http_status' });
      log({
        level: 'error',
        rawText: `Execute Workflow: expected HTTP 201, got ${res.status}; response=${String(res.body).substring(0, 200)}`,
      });
      return;
    }

    try {
      const responseBody = res.json();
      jobId = responseBody && responseBody.id ? String(responseBody.id) : null;
    } catch (error) {
      submissionError = 'response_json_parse_error';
      EXECUTION_SUBMISSION_ERRORS.add(1, { reason: 'response_parse' });
      log({
        level: 'error',
        rawText: `Execute Workflow: could not parse job response JSON: ${error.message}`,
      });
      return;
    }

    if (!jobId) {
      submissionError = 'missing_job_id';
      EXECUTION_SUBMISSION_ERRORS.add(1, { reason: 'missing_job_id' });
      log({
        level: 'error',
        rawText: `Execute Workflow: HTTP 201 response did not contain a job ID.`,
      });
      return;
    }

    NUMBER_OF_JOBS.add(1);
    log({ rawText: `Execute Workflow: POST /jobs returned 201; jobId=${jobId}` });
  });

  // No job ID means no workflow outcome can be established
  // Keep the submit error separate from failed workflow executions
  if (!jobId) {
    emitResult({
      outcome: 'SUBMISSION_FAILED',
      jobId: null,
      finalState: null,
      httpStatus: submissionStatus,
      submissionDurationMs,
      submissionToTerminalObservationMs: null,
      reason: submissionError || 'job_id_unavailable',
    });
    return;
  }

  let outcome = 'UNKNOWN';
  let finalState = null;
  let outcomeReason = 'poll_timeout';
  let terminalObservationTimeMs = null;
  const completionStartedMs = submissionStartedAtMs || Date.now();

  // ========== MONITOR EXECUTION GROUP ==========
  group('Monitor Execution', () => {
    // 1. GET /_/bff/execution/jobs
    let res = http.get(
      `${CONFIG.KNIME_BASE_URL}/_/bff/execution/jobs?workflowId=${workflowMetadata.workflowId}`,
      {
        cookies: { knime_hub_auth: knimeHubAuth },
        tags: { name: 'monitor_execution_jobs' },
      },
    );

    if (check(res, { 'execution-jobs endpoint returned HTTP 200': (r) => r.status === 200 })) {
      try {
        const jobs = res.json('jobs') || [];
        const job = Array.isArray(jobs)
          ? jobs.find((candidate) => String(candidate.id) === jobId)
          : null;

        if (job && job.state) {
          JOB_STATE.add(1, { state: String(job.state) });
          log({ rawText: `KNIME Workload: Monitor Execution: observed job state=${job.state}` });
        } else {
          MONITOR_ENDPOINT_ERRORS.add(1, { endpoint: 'execution_jobs_job_missing' });
          log({
            level: 'warn',
            rawText: `KNIME Workload: Monitor Execution: job ${jobId} was not present in the execution-jobs response.`,
          });
        }
      } catch (error) {
        MONITOR_ENDPOINT_ERRORS.add(1, { endpoint: 'execution_jobs_parse' });
        log({
          level: 'warn',
          rawText: `KNIME Workload: Monitor Execution: unable to parse execution-jobs response: ${error.message}`,
        });
      }
    } else {
      MONITOR_ENDPOINT_ERRORS.add(1, { endpoint: 'execution_jobs' });
    }

    log({ rawText: `KNIME Workload: Monitor Execution: GET execution jobs -> ${res.status}` });

    // 2. GET /w/{workflowName}~{workflowId}/{jobId} (apps domain)
    res = http.get(
      `${CONFIG.KNIME_APPS_URL}/w/${encodeURIComponent(workflowMetadata.workflowName)}~${workflowMetadata.workflowId}/${jobId}`,
      {
        cookies: { knime_hub_auth: knimeHubAuth },
        tags: { name: 'monitor_app_job' },
      },
    );

    if (!check(res, { 'workflow job page returned HTTP 200': (r) => r.status === 200 })) {
      MONITOR_ENDPOINT_ERRORS.add(1, { endpoint: 'app_job_page' });
    }

    log({ rawText: `KNIME Workload: Monitor Execution: GET app job page -> ${res.status}` });

    // 3. GET /_/env (apps domain)
    res = http.get(`${CONFIG.KNIME_APPS_URL}/_/env`, {
      cookies: { knime_hub_auth: knimeHubAuth },
      tags: { name: 'monitor_env' },
    });

    if (!check(res, { 'app environment endpoint returned HTTP 200': (r) => r.status === 200 })) {
      MONITOR_ENDPOINT_ERRORS.add(1, { endpoint: 'app_env' });
    }

    log({ rawText: `KNIME Workload: Monitor Execution: GET env -> ${res.status}` });

    // 4. GET /_/api/jobs/{jobId}/workflow/wizard/current-page (apps domain)
    // Poll only the endpoint that returns wizardExecutionState.
    // This avoids treating a RUNNING/EXECUTING as a final result.
    const pollResult = pollWorkflowState(jobId, knimeHubAuth, log, completionStartedMs);
    outcome = pollResult.outcome;
    finalState = pollResult.finalState;
    outcomeReason = pollResult.reason;
    terminalObservationTimeMs = pollResult.observedAtMs;

    // 5. GET /_/api/repository/{workflowId} (apps domain)
    res = http.get(
      `${CONFIG.KNIME_APPS_URL}/_/api/repository/${workflowMetadata.workflowId}?version&details=aggregated`,
      {
        cookies: { knime_hub_auth: knimeHubAuth },
        tags: { name: 'monitor_repository' },
      },
    );

    if (!check(res, { 'repository endpoint returned HTTP 200': (r) => r.status === 200 })) {
      MONITOR_ENDPOINT_ERRORS.add(1, { endpoint: 'repository' });
    }

    log({ rawText: `KNIME Workload: Monitor Execution: GET repository -> ${res.status}` });
  });

  const submissionToTerminalObservationMs = Math.max(
    0,
    (terminalObservationTimeMs || Date.now()) - completionStartedMs,
  );
  SUBMISSION_TO_TERMINAL_OBSERVATION_TIME.add(submissionToTerminalObservationMs, {
    outcome: outcome.toLowerCase(),
  });

  if (outcome === 'SUCCESS') {
    WORKFLOW_SUCCESSES.add(1);
  } else if (outcome === 'FAILURE') {
    WORKFLOW_FAILURES.add(1, { state: finalState || 'UNKNOWN' });
  } else if (outcome === 'CANCELLED') {
    WORKFLOW_CANCELLED.add(1);
  } else {
    WORKFLOW_OUTCOMES_UNKNOWN.add(1, { reason: outcomeReason || 'unknown' });
  }

  emitResult({
    outcome,
    jobId,
    finalState,
    httpStatus: submissionStatus,
    submissionDurationMs,
    submissionToTerminalObservationMs,
    reason: outcome === 'UNKNOWN' ? outcomeReason : null,
  });
}

/**
 * @brief Poll the workflow wizard endpoint until a terminal state is observed or timeout
 *
 * @details
 * Repeatedly queries the current-page endpoint to extract the wizardExecutionState.
 * Polls until one of three terminal states is confirmed:
 * - SUCCESS_STATE ('EXECUTION_FINISHED'): workflow completed successfully
 * - FAILURE_STATES: workflow failed (either EXECUTION_FAILED or EXECUTION_FAILED_WITH_CONTENT)
 * - CANCELLED_STATE ('EXECUTION_CANCELLED'): workflow was cancelled
 *
 * Polling respects CONFIG.WORKFLOW_POLL_TIMEOUT_MS and CONFIG.WORKFLOW_POLL_INTERVAL_MS.
 * Non-terminal states (e.g., RUNNING, EXECUTING) trigger another poll iteration.
 * HTTP errors (401, 403, 404) break polling immediately as they indicate permanent failures.
 * Other HTTP errors are logged and retried within the deadline.
 *
 * Metrics are recorded for each poll request, error, and observed state transition.
 *
 * @param {string} jobId Unique identifier of the submitted job
 * @param {string} knimeHubAuth Authentication cookie value for hub requests
 * @param {Function} log Debug logger function (signature: log({ level?, rawText }))
 * @param {number} submissionStartedAtMs Timestamp in ms when the workflow was submitted
 *
 * @returns {Object} Poll result object
 * @returns {string} result.outcome Terminal outcome: 'SUCCESS' | 'FAILURE' | 'CANCELLED' | 'UNKNOWN'
 * @returns {?string} result.finalState Final observed workflow state (or latest non-terminal if timed out)
 * @returns {?string} result.reason Reason if outcome is 'UNKNOWN' (e.g., 'poll_timeout', 'status_http_401', 'missing_workflow_state')
 * @returns {number} result.observedAtMs Timestamp in ms when the result was determined
 */
function pollWorkflowState(jobId, knimeHubAuth, log, submissionStartedAtMs) {
  const url = `${CONFIG.KNIME_APPS_URL}/_/api/jobs/${jobId}/workflow/wizard/current-page`;
  const deadlineMs = submissionStartedAtMs + CONFIG.WORKFLOW_POLL_TIMEOUT_MS;

  let latestState = null;
  let latestStatus = null;
  let lastReason = 'poll_timeout';

  while (Date.now() <= deadlineMs) {
    WORKFLOW_STATUS_POLL_REQUESTS.add(1);

    const res = http.get(url, {
      cookies: { knime_hub_auth: knimeHubAuth },
      tags: { name: 'monitor_wizard_page' },
    });
    latestStatus = res.status;

    if (res.status !== 200) {
      WORKFLOW_STATUS_POLL_ERRORS.add(1, { http_status: String(res.status) });
      lastReason = `status_http_${res.status}`;
      log({
        level: 'warn',
        rawText: `KNIME Workload: Monitor Execution: status poll returned HTTP ${res.status} for job ${jobId}.`,
      });

      // A permanent auth/not-found response is unlikely to recover by polling.
      if ([401, 403, 404].includes(res.status)) break;
    } else {
      try {
        const stateValue = res.json('wizardExecutionState');
        latestState = typeof stateValue === 'string' ? stateValue : null;
      } catch (error) {
        latestState = null;
        WORKFLOW_STATUS_POLL_ERRORS.add(1, { http_status: 'json_parse' });
        lastReason = 'status_json_parse_error';
      }

      if (latestState) {
        WORKFLOW_STATE.add(1, { state: latestState });
        log({
          rawText: `KNIME Workload: Monitor Execution: observed workflow state=${latestState} for job ${jobId}`,
        });

        if (latestState === SUCCESS_STATE) {
          return {
            outcome: 'SUCCESS',
            finalState: latestState,
            reason: null,
            observedAtMs: Date.now(),
          };
        }
        if (FAILURE_STATES.has(latestState)) {
          return {
            outcome: 'FAILURE',
            finalState: latestState,
            reason: null,
            observedAtMs: Date.now(),
          };
        }
        if (latestState === CANCELLED_STATE) {
          return {
            outcome: 'CANCELLED',
            finalState: latestState,
            reason: null,
            observedAtMs: Date.now(),
          };
        }
        lastReason = 'non_terminal_state_timeout';
      } else {
        lastReason = 'missing_workflow_state';
      }
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    sleep(Math.min(CONFIG.WORKFLOW_POLL_INTERVAL_MS, remainingMs) / 1000);
  }

  log({
    level: 'warn',
    rawText: `KNIME Workload: Monitor Execution: no terminal workflow state confirmed for job ${jobId}; latestState=${latestState || 'n/a'}, latestHttpStatus=${latestStatus || 'n/a'}, reason=${lastReason}.`,
  });

  return {
    outcome: 'UNKNOWN',
    finalState: latestState,
    reason: lastReason,
    observedAtMs: Date.now(),
  };
}
