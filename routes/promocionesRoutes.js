// routes/promocionesRoutes.js — Promociones
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { registrarAuditoria } = require('../utils/auditoria');

// Bitácora: '"<título o nombre>" · <tipo> · <descuento>%' con lo que guardó la
// base. Sin título de banner ni nombre de temporada, se nombra por su producto.
// Nunca lanza: se llama con el cambio ya hecho, y si la consulta del nombre
// falla el detalle sale sin él en vez de convertir la respuesta en 500
async function detallePromocion(promo) {
  let nombre = promo.titulo_banner || promo.nombre_temporada;
  if (!nombre && promo.producto_id) {
    const producto = await pool.query('SELECT nombre FROM core.tblproductos WHERE id = $1', [promo.producto_id]).catch(() => null);
    nombre = producto?.rows[0]?.nombre;
  }
  const partes = [];
  if (nombre) partes.push(`"${nombre}"`);
  partes.push(promo.tipo);
  if (promo.descuento_porcentaje !== null) partes.push(`${Number(promo.descuento_porcentaje)}%`);
  return partes.join(' · ');
}

// Candado (Diseno_Panel_Personal.md §4.12): un producto no puede tener dos
// promociones activas, porque el carrito y el cobro duplican el renglón.
// Devuelve la otra promoción activa vigente del producto, o null
async function otraPromocionActiva(productoId, excluirId) {
  const { rows } = await pool.query(
    `SELECT id, tipo FROM core.tblpromociones
      WHERE producto_id = $1 AND estado = 'activa' AND (fecha_fin IS NULL OR fecha_fin > NOW()) AND id <> $2 LIMIT 1`,
    [productoId, excluirId]
  );
  return rows[0] || null;
}
const mensajeCandado = (tipo) => `Ese producto ya tiene una promoción activa (${tipo}). Páusala o termínala antes de activar otra: dos a la vez duplican el cobro en el carrito.`;

