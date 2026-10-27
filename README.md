# KNIME Performance Test Engineer Home Assignment

A k6 project for the KNIME performance-engineering home assignment. It authenticates to the **provided candidate environment**, discovers workflow metadata through the Hub search/UI request sequence, sends one Ad-Hoc execution request per virtual user, and tracks each created job until a terminal workflow state is observed or the configured observation timeout is reached.

## AI assistance elaboration

AI-assisted tools were used to:

- ideas brainstorm, generate ideas, and sanity checks
- write code docummentation
- review and refactor code
- transfer helper methods and logic from my frameworks to this project
- rewrite and proofread text docs: README, Task 1 report, and Task 2 test plan

## Assignment coverage

- **Task 1:** 100 VUs, one execution attempt per VU, no intentional ramp-up; records job-creation errors, confirmed workflow successes/failures, cancellations, unknown outcomes, submission timing, and request metrics.

**Execution Report:** [task-1-execution-report.md](./docs/task-1-execution-report.md)

**k6 console output:** [console.log](./results/console.log)

**aggregate k6 metrics and checks:** [summary.json](./results/summary.json)

- **Task 2:** see [`task-2-test-plan.md`](./docs/task-2-test-plan.md) for the written upload-burst and endurance/soak strategy. No Task 2 implementation is included, as requested.

## Project layout

```text
docs/
  task-1-execution-report.md  Task 1 test execution report
  task-2-test-plan.md         Task 2 test plan
scripts/
  knime-main.js       k6 entry point, workload options, final summary
  knime-setup.js      one-time authentication and workflow/context discovery
  knime-workload.js   one execution request per VU and bounded outcome polling
lib/
  config.js           endpoints and runtime configuration
  helpers.js          request builders and response parsing helpers
  logging.js          debug pretty logging
  utils.js            supporting utilities
results/
  .gitkeep            output directory for run artifacts
  console.log         k6 console output and per-execution outcome records
  summary.json        aggregate k6 metrics and checks
```

## Prerequisites

- A local k6 installation.
- Network access to the KNIME candidate environment supplied for the assessment.
- The assignment credentials provided through environment variables. **Do not hardcode or commit credentials, cookies, or tokens.**
- Run tests only against the candidate environment; do not point this project at production or the public KNIME Community Hub.

The current configuration defaults to the assignment's candidate Hub/API/apps hostnames. Credentials have no built-in defaults and must be set explicitly. Setup prints a `KNIME_TEST_CONTEXT` line with the selected workflow name/ID and setup timestamp; it deliberately excludes the session token.

## Run

Create the output directory if needed:

```bash
mkdir -p results
```

On macOS/Linux or a Bash-compatible shell:

```bash
export KNIME_USERNAME='your-username'
export KNIME_PASSWORD='your-password'
export CONCURRENT_VUS='100'

k6 run scripts/knime-main.js 2>&1 | tee results/console.log
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force results | Out-Null
$env:KNIME_USERNAME = 'your-username'
$env:KNIME_PASSWORD = 'your-password'
$env:CONCURRENT_VUS = '100'

k6 run scripts/knime-main.js 2>&1 | Tee-Object -FilePath results/console.log
```

Replace the username/password placeholders locally with the credentials supplied for the assignment. Avoid committing shell transcripts that contain secrets. To run a reduced debugging test, you can set `CONCURRENT_VUS` to a smaller positive integer, then restore it to `100` for the required run.

### Optional settings

| Environment variable        |            Default | Meaning                                                                      |
| --------------------------- | -----------------: | ---------------------------------------------------------------------------- |
| `CONCURRENT_VUS`            |              `100` | Number of virtual users and execution attempts                               |
| `WORKFLOW_POLL_INTERVAL_MS` |             `2000` | Delay between status polls for a job not yet in a terminal state             |
| `WORKFLOW_POLL_TIMEOUT_MS`  |           `300000` | Maximum time to observe a job's terminal state (5 minutes)                   |
| `DEBUG`                     |            `false` | Enables diagnostic messages; authentication tokens are deliberately excluded |
| `KNIME_BASE_URL`            |  candidate Hub URL | Optional endpoint override for the assignment candidate only                 |
| `KNIME_API_URL`             |  candidate API URL | Optional endpoint override for the assignment candidate only                 |
| `KNIME_APPS_URL`            | candidate apps URL | Optional endpoint override for the assignment candidate only                 |
| `KNIME_AUTH_URL`            | candidate auth URL | Optional endpoint override for the assignment candidate only                 |

The poll timeout and interval control **outcome observation**, not a KNIME service SLA. A job without a confirmed terminal state is reported as unknown; it is never automatically counted as successful. The polling traffic is measured separately from the job-creation request.

## Metrics and outcome definitions

- `execution_attempts`: execution attempts initiated by VUs.
- `NUMBER_OF_JOBS`: successful HTTP 201 job-creation responses from which a usable job ID was extracted.
- `execution_submission_errors`: submission requests that failed or did not yield a usable job ID.
- `workflow_successes`: jobs whose observed workflow state was `EXECUTION_FINISHED`.
- `workflow_failures`: jobs whose state was `EXECUTION_FAILED` or `EXECUTION_FAILED_WITH_CONTENT`.
- `workflow_cancelled`: jobs whose workflow state was `EXECUTION_CANCELLED`.
- `workflow_outcomes_unknown`: jobs without a confirmed terminal result before timeout or after persistent status-observation errors.
- `workflow_submission_duration`: duration of the job-creation request.
- `submission_to_terminal_observation_time`: elapsed time from the execution request start until the script observes a terminal state or reaches the observation timeout. It includes polling/monitoring delay and is not an exact server-side execution duration.
- `submission_start_offset_ms`: VU submission start offsets relative to setup completion; the reported spread is max minus min.
- `JOB_STATE` and `WORKFLOW_STATE`: diagnostic state observations, **not** the primary completed-workflow counts.

The only configured k6 threshold verifies that the expected number of execution attempts occurred.

**No arbitrary latency or success-rate threshold is presented as a KNIME SLA because the assignment does not supply one.**

## Outputs

After a run:

- [`results/summary.json`](./results/summary.json) contains the complete k6 summary with built-in and custom metrics.
- [`results/console.log`](./results/console.log) contains the summary and one `EXECUTION_RESULT` JSON line per VU.
- Each `EXECUTION_RESULT` line contains the job ID, final outcome/state, submission status, and timings. It intentionally does not contain credentials or cookies.

## Limitations to state in the report

- Submission requests are scheduled by k6 with no intentional ramp-up, but exact same-millisecond starts are not guaranteed; report the measured start spread.
- The script's state classification relies on the `wizardExecutionState` values observed from the candidate Hub. Unknown states/outcomes are reported as unknown instead of inferred as success.
- The per-job status polling adds monitoring traffic after the workload request. Its request count and errors are recorded separately.
- The assignment does not supply performance SLAs or server-side resource telemetry. Report observations and explicitly identify any unavailable metrics.
