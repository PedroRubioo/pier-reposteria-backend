// routes/promocionesRoutes.js — Promociones
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

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

    res.status(201).json({ success: true, promocion: result.rows[0] });
  } catch (error) {
    console.error('Error POST /promociones:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear promoción' });
  }
});

router.put('/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { tipo, producto_id, estado, descuento_porcentaje, precio_original, precio_oferta, fecha_inicio, fecha_fin, nombre_temporada, badge_destacado, titulo_banner, subtitulo_banner, descripcion_banner, codigo_descuento } = req.body;
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
    res.json({ success: true, promocion: result.rows[0] });
  } catch (error) {
    console.error('Error PUT /promociones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar promoción' });
  }
});

// Eliminar promoción
router.delete('/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblpromociones WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrada' });
    res.json({ success: true, message: 'Promoción eliminada' });
  } catch (error) {
    console.error('Error DELETE /promociones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar promoción' });
  }
});

module.exports = router;