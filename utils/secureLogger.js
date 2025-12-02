// utils/secureLogger.js

/**
 * 🔒 SECURE LOGGER - Sistema de logging que NO registra información sensible
 * 
 * NUNCA loguear:
 * - Contraseñas
 * - Tokens JWT
 * - Códigos de verificación/recuperación
 * - Información de tarjetas de crédito
 * - Datos personales sensibles
 */

const SENSITIVE_FIELDS = [
  'password',
  'contraseña',
  'token',
  'jwt',
  'codigo',
  'codigoVerificacion',
  'codigoRecuperacion',
  'secret',
  'apiKey',
  'creditCard',
  'cvv',
  'ssn'
];

/**
 * Sanitizar objeto para logging (eliminar campos sensibles)
 */
function sanitizeForLogging(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item));
  }

  const sanitized = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    
    // Si el campo es sensible, reemplazar con [REDACTED]
    if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Recursivamente sanitizar objetos anidados
    if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLogging(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Enmascarar email (mostrar solo primeros 3 caracteres y dominio)
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  
  const [localPart, domain] = email.split('@');
  if (!domain) return email;
  
  const maskedLocal = localPart.substring(0, 3) + '***';
  return `${maskedLocal}@${domain}`;
}

/**
 * Logger seguro
 */
class SecureLogger {
  /**
   * Log de información
   */
  static info(message, data = {}) {
    const sanitizedData = sanitizeForLogging(data);
    const timestamp = new Date().toISOString();
    
    console.log(`[INFO] ${timestamp} - ${message}`, 
      Object.keys(sanitizedData).length > 0 ? sanitizedData : ''
    );
  }

  /**
   * Log de error
   */
  static error(message, error = {}) {
    const timestamp = new Date().toISOString();
    
    // Solo loguear mensaje de error y stack trace, NO el objeto completo
    const errorInfo = {
      message: error.message || error,
      name: error.name,
      code: error.code,
      // Stack trace solo en desarrollo
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    };

    console.error(`[ERROR] ${timestamp} - ${message}`, errorInfo);
  }

  /**
   * Log de advertencia
   */
  static warn(message, data = {}) {
    const sanitizedData = sanitizeForLogging(data);
    const timestamp = new Date().toISOString();
    
    console.warn(`[WARN] ${timestamp} - ${message}`, 
      Object.keys(sanitizedData).length > 0 ? sanitizedData : ''
    );
  }

  /**
   * Log de autenticación
   */
  static auth(action, email, success = true, details = {}) {
    const timestamp = new Date().toISOString();
    const maskedEmail = maskEmail(email);
    const sanitizedDetails = sanitizeForLogging(details);
    
    const status = success ? '✅ SUCCESS' : '❌ FAILED';
    
    console.log(
      `[AUTH] ${timestamp} - ${status} - ${action} - ${maskedEmail}`,
      Object.keys(sanitizedDetails).length > 0 ? sanitizedDetails : ''
    );
  }

  /**
   * Log de seguridad (intentos sospechosos)
   */
  static security(event, details = {}) {
    const timestamp = new Date().toISOString();
    const sanitizedDetails = sanitizeForLogging(details);
    
    console.warn(
      `[SECURITY] ${timestamp} - ${event}`,
      sanitizedDetails
    );
  }

  /**
   * Log de debug (solo en desarrollo)
   */
  static debug(message, data = {}) {
    if (process.env.NODE_ENV !== 'development') return;
    
    const sanitizedData = sanitizeForLogging(data);
    const timestamp = new Date().toISOString();
    
    console.log(`[DEBUG] ${timestamp} - ${message}`, sanitizedData);
  }
}

/**
 * Middleware para loguear requests (de forma segura)
 */
function requestLoggerMiddleware(req, res, next) {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const ip = req.ip || req.connection.remoteAddress;
  
  // NO loguear body completo (puede contener contraseñas)
  // Solo loguear metadata
  SecureLogger.info('Request received', {
    method,
    url,
    ip,
    userAgent: req.headers['user-agent']?.substring(0, 100) // Truncar user agent
  });

  // Log cuando termina el response
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - req.startTime;
    
    SecureLogger.info('Response sent', {
      method,
      url,
      statusCode: res.statusCode,
      duration: `${duration}ms`
    });
    
    originalSend.call(this, data);
  };

  req.startTime = Date.now();
  next();
}

module.exports = {
  SecureLogger,
  sanitizeForLogging,
  maskEmail,
  requestLoggerMiddleware
};