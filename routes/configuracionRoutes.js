// routes/configuracionRoutes.js — Configuración del sistema
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { registrarAuditoria } = require('../utils/auditoria');
const { sanitizeObject } = require('../middleware/validation');

// Obtener TODAS las secciones (dirección)
router.get('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, seccion, clave, valor, updated_at FROM core.tblconfiguracion_sistema ORDER BY seccion, clave'
    );
    res.json({ success: true, configuraciones: result.rows });
  } catch (error) {
    console.error('Error GET /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener configuraciones' });
  }
});

// Secciones que puede leer cualquiera (el sitio público las necesita para
// pintar tema y contenido). Las demás (pagos, seguridad, email...) guardan
// credenciales y SOLO se leen autenticado vía GET /
const SECCIONES_PUBLICAS = ['personalizacion', 'contenido', 'general', 'inicio', 'contacto', 'faq', 'nosotros', 'legales', 'promociones'];

// Obtener la configuración de una sección pública
router.get('/:seccion', async (req, res) => {
  try {
    if (!SECCIONES_PUBLICAS.includes(req.params.seccion)) {
      return res.status(403).json({ success: false, message: 'Sección no pública' });
    }
    const result = await pool.query(
      'SELECT clave, valor FROM core.tblconfiguracion_sistema WHERE seccion = $1',
      [req.params.seccion]
    );
    const config = {};
    result.rows.forEach(r => { config[r.clave] = r.valor; });
    res.json({ success: true, config, configuracion: config });
  } catch (error) {
    console.error('Error GET /configuracion/:seccion:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener configuración' });
  }
});

// Las pantallas mandan un PUT por clave aunque no se haya tocado: la
// bitácora solo registra si el valor cambió. Ambos valores salen de la base
// (jsonb normaliza el orden de las llaves), así que comparar su JSON basta.
// El valor solo se anota si es booleano o número: un texto puede ser una llave
function auditarCambio(req, anterior, guardada) {
  if (anterior && JSON.stringify(anterior.valor) === JSON.stringify(guardada.valor)) return;
  const valor = typeof guardada.valor === 'boolean' || typeof guardada.valor === 'number' ? ` → ${guardada.valor}` : '';
  registrarAuditoria({ usuario_id: req.user.userId, accion: 'Cambió configuración', entidad: 'configuracion', entidad_id: guardada.id, detalles: `${guardada.seccion}.${guardada.clave}${valor}`, ip: req.ip });
}

// La pantalla reenvía cada clave tal como la leyó y el sanitizador global
// vuelve a escapar lo ya guardado ("&" llega como "&amp;" y "&amp;" como
// "&amp;amp;"). Si lo que llega es justo lo guardado pasado por el
// sanitizador, nadie lo cambió: se conserva lo guardado, así el texto no se
// daña con cada guardado ni la bitácora anota un cambio que no hubo.
// Las llaves se comparan en orden: jsonb no conserva el orden en que llegaron
const jsonOrdenado = (valor) => JSON.stringify(valor, (_clave, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
  : v));
function valorAGuardar(anterior, valor) {
  return anterior && jsonOrdenado(sanitizeObject(anterior.valor)) === jsonOrdenado(valor) ? anterior.valor : valor;
}

// Actualizar un valor con sección/clave en el body (dirección).
// Las pantallas de Configuración y Personalización guardan con esta forma.
router.put('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { seccion, clave, valor } = req.body;
    if (!seccion || !clave || valor === undefined) {
      return res.status(400).json({ success: false, message: 'Sección, clave y valor son requeridos' });
    }
    const anterior = await pool.query(
      'SELECT valor FROM core.tblconfiguracion_sistema WHERE seccion = $1 AND clave = $2',
      [seccion, clave]
    );
    const result = await pool.query(
      `UPDATE core.tblconfiguracion_sistema SET valor = $1, updated_at = NOW(), updated_by = $2 WHERE seccion = $3 AND clave = $4 RETURNING *`,
      [JSON.stringify(valorAGuardar(anterior.rows[0], valor)), req.user.userId, seccion, clave]
    );
    let guardada = result.rows[0];
    if (!guardada) {
      const creada = await pool.query(
        'INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [seccion, clave, JSON.stringify(valor), req.user.userId]
      );
      guardada = creada.rows[0];
    }
    auditarCambio(req, anterior.rows[0], guardada);
    res.json({ success: true, message: 'Configuración actualizada' });
  } catch (error) {
    console.error('Error PUT /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar configuración' });
  }
});

// Actualizar un valor (dirección)
router.put('/:seccion/:clave', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { seccion, clave } = req.params;
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, message: 'Valor es requerido' });
    const anterior = await pool.query(
      'SELECT valor FROM core.tblconfiguracion_sistema WHERE seccion = $1 AND clave = $2',
      [seccion, clave]
    );
    const result = await pool.query(
      `UPDATE core.tblconfiguracion_sistema SET valor = $1, updated_at = NOW(), updated_by = $2 WHERE seccion = $3 AND clave = $4 RETURNING *`,
      [JSON.stringify(valorAGuardar(anterior.rows[0], valor)), req.user.userId, seccion, clave]
    );
    let guardada = result.rows[0];
    if (!guardada) {
      // Si no existe, crear
      const creada = await pool.query(
        'INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [seccion, clave, JSON.stringify(valor), req.user.userId]
      );
      guardada = creada.rows[0];
    }
    auditarCambio(req, anterior.rows[0], guardada);
    res.json({ success: true, message: 'Configuración actualizada' });
  } catch (error) {
    console.error('Error PUT /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar configuración' });
  }
});

// Crear nueva entrada (dirección)
router.post('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { seccion, clave, valor } = req.body;
    if (!seccion || !clave || valor === undefined) return res.status(400).json({ success: false, message: 'Sección, clave y valor son requeridos' });
    const result = await pool.query(
      'INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [seccion, clave, JSON.stringify(valor), req.user.userId]
    );
    const creada = result.rows[0];
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Creó configuración', entidad: 'configuracion', entidad_id: creada.id, detalles: `${creada.seccion}.${creada.clave}`, ip: req.ip });
    res.status(201).json({ success: true, configuracion: creada });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe esta configuración' });
    console.error('Error POST /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear configuración' });
  }
});

// Eliminar entrada (dirección)
router.delete('/:seccion/:clave', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM core.tblconfiguracion_sistema WHERE seccion = $1 AND clave = $2 RETURNING id, seccion, clave',
      [req.params.seccion, req.params.clave]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
    const eliminada = result.rows[0];
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Eliminó configuración', entidad: 'configuracion', entidad_id: eliminada.id, detalles: `${eliminada.seccion}.${eliminada.clave}`, ip: req.ip });
    res.json({ success: true, message: 'Configuración eliminada' });
  } catch (error) {
    console.error('Error DELETE /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar configuración' });
  }
});

module.exports = router;
