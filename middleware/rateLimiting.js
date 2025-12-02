// middleware/rateLimiting.js
const { getDB } = require('../config/database');

/**
 * 🔒 RATE LIMITING - Limitar intentos de login
 * Bloquea la cuenta tras 5 intentos fallidos por 15 minutos
 */
class LoginAttemptTracker {
  constructor() {
    this.attempts = new Map(); // email -> { count, firstAttempt, lockedUntil }
  }

  /**
   * Registrar intento fallido
   */
  recordFailedAttempt(email) {
    const now = Date.now();
    const record = this.attempts.get(email) || {
      count: 0,
      firstAttempt: now,
      lockedUntil: null
    };

    // Si pasaron más de 15 minutos desde el primer intento, resetear
    if (now - record.firstAttempt > 15 * 60 * 1000) {
      record.count = 1;
      record.firstAttempt = now;
      record.lockedUntil = null;
    } else {
      record.count++;
    }

    // Bloquear tras 5 intentos fallidos
    if (record.count >= 5) {
      record.lockedUntil = now + 15 * 60 * 1000; // 15 minutos
    }

    this.attempts.set(email, record);

    return {
      isLocked: record.lockedUntil && now < record.lockedUntil,
      attemptsLeft: Math.max(0, 5 - record.count),
      lockedUntil: record.lockedUntil
    };
  }

  /**
   * Verificar si la cuenta está bloqueada
   */
  isLocked(email) {
    const record = this.attempts.get(email);
    if (!record || !record.lockedUntil) return false;

    const now = Date.now();
    if (now < record.lockedUntil) {
      return {
        locked: true,
        remainingTime: Math.ceil((record.lockedUntil - now) / 1000 / 60) // minutos
      };
    }

    // El bloqueo expiró, limpiar
    this.attempts.delete(email);
    return { locked: false };
  }

  /**
   * Limpiar intentos tras login exitoso
   */
  clearAttempts(email) {
    this.attempts.delete(email);
  }

  /**
   * Limpiar intentos expirados (ejecutar periódicamente)
   */
  cleanup() {
    const now = Date.now();
    for (const [email, record] of this.attempts.entries()) {
      // Limpiar si pasaron más de 1 hora
      if (now - record.firstAttempt > 60 * 60 * 1000) {
        this.attempts.delete(email);
      }
    }
  }
}

// Instancia global del tracker
const loginTracker = new LoginAttemptTracker();

// Limpiar intentos expirados cada 10 minutos
setInterval(() => {
  loginTracker.cleanup();
}, 10 * 60 * 1000);

/**
 * 🔒 RATE LIMITING - Limitar solicitudes de recuperación de contraseña
 * Máximo 3 intentos por hora por email
 */
class PasswordResetTracker {
  constructor() {
    this.requests = new Map(); // email -> { count, windowStart }
  }

  /**
   * Verificar si se puede hacer una solicitud
   */
  canRequest(email) {
    const now = Date.now();
    const record = this.requests.get(email) || {
      count: 0,
      windowStart: now
    };

    // Si pasó 1 hora, resetear contador
    if (now - record.windowStart > 60 * 60 * 1000) {
      record.count = 0;
      record.windowStart = now;
    }

    // Máximo 3 intentos por hora
    if (record.count >= 3) {
      const remainingTime = Math.ceil((record.windowStart + 60 * 60 * 1000 - now) / 1000 / 60);
      return {
        allowed: false,
        remainingTime
      };
    }

    record.count++;
    this.requests.set(email, record);

    return {
      allowed: true,
      attemptsLeft: 3 - record.count
    };
  }

  /**
   * Limpiar requests expirados
   */
  cleanup() {
    const now = Date.now();
    for (const [email, record] of this.requests.entries()) {
      if (now - record.windowStart > 60 * 60 * 1000) {
        this.requests.delete(email);
      }
    }
  }
}

const passwordResetTracker = new PasswordResetTracker();

// Limpiar requests expirados cada 10 minutos
setInterval(() => {
  passwordResetTracker.cleanup();
}, 10 * 60 * 1000);

/**
 * 🔒 RATE LIMITING GENERAL - Para todas las rutas
 * Límite: 100 requests por IP por 15 minutos
 */
class GeneralRateLimiter {
  constructor(maxRequests = 100, windowMs = 15 * 60 * 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map(); // IP -> { count, windowStart }
  }

  /**
   * Verificar si la IP puede hacer una request
   */
  canRequest(ip) {
    const now = Date.now();
    const record = this.requests.get(ip) || {
      count: 0,
      windowStart: now
    };

    // Si pasó la ventana de tiempo, resetear
    if (now - record.windowStart > this.windowMs) {
      record.count = 0;
      record.windowStart = now;
    }

    if (record.count >= this.maxRequests) {
      const remainingTime = Math.ceil((record.windowStart + this.windowMs - now) / 1000 / 60);
      return {
        allowed: false,
        remainingTime,
        limit: this.maxRequests
      };
    }

    record.count++;
    this.requests.set(ip, record);

    return {
      allowed: true,
      remaining: this.maxRequests - record.count
    };
  }

  /**
   * Limpiar IPs expiradas
   */
  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.requests.entries()) {
      if (now - record.windowStart > this.windowMs) {
        this.requests.delete(ip);
      }
    }
  }
}

const generalLimiter = new GeneralRateLimiter();

// Limpiar cada 10 minutos
setInterval(() => {
  generalLimiter.cleanup();
}, 10 * 60 * 1000);

/**
 * Middleware para rate limiting general
 */
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const result = generalLimiter.canRequest(ip);

  if (!result.allowed) {
    return res.status(429).json({
      success: false,
      message: `Demasiadas solicitudes. Intenta de nuevo en ${result.remainingTime} minutos.`,
      retryAfter: result.remainingTime
    });
  }

  // Agregar headers de rate limit
  res.setHeader('X-RateLimit-Limit', result.limit || generalLimiter.maxRequests);
  res.setHeader('X-RateLimit-Remaining', result.remaining || 0);

  next();
}

/**
 * Middleware específico para login
 */
async function loginRateLimitMiddleware(req, res, next) {
  const { email } = req.body;

  if (!email) {
    return next();
  }

  const lockStatus = loginTracker.isLocked(email);

  if (lockStatus.locked) {
    return res.status(429).json({
      success: false,
      message: `Cuenta bloqueada temporalmente por intentos fallidos. Intenta de nuevo en ${lockStatus.remainingTime} minutos.`,
      lockedUntil: lockStatus.remainingTime
    });
  }

  next();
}

/**
 * Middleware para recuperación de contraseña
 */
function passwordResetRateLimitMiddleware(req, res, next) {
  const { email } = req.body;

  if (!email) {
    return next();
  }

  const result = passwordResetTracker.canRequest(email);

  if (!result.allowed) {
    return res.status(429).json({
      success: false,
      message: `Demasiados intentos de recuperación. Intenta de nuevo en ${result.remainingTime} minutos.`,
      retryAfter: result.remainingTime
    });
  }

  next();
}

module.exports = {
  loginTracker,
  passwordResetTracker,
  generalLimiter,
  rateLimitMiddleware,
  loginRateLimitMiddleware,
  passwordResetRateLimitMiddleware
};