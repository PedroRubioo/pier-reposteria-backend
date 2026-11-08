const jwt = require('jsonwebtoken');
const { tokenBlacklist } = require('./tokenBlacklist');
const { pool } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';

// 🔒 Verificar token JWT
async function verifyToken(req, res, next) {
  let decoded;
  let token;
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Token no proporcionado'
      });
    }

    token = authHeader.split(' ')[1];

    // 🔒 SEGURIDAD: Verificar si el token está en la blacklist (logout)
    if (tokenBlacklist.isBlacklisted(token)) {
      return res.status(401).json({
        success: false,
        message: 'Sesión expirada. Por favor inicia sesión nuevamente.'
      });
    }

    // Verificar token
    decoded = jwt.verify(token, JWT_SECRET);
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

  // Una cuenta desactivada (por gerencia o dada de baja desde la app) ya no
  // usa su token aunque no haya vencido (duran 7 días). Consulta ligera por la
  // llave primaria; si la base falla, 500: un 401 cerraría la sesión de todos
  try {
    const { rows } = await pool.query('SELECT activo FROM core.tblusuarios WHERE id = $1', [decoded.userId]);
    if (!rows[0] || !rows[0].activo) {
      return res.status(401).json({
        success: false,
        codigo: 'SESION_INVALIDA',
        message: 'Tu cuenta está desactivada o cambió. Inicia sesión de nuevo.'
      });
    }
  } catch (error) {
    console.error('Error verificando la cuenta del token:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error al verificar tu sesión'
    });
  }

  // Agregar datos del usuario al request
  req.user = decoded;
  req.token = token; // 🔥 Guardar token para logout
  next();
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