// Promociones activas (público)
router.get('/activas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pr.*, p.nombre AS producto_nombre, p.imagen_url AS producto_imagen, p.precio_chico
      FROM core.tblpromociones pr
      LEFT JOIN core.tblproductos p ON pr.producto_id = p.id
      WHERE pr.estado = 'activa' AND (pr.fecha_fin IS NULL OR pr.fecha_fin > NOW())
      ORDER BY pr.created_at DESC
    `);
    res.json({ success: true, promociones: result.rows });
  } catch (error) {
    console.error('Error GET /promociones/activas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener promociones' });
  }
});

// Validar código de descuento (cliente)
router.post('/validar-codigo', verifyToken, async (req, res) => {
  try {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ success: false, message: 'Código es requerido' });
    const result = await pool.query(
      `SELECT * FROM core.tblpromociones WHERE codigo_descuento = $1 AND estado = 'activa' AND (fecha_fin IS NULL OR fecha_fin > NOW())`,
      [codigo.toUpperCase()]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Código inválido o expirado' });
    res.json({ success: true, promocion: result.rows[0] });
  } catch (error) {
    console.error('Error POST /promociones/validar-codigo:', error.message);
    res.status(500).json({ success: false, message: 'Error al validar código' });
  }
});

// CRUD (empleado+)
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    // Auto-vencer promociones expiradas
    await pool.query(`UPDATE core.tblpromociones SET estado = 'vencida' WHERE estado = 'activa' AND fecha_fin IS NOT NULL AND fecha_fin < NOW()`);
    const result = await pool.query(`
      SELECT pr.*, p.nombre AS producto_nombre, p.imagen_url AS producto_imagen, p.precio_chico, p.precio_grande
      FROM core.tblpromociones pr LEFT JOIN core.tblproductos p ON pr.producto_id = p.id
      ORDER BY pr.created_at DESC
    `);
    res.json({ success: true, promociones: result.rows });
  } catch (error) {
    console.error('Error GET /promociones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener promociones' });
  }
});

router.post('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { tipo, producto_id, estado, descuento_porcentaje, precio_original, precio_oferta, fecha_inicio, fecha_fin, nombre_temporada, badge_destacado, titulo_banner, subtitulo_banner, descripcion_banner, codigo_descuento } = req.body;
    if (!tipo) return res.status(400).json({ success: false, message: 'Tipo es requerido' });
    if ((estado || 'activa') === 'activa' && producto_id) {
      const otra = await otraPromocionActiva(producto_id, 0);
      if (otra) return res.status(409).json({ success: false, message: mensajeCandado(otra.tipo) });
    }
    const result = await pool.query(
      `INSERT INTO core.tblpromociones (tipo, producto_id, estado, descuento_porcentaje, precio_original, precio_oferta, fecha_inicio, fecha_fin, nombre_temporada, badge_destacado, titulo_banner, subtitulo_banner, descripcion_banner, codigo_descuento, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW()) RETURNING *`,
      [tipo, producto_id||null, estado||'activa', descuento_porcentaje||null, precio_original||null, precio_oferta||null, fecha_inicio||null, fecha_fin||null, nombre_temporada||null, badge_destacado||null, titulo_banner||null, subtitulo_banner||null, descripcion_banner||null, codigo_descuento||null]
    );

    // Notificación masiva a todos los clientes si la promoción está activa
    if ((estado || 'activa') === 'activa') {
      try {
        const { crearNotificacionMasiva } = require('../services/notificacionHelper');
        const tituloNotif = titulo_banner || nombre_temporada || '¡Nueva promoción!';
        const mensajeNotif = descripcion_banner || subtitulo_banner || `${descuento_porcentaje ? descuento_porcentaje + '% de descuento' : 'Aprovecha nuestra nueva oferta'}${codigo_descuento ? '. Código: ' + codigo_descuento : ''}`;
        await crearNotificacionMasiva({
          tipo: 'promocion',
          titulo: `🎉 ${tituloNotif}`,
          mensaje: mensajeNotif,
          enviado_por: req.user.userId
        });
      } catch (notifError) {
        console.error('Error al enviar notificación masiva (promoción creada correctamente):', notifError.message);
      }
    }

    const detalles = await detallePromocion(result.rows[0]);
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Creó promoción', entidad: 'promocion', entidad_id: result.rows[0].id, detalles, ip: req.ip });
    res.status(201).json({ success: true, promocion: result.rows[0] });
  } catch (error) {
    console.error('Error POST /promociones:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear promoción' });
  }
});

router.put('/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { tipo, producto_id, estado, descuento_porcentaje, precio_original, precio_oferta, fecha_inicio, fecha_fin, nombre_temporada, badge_destacado, titulo_banner, subtitulo_banner, descripcion_banner, codigo_descuento } = req.body;
    // Candado: el resultado del UPDATE (lo que viene o, si no, lo que ya
    // tenía, igual que sus COALESCE) no puede quedar activo junto a otra
    const previa = await pool.query('SELECT estado::text AS estado, producto_id FROM core.tblpromociones WHERE id = $1', [req.params.id]);
    if (previa.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrada' });
    const estadoFinal = estado ?? previa.rows[0].estado;
    const productoFinal = producto_id ?? previa.rows[0].producto_id;
    if (estadoFinal === 'activa' && productoFinal) {
      const otra = await otraPromocionActiva(productoFinal, req.params.id);
      if (otra) return res.status(409).json({ success: false, message: mensajeCandado(otra.tipo) });
    }
    const result = await pool.query(
      `UPDATE core.tblpromociones SET tipo=COALESCE($1,tipo), producto_id=COALESCE($2,producto_id), estado=COALESCE($3,estado),
       descuento_porcentaje=COALESCE($4,descuento_porcentaje), precio_original=COALESCE($5,precio_original), precio_oferta=COALESCE($6,precio_oferta),
       fecha_inicio=COALESCE($7,fecha_inicio), fecha_fin=COALESCE($8,fecha_fin), nombre_temporada=COALESCE($9,nombre_temporada),
       badge_destacado=COALESCE($10,badge_destacado), titulo_banner=COALESCE($11,titulo_banner), subtitulo_banner=COALESCE($12,subtitulo_banner),
       descripcion_banner=COALESCE($13,descripcion_banner), codigo_descuento=COALESCE($14,codigo_descuento)
       WHERE id=$15 RETURNING *`,
      [tipo, producto_id, estado, descuento_porcentaje, precio_original, precio_oferta, fecha_inicio, fecha_fin, nombre_temporada, badge_destacado, titulo_banner, subtitulo_banner, descripcion_banner, codigo_descuento, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrada' });
    const promo = result.rows[0];
    // El botón de pausar/activar solo manda el estado: la bitácora lo muestra
    let detalles = await detallePromocion(promo);
    if (estado) detalles += ` · estado: ${promo.estado}`;
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Actualizó promoción', entidad: 'promocion', entidad_id: promo.id, detalles, ip: req.ip });
    res.json({ success: true, promocion: promo });
  } catch (error) {
    console.error('Error PUT /promociones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar promoción' });
  }
});

// Eliminar promoción
router.delete('/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM core.tblpromociones WHERE id = $1 RETURNING id, tipo, producto_id, descuento_porcentaje, nombre_temporada, titulo_banner',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrada' });
    const detalles = await detallePromocion(result.rows[0]);
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Eliminó promoción', entidad: 'promocion', entidad_id: result.rows[0].id, detalles, ip: req.ip });
    res.json({ success: true, message: 'Promoción eliminada' });
  } catch (error) {
    console.error('Error DELETE /promociones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar promoción' });
  }
});

module.exports = router;