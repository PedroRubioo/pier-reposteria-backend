// routes/oauthRoutes.js
// =====================================================================
// OAuth 2.0 Authorization Code Grant para Alexa Account Linking
// Endpoints:
//   GET  /api/oauth/authorize       - Pantalla de login (HTML)
//   POST /api/oauth/login           - Procesa email+password, genera code
//   GET  /api/oauth/google          - Inicia Google OAuth (link a cuenta Google)
//   GET  /api/oauth/google/callback - Callback de Google, genera code
//   POST /api/oauth/token           - Intercambia code por JWT (server-to-server)
// =====================================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const passport = require('../config/passport');
const { pool } = require('../config/database');
const Usuario = require('../models/Usuario');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';
const ALEXA_CLIENT_ID = process.env.ALEXA_CLIENT_ID || 'alexa-pier';
const ALEXA_CLIENT_SECRET = process.env.ALEXA_CLIENT_SECRET || '';

// Hosts de redirect_uri permitidos por Amazon Alexa
// https://developer.amazon.com/en-US/docs/alexa/account-linking/configure-authorization-code-grant.html
const ALLOWED_REDIRECT_HOSTS = [
  'pitangui.amazon.com',
  'layla.amazon.com',
  'alexa.amazon.co.jp',
  'localhost', // para pruebas locales
];

// =====================================================================
// HELPERS
// =====================================================================
function generarCodigo() {
  return crypto.randomBytes(32).toString('hex');
}

function esRedirectValido(uri) {
  if (!uri) return false;
  try {
    const u = new URL(uri);
    return ALLOWED_REDIRECT_HOSTS.some(host =>
      u.hostname === host || u.hostname.endsWith('.' + host)
    );
  } catch {
    return false;
  }
}

function construirRedirect(redirectUri, params) {
  const url = new URL(redirectUri);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') url.searchParams.append(k, v);
  });
  return url.toString();
}

// =====================================================================
// GET /api/oauth/authorize
// Alexa abre esta URL en una WebView cuando el usuario inicia Link Account.
// Servimos el HTML de login; el HTML lee los params de window.location.search.
// =====================================================================
router.get('/authorize', (req, res) => {
  const { client_id, response_type, redirect_uri } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('response_type debe ser "code"');
  }
  if (client_id !== ALEXA_CLIENT_ID) {
    return res.status(400).send('client_id inválido');
  }
  if (!esRedirectValido(redirect_uri)) {
    return res.status(400).send('redirect_uri no permitido');
  }

  res.sendFile(path.join(__dirname, '..', 'views', 'oauth-login.html'));
});

// =====================================================================
// POST /api/oauth/login
// Procesa el form de login email+password de la pantalla de authorize.
// =====================================================================
router.post('/login', async (req, res) => {
  try {
    const { email, password, client_id, redirect_uri, state } = req.body;

    if (!esRedirectValido(redirect_uri)) {
      return res.status(400).send('redirect_uri no permitido');
    }
    if (client_id !== ALEXA_CLIENT_ID) {
      return res.status(400).send('client_id inválido');
    }
    if (!email || !password) {
      return res.redirect(`/api/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state||'')}&error=missing_fields`);
    }

    const usuario = await Usuario.findByEmail(pool, email.trim());
    if (!usuario || !usuario.activo) {
      return res.redirect(`/api/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state||'')}&error=invalid_credentials`);
    }

    const ok = await usuario.comparePassword(password);
    if (!ok) {
      return res.redirect(`/api/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state||'')}&error=invalid_credentials`);
    }

    const code = generarCodigo();
    await pool.query(
      `INSERT INTO core.tbloauth_codes (code, usuario_id, client_id, redirect_uri, state, expira_en)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '5 minutes')`,
      [code, usuario.id, client_id, redirect_uri, state || null]
    );

    return res.redirect(construirRedirect(redirect_uri, { code, state }));
  } catch (error) {
    console.error('Error /api/oauth/login:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// =====================================================================
// GET /api/oauth/google
// El botón "Continuar con Google" del HTML golpea aquí.
// Guardamos los params del Account Linking en sesión Express y arrancamos
// el flow de Google con passport. En el callback recuperamos los params.
// =====================================================================
router.get('/google', (req, res, next) => {
  const { client_id, redirect_uri, state } = req.query;

  if (client_id !== ALEXA_CLIENT_ID) {
    return res.status(400).send('client_id inválido');
  }
  if (!esRedirectValido(redirect_uri)) {
    return res.status(400).send('redirect_uri no permitido');
  }

  req.session.alexaLinking = { client_id, redirect_uri, state: state || null };
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// =====================================================================
// GET /api/oauth/google/callback
// Callback de Google. Recupera los params del Account Linking, genera code
// y redirige a Alexa.
// =====================================================================
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/api/oauth/authorize?error=google_auth_failed' }),
  async (req, res) => {
    try {
      const alexaLinking = req.session.alexaLinking;
      if (!alexaLinking) {
        return res.status(400).send('Sesión expirada. Vuelve a iniciar la vinculación desde la app de Alexa.');
      }

      const user = req.user;
      if (!user || !user.id) {
        return res.status(401).send('Autenticación con Google falló');
      }

      const { client_id, redirect_uri, state } = alexaLinking;

      const code = generarCodigo();
      await pool.query(
        `INSERT INTO core.tbloauth_codes (code, usuario_id, client_id, redirect_uri, state, expira_en)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '5 minutes')`,
        [code, user.id, client_id, redirect_uri, state]
      );

      delete req.session.alexaLinking;
      const finalUrl = construirRedirect(redirect_uri, { code, state });

      req.logout((err) => {
        if (err) console.error('Logout error tras vincular Alexa:', err);
        res.redirect(finalUrl);
      });
    } catch (error) {
      console.error('Error /api/oauth/google/callback:', error);
      res.status(500).send('Error interno del servidor');
    }
  }
);

// =====================================================================
// POST /api/oauth/token
// Alexa llama aquí server-to-server con el code obtenido.
// Devolvemos el JWT como access_token.
// =====================================================================
router.post('/token', async (req, res) => {
  try {
    // Las credenciales del cliente pueden venir en body o en Basic Auth header
    let clientId = req.body.client_id;
    let clientSecret = req.body.client_secret;

    if ((!clientId || !clientSecret) && req.headers.authorization?.startsWith('Basic ')) {
      const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString();
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        clientId = decoded.slice(0, idx);
        clientSecret = decoded.slice(idx + 1);
      }
    }

    if (clientId !== ALEXA_CLIENT_ID || clientSecret !== ALEXA_CLIENT_SECRET) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    const { grant_type, code } = req.body;

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    if (!code) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code es requerido' });
    }

    const result = await pool.query(
      'SELECT * FROM core.tbloauth_codes WHERE code = $1',
      [code]
    );
    const oauthCode = result.rows[0];

    if (!oauthCode) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code no existe' });
    }
    if (oauthCode.usado) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code ya fue usado' });
    }
    if (new Date(oauthCode.expira_en) < new Date()) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code expirado' });
    }

    // Marcar como usado (one-time)
    await pool.query('UPDATE core.tbloauth_codes SET usado = TRUE WHERE id = $1', [oauthCode.id]);

    const usuario = await Usuario.findById(pool, oauthCode.usuario_id);
    if (!usuario || !usuario.activo) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'usuario inválido o inactivo' });
    }

    const accessToken = jwt.sign(
      { userId: usuario.id, email: usuario.email, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    await Usuario.updateLastAccess(pool, usuario.id);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 7 * 24 * 60 * 60,
    });
  } catch (error) {
    console.error('Error /api/oauth/token:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
