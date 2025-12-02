// middleware/validation.js
const validator = require('validator');

/**
 * Sanitizar datos de entrada para prevenir XSS y NoSQL Injection
 */
function sanitizeInput(value) {
  if (typeof value !== 'string') return value;
  
  // 1. Eliminar etiquetas HTML (protección XSS)
  let sanitized = validator.escape(value);
  
  // 2. Eliminar caracteres peligrosos para NoSQL
  // Eliminar $, {, }, [, ] que se usan en operadores MongoDB
  sanitized = sanitized.replace(/[\$\{\}\[\]]/g, '');
  
  return sanitized.trim();
}

/**
 * Sanitizar objeto completo recursivamente
 */
function sanitizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return sanitizeInput(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    // No permitir claves que empiecen con $ (operadores MongoDB)
    if (key.startsWith('$')) {
      continue; // Ignorar esta clave
    }
    sanitized[key] = sanitizeObject(value);
  }
  
  return sanitized;
}

/**
 * Middleware para sanitizar req.body, req.query y req.params
 */
function sanitizeRequestMiddleware(req, res, next) {
  try {
    if (req.body) {
      req.body = sanitizeObject(req.body);
    }
    
    if (req.query) {
      req.query = sanitizeObject(req.query);
    }
    
    if (req.params) {
      req.params = sanitizeObject(req.params);
    }
    
    next();
  } catch (error) {
    console.error('Error sanitizando request:', error);
    res.status(400).json({
      success: false,
      message: 'Datos de entrada inválidos'
    });
  }
}

/**
 * Validar email
 */
function isValidEmail(email) {
  return validator.isEmail(email);
}

/**
 * Validar contraseña segura
 * Requisitos:
 * - Mínimo 8 caracteres
 * - Al menos 1 mayúscula
 * - Al menos 1 minúscula
 * - Al menos 1 número
 * - Al menos 1 carácter especial
 */
function isStrongPassword(password) {
  const minLength = 8;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
  return password.length >= minLength && 
         hasUpperCase && 
         hasLowerCase && 
         hasNumbers && 
         hasSpecialChar;
}

/**
 * Obtener mensaje de error detallado para contraseña
 */
function getPasswordRequirementsMessage(password) {
  const requirements = [];
  
  if (password.length < 8) {
    requirements.push('mínimo 8 caracteres');
  }
  if (!/[A-Z]/.test(password)) {
    requirements.push('al menos 1 mayúscula');
  }
  if (!/[a-z]/.test(password)) {
    requirements.push('al menos 1 minúscula');
  }
  if (!/\d/.test(password)) {
    requirements.push('al menos 1 número');
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    requirements.push('al menos 1 carácter especial (!@#$%^&*...)');
  }
  
  if (requirements.length === 0) {
    return null;
  }
  
  return `La contraseña debe tener: ${requirements.join(', ')}`;
}

/**
 * Validar nombre (solo letras y espacios)
 */
function isValidName(name) {
  const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{2,50}$/;
  return nameRegex.test(name);
}

/**
 * Validar teléfono (10 dígitos)
 */
function isValidPhone(phone) {
  const phoneRegex = /^\d{10}$/;
  return phoneRegex.test(phone);
}

/**
 * Validar que no contenga scripts maliciosos
 */
function containsXSS(value) {
  if (typeof value !== 'string') return false;
  
  const xssPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi, // onclick, onerror, etc.
    /<iframe/gi,
    /<object/gi,
    /<embed/gi
  ];
  
  return xssPatterns.some(pattern => pattern.test(value));
}

/**
 * Validar que no contenga inyección NoSQL
 */
function containsNoSQLInjection(value) {
  if (typeof value !== 'string') return false;
  
  const nosqlPatterns = [
    /\$where/i,
    /\$ne/i,
    /\$gt/i,
    /\$lt/i,
    /\$or/i,
    /\$and/i,
    /\$regex/i
  ];
  
  return nosqlPatterns.some(pattern => pattern.test(value));
}

module.exports = {
  sanitizeInput,
  sanitizeObject,
  sanitizeRequestMiddleware,
  isValidEmail,
  isStrongPassword,
  getPasswordRequirementsMessage,
  isValidName,
  isValidPhone,
  containsXSS,
  containsNoSQLInjection
};