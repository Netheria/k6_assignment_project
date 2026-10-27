/**
 * @file lib/helpers.js
 * @brief Helper functions (project specific) for setup and workload scripts.
 */

/**
 * Extract OAuth parameters from Keycloak login form HTML.
 *
 * Parses the form action URL to extract embedded OAuth parameters:
 * - session_code
 * - execution
 * - client_id
 * - tab_id
 * - client_data
 *
 * @param {string} htmlBody - Response body from Keycloak auth endpoint
 * @return {Object} OAuth parameters: { sessionCode, execution, clientId, tabId, clientData }
 * @throws {Error} If form action URL or required parameters not found
 */
export function extractOAuthParams(htmlBody) {
  const formActionMatch = htmlBody.match(
    /action=["']([^"']*login-actions\/authenticate[^"']*)["']/,
  );
  if (!formActionMatch || !formActionMatch[1]) {
    return null;
  }

  const formActionUrl = formActionMatch[1].replace(/&amp;/g, '&');

  const getParam = (url, param) => {
    const match = url.match(new RegExp(`[?&]${param}=([^&]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  };

  return {
    sessionCode: getParam(formActionUrl, 'session_code'),
    execution: getParam(formActionUrl, 'execution'),
    clientId: getParam(formActionUrl, 'client_id'),
    tabId: getParam(formActionUrl, 'tab_id'),
    clientData: getParam(formActionUrl, 'client_data'),
  };
}

/**
 * Log detailed request/response information for debugging.
 *
 * @param {string} label - Request label for identification
 * @param {string} method - HTTP method
 * @param {string} url - Request URL
 * @param {string} requestBody - Request body
 * @param {Object} requestHeaders - Request headers object
 * @param {Object} response - k6 HTTP response object
 */
export function logRequestResponse(label, method, url, requestBody, requestHeaders, response) {
  console.log(`\n========== ${label} ==========`);
  console.log(`Method: ${method}`);
  console.log(`URL: ${url}`);

  console.log('\n--- REQUEST ---');
  console.log('Headers:');
  Object.entries(requestHeaders).forEach(([key, value]) => {
    const truncated = value.length > 100 ? value.substring(0, 100) + '...' : value;
    console.log(`  ${key}: ${truncated}`);
  });

  if (requestBody) {
    console.log(`Body: ${requestBody}`);
  }

  console.log('\n--- RESPONSE ---');
  console.log(`Status: ${response.status}`);

  console.log('Headers:');
  Object.entries(response.headers).forEach(([key, value]) => {
    if (
      key.toLowerCase() === 'location' ||
      key.toLowerCase() === 'set-cookie' ||
      key.toLowerCase() === 'content-type'
    ) {
      const truncated = value.length > 100 ? value.substring(0, 100) + '...' : value;
      console.log(`  ${key}: ${truncated}`);
    }
  });

  console.log('Cookies:');
  Object.entries(response.cookies).forEach(([key, cookie]) => {
    console.log(`  ${key}: ${cookie.value ? cookie.value.substring(0, 50) + '...' : 'empty'}`);
  });

  if (response.status === 200 || response.status >= 400) {
    console.log(`Body sample: ${response.body.toString().substring(0, 200)}`);
  }
}

/**
 * Extract workflow metadata from search results response body.
 *
 * Parses the first workflow result and extracts:
 * - workflowId: workflow.id
 * - accountId: workflow.ownerAccountId
 * - spaceId: derived from pathToResource (substring before last slash)
 *
 * @param {string} responseBody - Response body from search API
 * @return {Object} Workflow metadata: { workflowId, accountId, spaceId }
 * @throws {Error} If parsing fails or no workflows found
 */
export function extractWorkflowMetadata(responseBody) {
  const searchResults = JSON.parse(responseBody);
  if (!searchResults.results || searchResults.results.length === 0) {
    throw new Error('No workflows found in search results');
  }

  const workflow = searchResults.results[0];
  const lastSlashIndex = workflow.pathToResource.lastIndexOf('/');

  return {
    workflowName: workflow.pathToResource.substring(lastSlashIndex + 1),
    workflowId: workflow.id,
    accountId: workflow.ownerAccountId,
    space: workflow.pathToResource.substring(0, lastSlashIndex),
  };
}

/**
 * Extract a cookie value from a Set-Cookie header string.
 *
 * Handles comma-separated multiple cookies in a single Set-Cookie header
 * (a format that k6's built-in cookie parser doesn't handle correctly).
 * Extracts the value for a specific cookie by name using regex matching.
 *
 * @param {string} setCookieHeader - Set-Cookie header value from response
 * @param {string} cookieName - Name of the cookie to extract
 * @return {string|undefined} Cookie value if found, undefined otherwise
 */
export function extractCookieFromHeader(setCookieHeader, cookieName) {
  if (!setCookieHeader) {
    return undefined;
  }

  const regex = new RegExp(`${cookieName}=([^;]+)`);
  const match = setCookieHeader.match(regex);
  return match ? match[1] : undefined;
}

/**
 * Build Keycloak login URL with OAuth parameters.
 *
 * Constructs the authenticate endpoint URL with all required query parameters.
 *
 * @param {string} keycloakAuthUrl - Keycloak base auth URL
 * @param {Object} oauthParams - OAuth parameters: sessionCode, execution, clientId, tabId, clientData
 * @return {string} Complete login URL with encoded parameters
 */
function buildLoginUrl(keycloakAuthUrl, oauthParams) {
  const { sessionCode, execution, clientId, tabId, clientData } = oauthParams;

  return `${keycloakAuthUrl}/auth/realms/knime/login-actions/authenticate?session_code=${encodeURIComponent(sessionCode)}&execution=${encodeURIComponent(execution)}&client_id=${encodeURIComponent(clientId)}&tab_id=${encodeURIComponent(tabId)}&client_data=${encodeURIComponent(clientData)}`;
}

/**
 * Build form-encoded login body with credentials.
 *
 * Constructs the request body for Keycloak authentication with username and password.
 *
 * @param {string} username - Username for authentication
 * @param {string} password - Password for authentication
 * @return {string} Form-encoded body: username=...&password=...&credentialId=
 */
function buildLoginBody(username, password) {
  return `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&credentialId=`;
}

/**
 * Build complete Keycloak login request (URL, headers, body).
 *
 * High-level abstraction combining URL construction, headers, and body into a single
 * request specification for the Keycloak login POST endpoint.
 *
 * @param {string} keycloakAuthUrl - Keycloak base auth URL
 * @param {Object} oauthParams - OAuth parameters object: sessionCode, execution, clientId, tabId, clientData
 * @param {string} oauthParams.sessionCode - session_code parameter
 * @param {string} oauthParams.execution - execution parameter
 * @param {string} oauthParams.clientId - client_id parameter
 * @param {string} oauthParams.tabId - tab_id parameter
 * @param {string} oauthParams.clientData - client_data parameter
 * @param {string} username - Username for authentication
 * @param {string} password - Password for authentication
 * @return {Object} Request specification: { url, headers, body }
 */
export function buildLoginRequest(keycloakAuthUrl, oauthParams, username, password) {
  return {
    url: buildLoginUrl(keycloakAuthUrl, oauthParams),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    },
    body: buildLoginBody(username, password),
  };
}

/**
 * Validate HTTP response status matches expected value.
 *
 * Throws an error if response status does not match the expected status.
 * This helper centralizes repetitive status validation throughout the setup script.
 *
 * @param {Object} response - k6 HTTP response object
 * @param {number|number[]} expectedStatus - Expected status code(s) (single number or array)
 * @param {string} errorMessage - Error message to throw if validation fails
 * @throws {Error} If response status does not match expected status
 */
export function validateResponseStatus(response, expectedStatus, errorMessage) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  if (!expected.includes(response.status)) {
    throw new Error(errorMessage);
  }
}

/**
 * Extract execution context ID from execution contexts response.
 *
 * Parses the GET /_/bff/execution/contexts response and extracts the first
 * execution context's ID. Does not validate the response — caller is responsible
 * for response validation.
 *
 * @param {string} responseBody - Response body from execution contexts endpoint
 * @return {string} Execution context ID (first context in response)
 * @throws {Error} If no execution contexts found or parsing fails
 */
export function extractExecutionContext(responseBody) {
  const contextResponse = JSON.parse(responseBody);
  if (!contextResponse.executionContexts || contextResponse.executionContexts.length === 0) {
    throw new Error('No execution contexts found in response');
  }

  return contextResponse.executionContexts[0].id;
}

/**
 * Build schema parameters object for ad-hoc deployment queries.
 *
 * Constructs the params object for GET /_/schema/execution/deployments/adHoc requests.
 * Includes a cache buster timestamp and optionally the current execution context ID.
 *
 * @param {Object} workflowMetadata - Workflow metadata object with accountId, workflowId, spaceId
 * @param {Object} options - Optional parameters
 * @param {boolean} options.includeContextId - Whether to include executionContextId (default: false)
 * @return {Object} Schema parameters object ready for JSON.stringify and URL encoding
 */
function buildSchemaParams(workflowMetadata, options = {}) {
  const { includeContextId = false } = options;

  const params = {
    selectedVersion: 'current-state',
    workflowHasReport: true,
    accountId: workflowMetadata.accountId,
    workflowId: workflowMetadata.workflowId,
    spaceId: workflowMetadata.spaceId,
    type: 'adHoc',
    editMode: false,
    edition: 'business',
    advancedSettingsFromDeployment: null,
    canChangePoolSize: false,
    cacheBuster: new Date().getTime(),
  };

  if (includeContextId && workflowMetadata.executionContextId) {
    params.currentlySelectedExecutionContextId = workflowMetadata.executionContextId;
  }

  return params;
}

/**
 * Build complete schema URL for ad-hoc deployment query.
 *
 * High-level abstraction combining schema params construction and URL encoding
 * for GET /_/schema/execution/deployments/adHoc requests.
 *
 * @param {string} baseUrl - KNIME base URL (CONFIG.KNIME_BASE_URL)
 * @param {Object} workflowMetadata - Workflow metadata object with accountId, workflowId, spaceId, executionContextId
 * @param {Object} options - Optional parameters
 * @param {boolean} options.includeContextId - Whether to include executionContextId (default: false)
 * @return {string} Complete schema URL with encoded parameters
 */
export function buildSchemaUrl(baseUrl, workflowMetadata, options = {}) {
  const params = buildSchemaParams(workflowMetadata, options);
  return `${baseUrl}/_/schema/execution/deployments/adHoc?params=${JSON.stringify(params)}`;
}

/**
 * Build complete job execution request (URL, headers, body).
 *
 * High-level abstraction for ad-hoc workflow job execution POST request.
 * Combines URL construction, headers, and body into a single request specification.
 *
 * @param {string} apiUrl - KNIME API base URL (CONFIG.KNIME_API_URL)
 * @param {Object} workflowMetadata - Workflow metadata object with workflowId, executionContextId
 * @return {Object} Request specification: { url, headers, body }
 */
export function buildJobExecutionRequest(apiUrl, workflowMetadata) {
  return {
    url: `${apiUrl}/jobs?itemVersion=current-state&workflowUri=${workflowMetadata.workflowId}&wizardExecution=true`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      actions: [
        {
          type: 'DiscardAfterExecution',
          onSuccess: false,
          onFailure: false,
        },
      ],
      executionContext: workflowMetadata.executionContextId,
    }),
  };
}

/**
 * Build complete home redirect request (URL, headers).
 *
 * High-level abstraction for GET / redirect after OAuth callback.
 * Includes full browser navigation headers required by the server.
 *
 * @param {string} baseUrl - KNIME base URL (CONFIG.KNIME_BASE_URL)
 * @return {Object} Request specification: { url, headers }
 */
export function buildHomeRedirectRequest(baseUrl) {
  return {
    url: baseUrl,
    headers: {
      'cache-control': 'max-age=0',
      'upgrade-insecure-requests': '1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-US,en;q=0.9',
    },
  };
}
