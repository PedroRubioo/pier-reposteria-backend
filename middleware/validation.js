/* eslint-disable security/detect-unsafe-regex */
// middleware/validation.js
const validator = require('validator');

/**
 * Sanitizar datos de entrada para prevenir XSS y NoSQL Injection
 */
function sanitizeInput(value) {
  if (typeof value !== 'string') return value;

  // No escapar URLs válidas (Cloudinary, Unsplash, etc.)
  if (validator.isURL(value, { protocols: ['http', 'https'], require_protocol: true })) {
    return value.trim();
  }

  // 1. Eliminar etiquetas HTML (protección XSS)
  let sanitized = validator.escape(value);

  // 2. Eliminar caracteres peligrosos para NoSQL
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
      continue;
    }
    // 🔒 SEGURIDAD: Validar que la clave pertenece al objeto antes de asignar
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      sanitized[key] = sanitizeObject(value); // eslint-disable-line security/detect-object-injection
    }
  }
  
  return sanitized;
}

/**
 * Middleware para sanitizar req.body, req.query y req.params
 */
function sanitizeRequestMiddleware(req, res, next) {
  try {
    // 🔧 EXCEPCIÓN: No sanitizar callbacks/endpoints OAuth.
    // validator.escape() convierte '/' a '&#x2F;' y rompe los authorization codes de Google.
    // - /api/auth/google/* → flow web normal con Google
    // - /api/oauth/*      → flow de Alexa Account Linking (authorize, login, google, token)
    if (req.path.startsWith('/api/auth/google') || req.path.startsWith('/api/oauth')) {
      return next();
    }

    // 🔧 EXCEPCIÓN: comandas. Cada texto se valida campo por campo en
    // utils/comandas.js, el SQL es parametrizado y React escapa al mostrar.
    // Escapar aquí guardaría "&amp;" o quitaría "$" y "{}" de leyendas y
    // notas, y cada edición crearía una versión "fantasma" para producción.
    if (req.path === '/api/comandas' || req.path.startsWith('/api/comandas/')) {
      return next();
    }

    // 🔧 EXCEPCIÓN: feed del inicio (publicaciones y comentarios). Igual que
    // comandas: utils/publicaciones.js valida campo por campo, el SQL es
    // parametrizado y React escapa al mostrar; escapar aquí guardaría
    // "&amp;" y quitaría "$" de lo que escriben clientes y personal.
    if (req.path === '/api/publicaciones' || req.path.startsWith('/api/publicaciones/')) {
      return next();
    }

    // 🔧 EXCEPCIÓN: Editor del sitio. utils/contenidoSitio.js valida campo
    // por campo, el SQL es parametrizado y React escapa al pintar; escapar
    // aquí guardaría "O&#x27;Brien" y quitaría "$", "{}" y "[]" de los textos.
    if (req.path === '/api/contenido' || req.path.startsWith('/api/contenido/')) {
      return next();
    }

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
 */
function isStrongPassword(password) {
  const minLength = 6;
  const hasLetters = /[a-zA-Z]/.test(password);
  const hasNumbers = /\d/.test(password);

  return password.length >= minLength && hasLetters && hasNumbers;
}

/**
 * Obtener mensaje de error detallado para contraseña
 */
function getPasswordRequirementsMessage(password) {
  const requirements = [];

  if (password.length < 6) {
    requirements.push('mínimo 6 caracteres');
  }
  if (!/[a-zA-Z]/.test(password)) {
    requirements.push('al menos 1 letra');
  }
  if (!/\d/.test(password)) {
    requirements.push('al menos 1 número');
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
    /on\w+\s*=/gi,
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