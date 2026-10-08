// Толмач — вход через ChatGPT («Sign in with ChatGPT», 29.09.2026).
// Подписка Plus/Pro платит за переводы и ответы вместо ключа API: OpenAI разрешает
// это открытым программам, которые работают на машине самого человека, без
// одобрения. Порядок взят из developers.openai.com/siwc/token-sharing-open-source.
//
// Расширение не умеет слушать порт, поэтому адрес возврата 127.0.0.1:1455 никто
// не обслуживает: service worker видит этот адрес во вкладке (tabs.onUpdated),
// забирает из него код и закрывает вкладку. Сервер OpenAI принимает только
// http://127.0.0.1:<порт>/auth/callback — «localhost» и свои схемы нельзя.

export const AUTH_BASE = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${AUTH_BASE}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_BASE}/api/accounts/oauth/token`;
export const REVOKE_URL = `${AUTH_BASE}/api/accounts/oauth/revoke`;
export const JWKS_URL = `${AUTH_BASE}/.well-known/jwks.json`;
export const RESOURCE = 'https://api.openai.com/v1';
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
// Разрешение «тратить подписку». Человек может снять его на странице согласия.
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
// Вход для первой регистрации. Это НЕ идентификатор приложения: настоящий
// OpenAI выдаёт в ответе, и дальше ходить надо с ним.
export const REGISTER_CLIENT = 'dynamic_agent_client';
export const AGENT_NAME = 'Толмач';

export function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(size = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

/** PKCE: base64url от SHA-256 проверочной строки, без «=» на конце. */
export async function pkceChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}

/**
 * Адрес страницы входа. Первый раз — регистрация (dynamic_agent_client + имя),
 * дальше — с выданным идентификатором и без имени: иначе каждый вход
 * регистрировал бы новое приложение в его настройках ChatGPT.
 */
export function buildAuthorizeUrl({ clientId, hostId, state, nonce, challenge, loginHint }) {
  const register = !clientId;
  const params = new URLSearchParams();
  params.set('client_id', register ? REGISTER_CLIENT : clientId);
  if (register) params.set('agent_name_hint', AGENT_NAME);
  params.set('ext_agent_host_id', hostId);
  if (loginHint) params.set('login_hint', loginHint);
  params.set('response_type', 'code');
  params.set('redirect_uri', REDIRECT_URI);
  params.set('scope', SCOPES);
  params.set('resource', RESOURCE);
  params.set('state', state);
  params.set('nonce', nonce);
  params.set('code_challenge_method', 'S256');
  params.set('code_challenge', challenge);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Вкладка пришла на адрес возврата? Порт сравниваем как есть: он у нас один. */
export function isCallbackUrl(url) {
  return typeof url === 'string' && url.startsWith(REDIRECT_URI.split('?')[0]) &&
    (url.length === REDIRECT_URI.length || url[REDIRECT_URI.length] === '?');
}

export function readCallback(url) {
  const q = new URL(url).searchParams;
  return {
    code: q.get('code') || '',
    state: q.get('state') || '',
    clientId: q.get('client_id') || '',
    scope: q.get('scope') || '',
    error: q.get('error') || '',
    errorDescription: q.get('error_description') || ''
  };
}

export function decodeJwt(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) throw new Error('ID-токен ChatGPT пришёл в непонятном виде.');
  const json = (part) => JSON.parse(new TextDecoder().decode(b64urlBytes(part)));
  return { header: json(h), payload: json(p), signed: `${h}.${p}`, signature: b64urlBytes(s) };
}

/**
 * Проверка ID-токена: подпись по ключам OpenAI, издатель, адресат, срок, nonce.
 * Токен и так пришёл напрямую с auth.openai.com по TLS, но документация требует
 * проверку, и она же ловит подмену ответа чужой вкладкой.
 */
export async function verifyIdToken(idToken, { clientId, nonce, now = Date.now(), jwks }) {
  const { header, payload, signed, signature } = decodeJwt(idToken);
  const keys = jwks || (await (await fetch(JWKS_URL)).json()).keys || [];
  const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) throw new Error('Не нашёл ключ OpenAI, которым подписан вход.');
  const algo = header.alg === 'ES256'
    ? { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } }
    : header.alg === 'RS256'
      ? { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } }
      : null;
  if (!algo) throw new Error(`Вход подписан незнакомым способом (${header.alg}).`);
  const key = await crypto.subtle.importKey('jwk', jwk, algo.import, false, ['verify']);
  const ok = await crypto.subtle.verify(algo.verify, key, signature, new TextEncoder().encode(signed));
  if (!ok) throw new Error('Подпись входа не сошлась — вход отклонён.');
  checkIdClaims(payload, { clientId, nonce, now });
  return payload;
}

export function checkIdClaims(payload, { clientId, nonce, now = Date.now() }) {
  if (payload.iss !== AUTH_BASE) throw new Error('Вход выдал не auth.openai.com — отклонён.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new Error('Вход выдан другому приложению — отклонён.');
  if (payload.nonce !== nonce) throw new Error('Вход не совпал с запросом — нажми «Войти» ещё раз.');
  // Минута запаса на расхождение часов.
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now - 60_000) {
    throw new Error('Вход устарел, пока шёл. Нажми «Войти» ещё раз.');
  }
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // тело не JSON — хватит кода
  }
  if (!res.ok) {
    const err = new Error(
      (body && (body.error_description || (body.error && (body.error.message || body.error)))) ||
        `OpenAI ответил ${res.status}`
    );
    err.code = body && (typeof body.error === 'string' ? body.error : body.error && body.error.code);
    err.status = res.status;
    throw err;
  }
  return body || {};
}

export function exchangeCode({ clientId, code, verifier }) {
  return postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE
  });
}

export function refreshTokens({ clientId, refreshToken }) {
  return postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    resource: RESOURCE
  });
}

/** Выход: отзываем долгий токен. Не вышло — всё равно забываем его у себя. */
export async function revokeToken({ clientId, token }) {
  try {
    await postForm(REVOKE_URL, { token, token_type_hint: 'refresh_token', client_id: clientId });
  } catch {
    // отзыв — вежливость; главное, что токен стёрт из браузера
  }
}

/**
 * Запись о входе. Токен доступа живёт час, долгий — 30 дней и меняется при
 * каждом обновлении, поэтому храним всегда последний.
 */
export function authRecord(tokens, claims, clientId, prev = {}, now = Date.now()) {
  const scope = tokens.scope || prev.scope || '';
  return {
    clientId,
    email: (claims && claims.email) || prev.email || '',
    subject: (claims && claims.sub) || prev.subject || '',
    idToken: tokens.id_token || prev.idToken || '',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || prev.refreshToken || '',
    expiresAt: now + (Number(tokens.expires_in) || 3600) * 1000,
    scope
  };
}

export function hasPlanScope(scope) {
  return String(scope || '').split(/\s+/).includes(PLAN_SCOPE);
}

/** Пора обновлять токен доступа: за две минуты до конца часа. */
export function needsRefresh(auth, now = Date.now()) {
  return !!(auth && auth.refreshToken && (!auth.expiresAt || auth.expiresAt - now < 120_000));
}
