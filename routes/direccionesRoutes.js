// routes/direccionesRoutes.js — Libreta de direcciones de entrega del cliente
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

// ── Listar mis direcciones (con zona y tarifa si hay cobertura) ──
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id, d.alias, d.calle_numero, d.colonia, d.referencias, d.telefono_contacto, d.lat, d.lng, d.created_at,
             z.id AS zona_id, z.nombre AS zona_nombre, z.tarifa
      FROM core.tbldirecciones d
      LEFT JOIN core.tblzonas_colonias zc ON LOWER(zc.colonia) = LOWER(d.colonia)
      LEFT JOIN core.tblzonas_envio z ON z.id = zc.zona_id AND z.activa = TRUE
      WHERE d.usuario_id = $1 AND d.activa = TRUE
      ORDER BY d.created_at DESC
    `, [req.user.userId]);
    res.json({ success: true, direcciones: result.rows });
  } catch (error) {
    console.error('Error GET /direcciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener direcciones' });
  }
});

// ── Crear dirección ──
router.post('/', verifyToken, async (req, res) => {
  try {
    const { alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng } = req.body;
    if (!alias || !calle_numero || !colonia) {
      return res.status(400).json({ success: false, message: 'Alias, calle y número, y colonia son requeridos' });
    }
    if (!/\d/.test(calle_numero)) {
      return res.status(400).json({ success: false, message: 'Incluye el número de la casa en "Calle y número"' });
    }
    const result = await pool.query(`
      INSERT INTO core.tbldirecciones (usuario_id, alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id, alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng, created_at
    `, [req.user.userId, alias.trim(), calle_numero.trim(), colonia.trim(), referencias || null, telefono_contacto || null, lat ?? null, lng ?? null]);
    res.status(201).json({ success: true, direccion: result.rows[0], message: 'Dirección guardada' });
  } catch (error) {
    console.error('Error POST /direcciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar dirección' });
  }
});

// ── Actualizar dirección propia ──
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng } = req.body;
    if (calle_numero !== undefined && !/\d/.test(calle_numero)) {
      return res.status(400).json({ success: false, message: 'Incluye el número de la casa en "Calle y número"' });
    }
    const result = await pool.query(`
      UPDATE core.tbldirecciones
      SET alias = COALESCE($1, alias),
          calle_numero = COALESCE($2, calle_numero),
          colonia = COALESCE($3, colonia),
          referencias = COALESCE($4, referencias),
          telefono_contacto = COALESCE($5, telefono_contacto),
          lat = COALESCE($6, lat),
          lng = COALESCE($7, lng),
          updated_at = NOW()
      WHERE id = $8 AND usuario_id = $9 AND activa = TRUE
      RETURNING id, alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng
    `, [alias, calle_numero, colonia, referencias, telefono_contacto, lat ?? null, lng ?? null, req.params.id, req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    res.json({ success: true, direccion: result.rows[0], message: 'Dirección actualizada' });
  } catch (error) {
    console.error('Error PUT /direcciones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar dirección' });
  }
});

// ── Eliminar dirección propia (borrado lógico: los pedidos guardan snapshot) ──
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE core.tbldirecciones SET activa = FALSE, updated_at = NOW() WHERE id = $1 AND usuario_id = $2 AND activa = TRUE RETURNING id',
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    res.json({ success: true, message: 'Dirección eliminada' });
  } catch (error) {
    console.error('Error DELETE /direcciones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar dirección' });
  }
});

module.exports = router;
