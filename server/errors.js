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
 * The hints are deliberately Hikvision-aware: that fleet is the primary target
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
      'On Hikvision devices ONVIF is disabled by default. Enable it under Network → Advanced Settings → Integration Protocol, then retry.',
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
      'Some Hikvision firmware resets ONVIF connections when the ONVIF user is disabled. Verify the ONVIF account is enabled on the device.',
    );
  }

  // SOAP-level authentication failures. The onvif lib surfaces these as plain
  // Error objects whose message carries the fault string, so match on text.
  if (
    /not authorized|unauthorized|authoriz|sender not authorized|401/i.test(raw) ||
    err?.statusCode === 401
  ) {
    return new AppError(
      'UNAUTHORIZED',
      'The device rejected those credentials.',
      'Hikvision requires a dedicated ONVIF user created under Network → Advanced Settings → Integration Protocol. The web-UI admin account will not authenticate over ONVIF.',
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
