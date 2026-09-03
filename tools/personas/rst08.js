/**
 * Persona: UNIX RST08 — an 8-channel NVR.
 *
 * Observed on the real unit (GOVERNOR.md, Part 2):
 *   - ONVIF listens on a NON-DEFAULT port. Started without a port argument,
 *     this persona binds 8899, standing in for that port;
 *   - the admin account has an EMPTY password. A WS-Security UsernameToken
 *     carrying the empty-password digest is ACCEPTED, while a request with no
 *     UsernameToken at all is rejected — the onvif library drops the token
 *     entirely when the password is empty (bug class 4), and this persona is
 *     what catches that regression;
 *   - no Profile G.
 *
 * Like the base mock, the token is checked for PRESENCE, not for a correct
 * digest: the observed trait is "empty password works, no token fails".
 */
export const persona = {
  name: 'rst08',
  defaults: { port: 8899 },
  create(ctx) {
    return {
      onSoap({ res, body, op }) {
        if (!op) return false;
        if (!/<(?:[A-Za-z0-9_.-]+:)?UsernameToken[\s>]/.test(body)) {
          ctx.callCounts['auth.noToken'] = (ctx.callCounts['auth.noToken'] ?? 0) + 1;
          res.writeHead(401, { 'Content-Type': 'application/soap+xml' });
          res.end(ctx.fault('Sender not authorized', 'ter:NotAuthorized'));
          return true;
        }
        return false;
      },
    };
  },
};
