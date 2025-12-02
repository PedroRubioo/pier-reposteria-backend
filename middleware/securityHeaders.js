// middleware/securityHeaders.js
const crypto = require('crypto');

/**
 * 🔒 SECURITY HEADERS - Configurar headers de seguridad HTTP
 */
function securityHeadersMiddleware(req, res, next) {
  // 1. Content Security Policy (CSP)
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.brevo.com https://accounts.google.com",
      "frame-src 'self' https://accounts.google.com",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  // 2. HTTP Strict Transport Security (HSTS)
  // Fuerza HTTPS por 1 año
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );

  // 3. X-Frame-Options
  // Previene clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // 4. X-Content-Type-Options
  // Previene MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 5. X-XSS-Protection
  // Activa protección XSS del navegador
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // 6. Referrer-Policy
  // Controla cuánta información se envía en el header Referer
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // 7. Permissions-Policy (antes Feature-Policy)
  // Deshabilita características no necesarias
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=()'
  );

  // 8. X-Permitted-Cross-Domain-Policies
  // Previene que Flash/PDF ejecuten contenido
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // 9. X-DNS-Prefetch-Control
  // Controla DNS prefetching
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  next();
}

/**
 * 🔒 CSRF PROTECTION - Protección contra Cross-Site Request Forgery
 */
class CSRFProtection {
  constructor() {
    this.tokens = new Map(); // sessionId -> token
  }

  /**
   * Generar token CSRF único
   */
  generateToken(sessionId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(sessionId, {
      token,
      createdAt: Date.now()
    });
    return token;
  }

  /**
   * Verificar token CSRF
   */
  verifyToken(sessionId, token) {
    const record = this.tokens.get(sessionId);
    
    if (!record) {
      return false;
    }

    // Token expira después de 1 hora
    const now = Date.now();
    if (now - record.createdAt > 60 * 60 * 1000) {
      this.tokens.delete(sessionId);
      return false;
    }

    return record.token === token;
  }

  /**
   * Invalidar token
   */
  invalidateToken(sessionId) {
    this.tokens.delete(sessionId);
  }

  /**
   * Limpiar tokens expirados
   */
  cleanup() {
    const now = Date.now();
    for (const [sessionId, record] of this.tokens.entries()) {
      if (now - record.createdAt > 60 * 60 * 1000) {
        this.tokens.delete(sessionId);
      }
    }
  }
}

const csrfProtection = new CSRFProtection();

// Limpiar tokens expirados cada 10 minutos
setInterval(() => {
  csrfProtection.cleanup();
}, 10 * 60 * 1000);

/**
 * Middleware para generar token CSRF
 */
function generateCSRFToken(req, res, next) {
  // Usar sessionID o generar uno temporal basado en IP + User-Agent
  const sessionId = req.session?.id || 
                    crypto.createHash('sha256')
                      .update(req.ip + req.headers['user-agent'])
                      .digest('hex');

  const csrfToken = csrfProtection.generateToken(sessionId);
  
  // Agregar token al response para que el frontend lo use
  res.locals.csrfToken = csrfToken;
  req.csrfToken = csrfToken;
  req.sessionId = sessionId;
  
  next();
}

/**
 * Middleware para verificar token CSRF en requests POST/PUT/DELETE
 */
function verifyCSRFToken(req, res, next) {
  // Solo verificar en métodos que modifican datos
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return next();
  }

  // Excluir rutas específicas (como Google OAuth callback)
  const excludedPaths = [
    '/api/auth/google/callback',
    '/api/auth/login', // Login usa otro método de protección
    '/api/auth/register'
  ];

  if (excludedPaths.some(path => req.path.includes(path))) {
    return next();
  }

  const sessionId = req.session?.id || 
                    crypto.createHash('sha256')
                      .update(req.ip + req.headers['user-agent'])
                      .digest('hex');

  const token = req.headers['x-csrf-token'] || req.body._csrf;

  if (!token) {
    return res.status(403).json({
      success: false,
      message: 'Token CSRF faltante'
    });
  }

  if (!csrfProtection.verifyToken(sessionId, token)) {
    return res.status(403).json({
      success: false,
      message: 'Token CSRF inválido o expirado'
    });
  }

  next();
}

/**
 * Endpoint para obtener token CSRF
 */
function getCSRFTokenEndpoint(req, res) {
  const sessionId = req.session?.id || 
                    crypto.createHash('sha256')
                      .update(req.ip + req.headers['user-agent'])
                      .digest('hex');

  const csrfToken = csrfProtection.generateToken(sessionId);

  res.json({
    success: true,
    csrfToken
  });
}

module.exports = {
  securityHeadersMiddleware,
  csrfProtection,
  generateCSRFToken,
  verifyCSRFToken,
  getCSRFTokenEndpoint
};