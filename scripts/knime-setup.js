import { group } from 'k6';
import http from 'k6/http';
import { CONFIG } from '../lib/config.js';
import { debugLogger } from '../lib/logging.js';
import {
  extractOAuthParams,
  extractWorkflowMetadata,
  extractCookieFromHeader,
  buildLoginRequest,
  validateResponseStatus,
  extractExecutionContext,
  buildSchemaUrl,
  buildHomeRedirectRequest,
} from '../lib/helpers.js';

/**
 * @file scripts/knime-setup.js
 * @brief One-time setup: executes OAuth/Keycloak auth flow using HAR-recorded request/response data.
 *
 * @details
 * Performs a complete OAuth 2.0 authentication flow via Keycloak to obtain a knime_hub_auth
 * token, then discovers and prepares a workflow for execution. The flow is structured in
 * request groups that mirror the HAR file organization and user-facing UI workflows:
 *
 * 1. **Entry** — Initial auth negotiation:
 *    - GET / → 307 redirect to /_/auth/login
 *    - GET /_/auth/login → 307 redirect + state/info cookies
 *    - GET Keycloak auth form → 200 with OAuth parameters (sessionCode, execution, clientId, etc.)
 *
 * 2. **Sign In** — Credential submission and token extraction:
 *    - POST Keycloak login form with username/password
 *    - GET callback URL → knime_hub_auth cookie set
 *    - GET home redirect to establish session
 *
 * 3. **Dashboard Entry** — Session activation and workflow discovery:
 *    - GET /secret-store/setup — Initialize secret storage
 *    - GET /_/auth/refresh — Refresh auth session
 *    - GET /search (collections, workflows) — Discover first available workflow
 *
 * 4. **Load Workflow** — Fetch workflow configuration and execution context:
 *    - GET /repository/{workflowId} — Workflow details and schema
 *    - GET /repository/{space} — Space metadata and permissions
 *    - GET /execution/limits/{accountId} — Check execution quota
 *    - GET /_/bff/execution/contexts — List available execution contexts
 *    - GET workflow configuration and image metadata
 *
 * 5. **Run Menu** — Prepare execution schema and deployment configuration:
 *    - GET workflow configuration (multiple calls to simulate UI navigation)
 *    - GET /_/schema/execution/deployments/adHoc (3 calls: initial, update, with context)
 *
 * All requests include appropriate headers and tags for metrics collection and debugging.
 *
 * @returns {Object} Auth context containing:
 *   - {string} knimeHubAuth — Authenticated session token (HAR-extracted)
 *   - {Object} workflowMetadata — Discovered workflow details:
 *     - workflowName, workflowId, spaceId, space, accountId, executionContextId
 *   - {string} timestamp — ISO timestamp when setup completed
 *
 * @throws {Error} If any critical request fails or required data cannot be extracted
 *   - Missing environment variables (KNIME_USERNAME, KNIME_PASSWORD)
 *   - Unexpected HTTP status codes
 *   - Failed OAuth parameter extraction or cookie handling
 *   - Workflow metadata parsing failures
 *
 * @example
 * const authContext = knimeSetup();
 * // authContext.knimeHubAuth is ready for workload requests
 * // authContext.workflowMetadata identifies the target workflow
 */
