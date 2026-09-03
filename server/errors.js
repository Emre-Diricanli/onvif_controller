/**
 * Error envelope shared by every module. See API.md "Error envelope".
 */

export const CODE_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  SESSION_EXPIRED: 404,
  DEVICE_UNREACHABLE: 502,
  DEVICE_TIMEOUT: 504,
  // The governor is deliberately refusing to send: the host's request budget is
  // exhausted, its breaker is open, or it has wedged. 503 rather than 5xx-generic
  // because the condition is transient and the operator can act on it.
  DEVICE_BUSY: 503,
  CLOCK_SKEW: 502,
  UNSUPPORTED: 501,
  FFMPEG_MISSING: 500,
  STREAM_FAILED: 502,
  DEVICE_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(code, message, hint = null, status = null) {
    super(message);
    this.name = 'AppError';
    this.code = CODE_STATUS[code] ? code : 'INTERNAL';
    this.hint = hint;
    this.status = status ?? CODE_STATUS[this.code] ?? 500;
  }
}

export function toResponse(err) {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, hint: err.hint } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: 'The server hit an unexpected error handling that request.',
        hint: null,
      },
    },
  };
}

/**
 * Translate a raw error from the `onvif` library, a socket, or a SOAP fault into
 * an AppError carrying an operator-facing remediation hint.
 *
 * The hints describe CAUSES, not vendors. Most devices refuse
 * GetDeviceInformation until authenticated, so when a connection fails we
 * usually have no evidence of the make — naming one would be a guess dressed
 * up as a diagnosis. An earlier version asserted Hikvision on every auth
 * failure and told an operator the wrong thing about an OEM recorder.
 * and its two classic failure modes (ONVIF disabled, separate ONVIF user) look
 * identical to a generic "connection failed" without them.
 */
export function mapOnvifError(err, ctx = {}) {
  if (err instanceof AppError) return err;

  const host = ctx.host ?? 'the device';
  const port = ctx.port ?? 80;
  const raw = String(err?.message ?? err ?? '');
  const code = err?.code;

  if (code === 'ECONNREFUSED') {
    return new AppError(
      'DEVICE_UNREACHABLE',
      `Nothing is listening on ${host}:${port}.`,
      'ONVIF is often disabled by default, and it frequently listens on a different port from the web UI. Enable ONVIF in the device settings and confirm the port before retrying.',
    );
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new AppError(
      'DEVICE_UNREACHABLE',
      `No network route to ${host}.`,
      'Check that this machine is on the same subnet or VLAN as the camera.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new AppError(
      'DEVICE_UNREACHABLE',
      `The hostname "${host}" could not be resolved.`,
      'Use the camera IP address instead of a hostname, or fix DNS on this machine.',
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(raw)) {
    return new AppError(
      'DEVICE_TIMEOUT',
      `${host} did not answer in time.`,
      'The port may be filtered by a firewall, or the device may be overloaded. Confirm the ONVIF port (usually 80) is reachable.',
    );
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new AppError(
      'DEVICE_UNREACHABLE',
      `${host} closed the connection unexpectedly.`,
      'Some firmware resets the connection when the ONVIF service or its user account is disabled. Verify both are enabled on the device.',
    );
  }

  // SOAP-level authentication failures. The onvif lib surfaces these as plain
  // Error objects whose message carries the fault string, so match on text.
  if (
    /not authorized|unauthorized|authoriz|sender not authorized|401/i.test(raw) ||
    err?.statusCode === 401
  ) {
    // Deliberately vendor-neutral. Most devices refuse GetDeviceInformation
    // until authenticated, so at this point we have NO evidence of the make —
    // naming one would be a guess presented as a diagnosis. The underlying
    // cause (ONVIF wants its own account, separate from the web-UI login) is
    // common across Hikvision, Dahua and the budget OEM firmwares alike, so
    // describe the cause rather than asserting a brand.
    return new AppError(
      'UNAUTHORIZED',
      'The device rejected those credentials.',
      'Many recorders and cameras keep ONVIF accounts separate from the web-UI login, so the admin account you use in the browser often will not work here. '
      + 'Look for an ONVIF or "integration protocol" user in the device settings, and check the account is enabled. '
      + 'A device clock that is more than a few seconds out will also fail this way, because ONVIF signs a timestamp.',
    );
  }
  if (/ter:invalidargval|invalid.*argument|no such/i.test(raw)) {
    return new AppError(
      'BAD_REQUEST',
      'The device rejected that value as invalid.',
      raw || null,
    );
  }
  if (/ter:actionnotsupported|not supported|optionalactionnotsupported|ter:noconfig/i.test(raw)) {
    return new AppError(
      'UNSUPPORTED',
      'This device does not support that operation.',
      null,
    );
  }

  return new AppError(
    'DEVICE_ERROR',
    'The device returned an error.',
    raw ? raw.slice(0, 300) : null,
  );
}

/** Express error middleware. Never leaks credentials or stack traces. */
export function errorMiddleware(err, _req, res, _next) {
  const { status, body } = toResponse(err);
  if (!(err instanceof AppError)) {
    console.error('[error]', err?.stack ?? err);
  }
  res.status(status).json(body);
}
