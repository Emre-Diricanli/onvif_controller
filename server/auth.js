/** Opt-in authentication shared by HTTP and WebSocket upgrades. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, toResponse } from './errors.js';

const COOKIE = 'controller_auth';

export function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuth(token) {
  /** A restart invalidates browser sessions; the raw bearer never goes in a cookie. */
  const cookieValue = token ? createHmac('sha256', randomBytes(32)).update(token).digest('hex') : null;
  const failure = () => toResponse(new AppError('UNAUTHORIZED',
    'Controller authentication is required.', 'Supply the controller bearer token or sign in through the browser.'));

  function authorized(req) {
    if (!token) return true;
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^Bearer /i.test(header) && sameSecret(header.slice(7), token)) return true;
    return String(req.headers.cookie ?? '').split(';').some((part) => {
      const [name, ...value] = part.trim().split('=');
      return name === COOKIE && sameSecret(value.join('='), cookieValue);
    });
  }

  function middleware(req, res, next) {
    if (!token) return next();
    let url;
    try { url = new URL(req.originalUrl ?? req.url, 'http://localhost'); } catch {
      return next(new AppError('BAD_REQUEST', 'The request URL is invalid.'));
    }
    /** Match Express routing, including absolute-form proxy requests, without URL normalization. */
    const pathname = req.path;
    const protectedPath = /^\/(api|ws)(\/|$)/i.test(pathname);
    if (!protectedPath && req.method === 'GET' && url.searchParams.has('token')) {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      if (!sameSecret(url.searchParams.get('token'), token)) {
        return res.status(401).type('html').send('<!doctype html><title>Unauthorized</title><h1>Unauthorized</h1><p>The controller sign-in token is invalid.</p>');
      }
      res.cookie(COOKIE, cookieValue, { httpOnly: true, sameSite: 'strict', path: '/', secure: req.secure });
      url.searchParams.delete('token');
      /** Keep redirects origin-relative even for a path starting with two slashes. */
      return res.redirect(302, `/${pathname.replace(/^[\/\\]+/, '')}${url.search}`);
    }
    if (protectedPath && !(['GET', 'HEAD'].includes(req.method) && /^\/api\/health\/?$/i.test(pathname)) && !authorized(req)) {
      const { status, body } = failure();
      res.set('Cache-Control', 'no-store');
      return res.status(status).json(body);
    }
    next();
  }

  function upgrade(req, socket) {
    if (authorized(req)) return true;
    const { body } = failure();
    const json = JSON.stringify(body);
    socket.end(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    return false;
  }

  return { middleware, authorized, upgrade };
}