export function knimeSetup() {
  const log = (opts) => debugLogger({ script: 'setup', ...opts });

  if (!CONFIG.KNIME_USERNAME || !CONFIG.KNIME_PASSWORD) {
    throw new Error(
      'Set KNIME_USERNAME and KNIME_PASSWORD as environment variables before running the test.',
    );
  }
  log({ rawText: `KNIME Setup: Starting OAuth authentication flow` });

  let oauthParams;
  let knimeHubAuth;
  let authCookies = {
    state: null,
    info: null,
  };
  let workflowMetadata = {
    workflowName: null,
    workflowId: null,
    spaceId: null,
    space: null,
    accountId: null,
    executionContextId: null,
  };

  // ========== ENTRY GROUP ==========
  group('Entry', () => {
    // GET / -> expect 307 redirect to /_/auth/login
    let res = http.get(`${CONFIG.KNIME_BASE_URL}/`, {
      redirects: 0,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      },
      tags: { name: 'entry_root' },
    });

    log({ rawText: `KNIME Setup: Entry: GET / -> ${res.status}` });
    validateResponseStatus(res, 307, `Setup failed: Expected 307 from GET /, got ${res.status}`);

    // Extract redirect location
    const loginPageUrl = res.headers['Location'];
    if (!loginPageUrl) {
      throw new Error('Setup failed: No Location header from GET /');
    }

    // GET /_/auth/login -> expect 307 redirect to Keycloak
    res = http.get(`${CONFIG.KNIME_BASE_URL}${loginPageUrl}`, {
      redirects: 0,
      tags: { name: 'entry_auth_login' },
    });

    log({ rawText: `KNIME Setup: Entry: GET /_/auth/login -> ${res.status}` });
    validateResponseStatus(
      res,
      307,
      `Setup failed: Expected 307 from GET /_/auth/login, got ${res.status}`,
    );

    // Extract state and info cookies from Set-Cookie header
    const setCookieHeader = res.headers['Set-Cookie'];
    authCookies.state = extractCookieFromHeader(setCookieHeader, 'state');
    authCookies.info = extractCookieFromHeader(setCookieHeader, 'info');

    // Extract Keycloak auth URL
    const keycloakAuthUrl = res.headers['Location'];
    if (!keycloakAuthUrl) {
      throw new Error('Setup failed: No Location header from GET /_/auth/login');
    }

    // GET Keycloak auth endpoint -> expect 200 with login form
    res = http.get(keycloakAuthUrl, {
      redirects: 0,
      tags: { name: 'entry_keycloak_auth' },
    });

    log({ rawText: `KNIME Setup: Entry: GET Keycloak auth -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from Keycloak auth, got ${res.status}`,
    );

    oauthParams = extractOAuthParams(res.body.toString());

    if (!oauthParams) {
      throw new Error('Setup failed: Could not find form action URL in Keycloak login form');
    }

    const { sessionCode, execution, clientId, tabId, clientData } = oauthParams;
    if (!sessionCode || !execution || !clientId || !tabId || !clientData) {
      throw new Error('Setup failed: Could not extract all OAuth parameters');
    }

    log({ rawText: `KNIME Setup: Entry: Extracted OAuth parameters` });
  });

  // ========== SIGN IN GROUP ==========
  group('Sign In', () => {
    const loginRequest = buildLoginRequest(
      CONFIG.KNIME_AUTH_URL,
      oauthParams,
      CONFIG.KNIME_USERNAME,
      CONFIG.KNIME_PASSWORD,
    );

    let res = http.post(loginRequest.url, loginRequest.body, {
      headers: loginRequest.headers,
      tags: { name: 'signin_login_post' },
      redirects: 0,
    });

    log({ rawText: `KNIME Setup: Sign In: POST login -> ${res.status}` });
    validateResponseStatus(
      res,
      302,
      `Setup failed: Expected 302 from POST login, got ${res.status}`,
    );

    // Follow callback redirect with auto cookie jar management
    const callbackUrl = res.headers['Location'];
    if (!callbackUrl) {
      throw new Error('Setup failed: No Location header from POST login');
    }

    // GET callback - pass state and info cookies explicitly (cross-domain cookie issue)
    res = http.get(callbackUrl, {
      cookies: {
        state: authCookies.state,
        info: authCookies.info,
      },
      redirects: 0,
      tags: { name: 'signin_callback' },
    });

    log({ rawText: `KNIME Setup: Sign In: GET callback -> ${res.status}` });

    // Extract knime_hub_auth token from Set-Cookie header
    const setCookieHeader = res.headers['Set-Cookie'];
    knimeHubAuth = extractCookieFromHeader(setCookieHeader, 'knime_hub_auth');

    if (!knimeHubAuth) {
      log({
        level: 'error',
        rawText: `KNIME Setup: Sign In: knime_hub_auth token not found in callback response`,
      });
      throw new Error('Setup failed: knime_hub_auth token not found');
    }

    log({ rawText: `KNIME Setup: Sign In: Extracted knime_hub_auth token` });

    // Follow redirect to home page
    const redirectUrl = res.headers['Location'];
    if (!redirectUrl) {
      throw new Error('Setup failed: No Location header from callback');
    }

    const homeRequest = buildHomeRedirectRequest(CONFIG.KNIME_BASE_URL);
    res = http.get(homeRequest.url, {
      headers: homeRequest.headers,
      cookies: {
        knime_hub_auth: knimeHubAuth,
      },
      redirects: 0,
      tags: { name: 'signin_home' },
    });

    log({ rawText: `KNIME Setup: Sign In: GET redirect to home -> ${res.status}` });
  });

  // ========== DASHBOARD ENTRY GROUP ==========
  group('Dashboard Entry', () => {
    // GET /secret-store/setup
    let res = http.get(`${CONFIG.KNIME_API_URL}/secret-store/setup`, {
      tags: { name: 'dashboard_secret_store' },
    });

    log({ rawText: `KNIME Setup: Dashboard Entry: GET /secret-store/setup -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from /secret-store/setup, got ${res.status}`,
    );

    // GET /_/auth/refresh
    res = http.get(`${CONFIG.KNIME_BASE_URL}/_/auth/refresh`, {
      tags: { name: 'dashboard_auth_refresh' },
    });

    log({ rawText: `KNIME Setup: Dashboard Entry: GET /_/auth/refresh -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from /_/auth/refresh, got ${res.status}`,
    );

    // GET /search (collections)
    res = http.get(
      `${CONFIG.KNIME_API_URL}/search?offset=0&type=collection&limit=3&sort=maxKudos`,
      {
        tags: { name: 'dashboard_search_collections' },
      },
    );

    log({ rawText: `KNIME Setup: Dashboard Entry: GET /search (collections) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from /search collections, got ${res.status}`,
    );

    // GET /search (workflows)
    res = http.get(`${CONFIG.KNIME_API_URL}/search?offset=0&type=workflow&limit=3&sort=maxKudos`, {
      tags: { name: 'dashboard_search_workflows' },
    });

    log({ rawText: `KNIME Setup: Dashboard Entry: GET /search (workflows) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from /search workflows, got ${res.status}`,
    );

    // Extract workflow metadata from search response for Load Workflow group
    try {
      const metadata = extractWorkflowMetadata(res.body);
      workflowMetadata.workflowName = metadata.workflowName;
      workflowMetadata.workflowId = metadata.workflowId;
      workflowMetadata.accountId = metadata.accountId;
      workflowMetadata.space = metadata.space;
    } catch (e) {
      throw new Error(`Setup failed: Could not parse workflow search results: ${e.message}`);
    }
  });

  // ========== LOAD WORKFLOW GROUP ==========
  group('Load Workflow', () => {
    // 1. GET /repository/{workflowId}
    let res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/${workflowMetadata.workflowId}?version=current-state&details=aggregated&spaceDetails=true`,
      {
        tags: { name: 'workflow_details' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET workflow details -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from workflow details, got ${res.status}`,
    );

    // 2. GET /repository/{space}
    res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/${encodeURIComponent(workflowMetadata.space)}?details=aggregated&spaceDetails=true&version=current-state`,
      {
        tags: { name: 'space_details' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET space details -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from space details, got ${res.status}`,
    );
    workflowMetadata.spaceId = res.json().id;

    // 3. GET /_/bff/versions/savepoints
    res = http.get(
      `${CONFIG.KNIME_BASE_URL}/_/bff/versions/savepoints?workflowId=${workflowMetadata.workflowId}&limit=10&requestWithLabels=true`,
      {
        tags: { name: 'workflow_savepoints' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET savepoints -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from savepoints, got ${res.status}`,
    );

    // 4. GET /repository/{workflowId}:image
    res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/${workflowMetadata.workflowId}:image?version=current-state&timestamp=1792943370000`,
      {
        redirects: 0,
        tags: { name: 'workflow_image' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET workflow image -> ${res.status}` });
    validateResponseStatus(
      res,
      [200, 307],
      `Setup failed: Expected 200 or 307 from workflow image, got ${res.status}`,
    );

    // 5. GET /execution/limits/{accountId}/account-execution-enabled
    res = http.get(
      `${CONFIG.KNIME_API_URL}/execution/limits/${workflowMetadata.accountId}/account-execution-enabled`,
      {
        tags: { name: 'execution_enabled_check' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET execution enabled check -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from execution enabled check, got ${res.status}`,
    );

    // 6. GET /execution/limits/{accountId}
    res = http.get(`${CONFIG.KNIME_API_URL}/execution/limits/${workflowMetadata.accountId}`, {
      tags: { name: 'execution_limits' },
    });

    log({ rawText: `KNIME Setup: Load Workflow: GET execution limits -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from execution limits, got ${res.status}`,
    );

    // 7. GET /repository/{workflowId}:configuration
    res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/${workflowMetadata.workflowId}:configuration?version=current-state&includeRepresentation=true`,
      {
        tags: { name: 'workflow_configuration' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET workflow configuration -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from workflow configuration, got ${res.status}`,
    );

    // 8. GET /_/bff/execution/contexts
    res = http.get(
      `${CONFIG.KNIME_BASE_URL}/_/bff/execution/contexts?scope=${workflowMetadata.accountId}`,
      {
        tags: { name: 'execution_contexts' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET execution contexts -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from execution contexts, got ${res.status}`,
    );

    // Extract executionContextId from response
    try {
      workflowMetadata.executionContextId = extractExecutionContext(res.body);
    } catch (e) {
      throw new Error(`Setup failed: Could not parse execution contexts response: ${e.message}`);
    }

    // 9. GET /_/bff/execution/jobs
    res = http.get(
      `${CONFIG.KNIME_BASE_URL}/_/bff/execution/jobs?workflowId=${workflowMetadata.workflowId}&resolveVersionName=true&scope=${workflowMetadata.accountId}`,
      {
        tags: { name: 'execution_jobs' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET execution jobs -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from execution jobs, got ${res.status}`,
    );

    // 10. GET /_/bff/execution/contexts/status
    res = http.get(
      `${CONFIG.KNIME_BASE_URL}/_/bff/execution/contexts/status?executionContextIds=${workflowMetadata.executionContextId}`,
      {
        tags: { name: 'execution_context_status' },
      },
    );

    log({ rawText: `KNIME Setup: Load Workflow: GET execution context status -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from execution context status, got ${res.status}`,
    );
  });

  // ========== RUN MENU GROUP ==========
  group('Run menu', () => {
    // 1. GET /repository/Users/{accountId}
    let res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/Users/${encodeURIComponent(`${workflowMetadata.accountId}`)}/?spaceDetails=true&contribSpaces=children&cache-invalidation`,
      {
        tags: { name: 'run_menu_user_repo' },
      },
    );

    log({ rawText: `KNIME Setup: Run menu: GET user repository -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from user repository, got ${res.status}`,
    );

    // 2. GET /repository/{workflowId}:configuration
    res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/${workflowMetadata.workflowId}:configuration?version=current-state&includeRepresentation=true`,
      {
        tags: { name: 'run_menu_workflow_config_1' },
      },
    );

    log({ rawText: `KNIME Setup: Run menu: GET workflow configuration (1) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from workflow configuration, got ${res.status}`,
    );

    // 3. GET /_/schema/execution/deployments/adHoc (first call)
    const schemaUrl1 = buildSchemaUrl(CONFIG.KNIME_BASE_URL, workflowMetadata);

    res = http.get(schemaUrl1, {
      tags: { name: 'run_menu_schema_1' },
    });

    log({ rawText: `KNIME Setup: Run menu: GET schema deployments (1) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `KNIME Setup: Run menu: Expected 200 from schema deployments (1), got ${res.status}`,
    );

    // 4. GET /repository/{workflowId}:configuration (duplicate)
    res = http.get(
      `${CONFIG.KNIME_API_URL}/repository/${workflowMetadata.workflowId}:configuration?version=current-state&includeRepresentation=true`,
      {
        tags: { name: 'run_menu_workflow_config_2' },
      },
    );

    log({ rawText: `KNIME Setup: Run menu: GET workflow configuration (2) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from workflow configuration (2), got ${res.status}`,
    );

    // 5. GET /_/schema/execution/deployments/adHoc (second call)
    const schemaUrl2 = buildSchemaUrl(CONFIG.KNIME_BASE_URL, workflowMetadata);

    res = http.get(schemaUrl2, {
      tags: { name: 'run_menu_schema_2' },
    });

    log({ rawText: `KNIME Setup: Run menu: GET schema deployments (2) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from schema deployments (2), got ${res.status}`,
    );

    // 6. GET /_/schema/execution/deployments/adHoc (third call with executionContextId)
    const schemaUrl3 = buildSchemaUrl(CONFIG.KNIME_BASE_URL, workflowMetadata, {
      includeContextId: true,
    });

    res = http.get(schemaUrl3, {
      tags: { name: 'run_menu_schema_3' },
    });

    log({ rawText: `KNIME Setup: Run menu: GET schema deployments (3) -> ${res.status}` });
    validateResponseStatus(
      res,
      200,
      `Setup failed: Expected 200 from schema deployments (3), got ${res.status}`,
    );
  });

  const authContext = {
    knimeHubAuth: knimeHubAuth,
    workflowMetadata: workflowMetadata,
    timestamp: new Date().toISOString(),
  };

  log({ rawText: `KNIME Setup: OAuth authentication successful` });

  // Showcase of setup context for evidence
  // Deliberately exclude tokens and credentials because it is shown in non-debug runs
  console.log(
    `KNIME Setup: KNIME Test Context: ${JSON.stringify({
      workflowName: authContext.workflowMetadata.workflowName,
      workflowId: authContext.workflowMetadata.workflowId,
      setupCompletedAt: authContext.timestamp,
    })}`,
  );

  log({
    rawText: `KNIME Setup: full authContext metadata: ${JSON.stringify(authContext, null, 2)}`,
  });

  return authContext;
}
