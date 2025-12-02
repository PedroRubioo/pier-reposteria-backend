const jwt = require('jsonwebtoken');
const { tokenBlacklist } = require('./tokenBlacklist');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';

// 🔒 Verificar token JWT
function verifyToken(req, res, next) {
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Token no proporcionado'
      });
    }

    const token = authHeader.split(' ')[1];

    // 🔒 SEGURIDAD: Verificar si el token está en la blacklist (logout)
    if (tokenBlacklist.isBlacklisted(token)) {
      return res.status(401).json({
        success: false,
        message: 'Sesión expirada. Por favor inicia sesión nuevamente.'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Agregar datos del usuario al request
    req.user = decoded;
    req.token = token; // Guardar token para posible logout
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Token inválido'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expirado'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Error al verificar token'
    });
  }
}

// 🔒 Verificar rol del usuario
function verifyRole(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'No autenticado'
      });
    }

    if (!rolesPermitidos.includes(req.user.rol)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para acceder a este recurso'
      });
    }

    next();
  };
}

module.exports = {
  verifyToken,
  verifyRole
};