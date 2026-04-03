// routes/sorteosRoutes.js — Sorteos
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Listar sorteos (dirección)
router.get('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, u.nombre AS ganador_nombre, u.apellido AS ganador_apellido
      FROM core.tblsorteos s
      LEFT JOIN core.tblusuarios u ON s.ganador_id = u.id
      ORDER BY s.created_at DESC
    `);
    res.json({ success: true, sorteos: result.rows });
  } catch (error) {
    console.error('Error GET /sorteos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener sorteos' });
  }
});

// Crear sorteo
router.post('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { nombre, premio, min_pedidos } = req.body;
    if (!nombre || !premio) return res.status(400).json({ success: false, message: 'Nombre y premio son requeridos' });
    const result = await pool.query(
      'INSERT INTO core.tblsorteos (nombre, premio, min_pedidos, created_at) VALUES ($1,$2,$3,NOW()) RETURNING *',
      [nombre, premio, min_pedidos || 0]
    );
    res.status(201).json({ success: true, sorteo: result.rows[0] });
  } catch (error) {
    console.error('Error POST /sorteos:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear sorteo' });
  }
});

// Ejecutar sorteo (seleccionar ganador aleatorio)
router.post('/:id/ejecutar', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const sorteo = await pool.query('SELECT * FROM core.tblsorteos WHERE id = $1', [req.params.id]);
    if (sorteo.rows.length === 0) return res.status(404).json({ success: false, message: 'Sorteo no encontrado' });
    if (sorteo.rows[0].ganador_id) return res.status(400).json({ success: false, message: 'Este sorteo ya tiene ganador' });

    // Obtener participantes elegibles (clientes con min_pedidos completados)
    const minPedidos = sorteo.rows[0].min_pedidos || 0;
    const participantes = await pool.query(`
      SELECT u.id, u.nombre, u.apellido, u.email, COUNT(p.id) AS total_pedidos
      FROM core.tblusuarios u
      JOIN core.tblpedidos p ON p.usuario_id = u.id AND p.estado = 'completado'
      WHERE u.rol = 'cliente' AND u.activo = true
      GROUP BY u.id
      HAVING COUNT(p.id) >= $1
    `, [minPedidos]);

    if (participantes.rows.length === 0) return res.status(400).json({ success: false, message: 'No hay participantes elegibles' });

    // Seleccionar ganador aleatorio
    const idx = Math.floor(Math.random() * participantes.rows.length);
    const ganador = participantes.rows[idx];

    await pool.query(
      'UPDATE core.tblsorteos SET ganador_id = $1, total_participantes = $2 WHERE id = $3',
      [ganador.id, participantes.rows.length, req.params.id]
    );

    res.json({
      success: true,
      ganador: { id: ganador.id, nombre: ganador.nombre, apellido: ganador.apellido, email: ganador.email },
      total_participantes: participantes.rows.length,
      message: `¡${ganador.nombre} ${ganador.apellido} ganó "${sorteo.rows[0].premio}"!`
    });
  } catch (error) {
    console.error('Error POST /sorteos/:id/ejecutar:', error.message);
    res.status(500).json({ success: false, message: 'Error al ejecutar sorteo' });
  }
});

module.exports = router;