/** Error from the 4ga Boards API or from reaching it. `message` is safe to show to an LLM. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised by the MCP layer for caller mistakes (bad ids, focus-mode violations...). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function explainStatus(status: number, serverMessage: string | undefined, hint: string): string {
  const detail = serverMessage ? ` Server said: ${serverMessage}.` : '';
  switch (status) {
    case 401:
      return `Authentication failed (401): check credentials (FOURGA_CLIENT_ID/SECRET, FOURGA_USERNAME/PASSWORD or FOURGA_TOKEN) and, for API clients, that the client has the permission for this action.${detail}`;
    case 403:
      return `Forbidden (403): the account lacks the required role on this board (editor needed to write; viewers may only comment if allowed).${detail}`;
    case 404:
      return `Not found (404): unknown id, or the account is not a member of that board/project. ${hint}${detail}`;
    case 409:
      return `Conflict (409): the change already exists.${detail}`;
    case 422:
      return `Rejected (422): the server refused the input.${detail}`;
    case 429:
      return `Rate limited (429): too many failed logins; wait about a minute before retrying.${detail}`;
    default:
      return status >= 500
        ? `4ga Boards server error (${status}).${detail}`
        : `Request failed (${status}).${detail}`;
  }
}
