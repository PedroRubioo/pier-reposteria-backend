// middleware/usuarioVigente.js — Usuario vigente en cada petición
//
// Va después de verifyToken. Relee al usuario de la base para que valgan
// su rol y su estado actuales, no los que quedaron dentro del JWT. Lo usan
// el feed del inicio, el Editor del sitio y, con accesoVigente, Reportes de
// ventas, Estado del sistema, Respaldos y el alta de personal; comandas
// tiene la misma lógica y puede importarlo de aquí.
const { pool } = require('../config/database');
const { verifyToken } = require('./auth');

/** Id de base de datos: entero positivo que cabe en INTEGER */
const esId = (n) => Number.isInteger(n) && n >= 1 && n <= 2147483647;

/**
 * Relee al usuario en cada petición: vale el rol de la base, no el del JWT.
 * Los tokens duran 7 días; sin esto, alguien desactivado o cambiado de rol
 * podría seguir actuando con su token viejo.
 */
async function cargarUsuarioVigente(req, res, next) {
  try {
    const id = Number(req.user.userId);
    const { rows } = esId(id)
      ? await pool.query('SELECT id, rol::text AS rol, activo, nombre, apellido FROM core.tblusuarios WHERE id = $1', [id])
      : { rows: [] };
    const usuario = rows[0];
    if (!usuario || !usuario.activo) {
      return res.status(401).json({
        success: false,
        codigo: 'SESION_INVALIDA',
        message: 'Tu cuenta está desactivada o cambió. Inicia sesión de nuevo.',
      });
    }
    req.usuario = { id: usuario.id, rol: usuario.rol, nombre: `${usuario.nombre} ${usuario.apellido}` };
    return next();
  } catch (error) {
    console.error('Error verificando el usuario vigente:', error.message);
    return res.status(500).json({ success: false, message: 'Error al verificar tu sesión' });
  }
}

/** Va después de cargarUsuarioVigente: deja pasar solo a esos roles */
function exigirRol(roles) {
  return (req, res, next) => (roles.includes(req.usuario.rol)
    ? next()
    : res.status(403).json({ success: false, message: 'No tienes permisos para acceder a este recurso' }));
}

/** Token, usuario vigente y rol de la base, en ese orden (para router.get(ruta, accesoVigente([...]), ...)) */
const accesoVigente = (roles) => [verifyToken, cargarUsuarioVigente, exigirRol(roles)];

module.exports = { cargarUsuarioVigente, accesoVigente };
