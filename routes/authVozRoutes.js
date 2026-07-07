// routes/authVozRoutes.js
// =====================================================================
// Login por voz (Alexa skill) para empleados
// Endpoints públicos:
//   POST /api/auth/login-empleado   - { codigo_empleado, pin, device_id } -> JWT
// Endpoints admin (gerencia / direccion_general):
//   PUT    /api/auth/asignar-codigo/:usuarioId    - { codigo_empleado }
//   PUT    /api/auth/asignar-pin/:usuarioId       - { pin }
//   DELETE /api/auth/revocar-acceso-voz/:usuarioId
//   GET    /api/auth/intentos-voz                  - últimos intentos (auditoría)
// =====================================================================

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';

// Rate limit por device: N intentos fallidos en M minutos
const MAX_INTENTOS_DEVICE = 5;
const VENTANA_MIN_DEVICE = 15;

// Rate limit por cuenta: tras N intentos consecutivos, bloquear PIN
const MAX_INTENTOS_PIN = 5;
const BLOQUEO_PIN_MIN = 15;

// Roles válidos para login por voz
const ROLES_VOZ = ['empleado', 'gerencia', 'direccion_general'];

async function registrarIntento(device_id, codigo_empleado, exito, motivo_fallo) {
  try {
    await pool.query(
      `INSERT INTO core.tbllogin_intentos_voz (device_id, codigo_empleado, exito, motivo_fallo)
       VALUES ($1, $2, $3, $4)`,
      [device_id, codigo_empleado ? parseInt(codigo_empleado) : null, exito, motivo_fallo]
    );
  } catch (e) {
    console.error('No se pudo registrar intento de voz:', e.message);
  }
}

// =====================================================================
// POST /api/auth/login-empleado
// Login por voz: codigo_empleado + pin → JWT corto (12 h)
// =====================================================================
router.post('/login-empleado', async (req, res) => {
  const { codigo_empleado, pin, device_id } = req.body;

  if (!codigo_empleado || !pin || !device_id) {
    return res.status(400).json({
      success: false,
      codigo: 'invalid_request',
      message: 'codigo_empleado, pin y device_id son requeridos'
    });
  }

  try {
    // 1. Rate limit por device (intentos fallidos en últimos 15 min)
    const ventana = await pool.query(
      `SELECT COUNT(*) AS n FROM core.tbllogin_intentos_voz
       WHERE device_id = $1 AND exito = FALSE
       AND created_at > NOW() - INTERVAL '15 minutes'`,
      [device_id]
    );

    if (parseInt(ventana.rows[0].n) >= MAX_INTENTOS_DEVICE) {
      await registrarIntento(device_id, codigo_empleado, false, 'rate_limit_device');
      return res.status(429).json({
        success: false,
        codigo: 'rate_limit',
        message: 'Demasiados intentos desde este dispositivo. Intenta en unos minutos.'
      });
    }

    // 2. Buscar usuario por codigo_empleado (solo activos y con rol de empleado)
    // rol es un ENUM (rol_usuario), por eso casteamos a text para comparar contra array
    const result = await pool.query(
      `SELECT * FROM core.tblusuarios
       WHERE codigo_empleado = $1 AND activo = TRUE AND rol::text = ANY($2::text[])`,
      [parseInt(codigo_empleado), ROLES_VOZ]
    );
    const usuario = result.rows[0];

    if (!usuario) {
      await registrarIntento(device_id, codigo_empleado, false, 'codigo_no_existe');
      return res.status(401).json({
        success: false,
        codigo: 'invalid_credentials',
        message: 'Credenciales inválidas'
      });
    }

    // 3. ¿Cuenta bloqueada por intentos previos?
    if (usuario.pin_bloqueado_hasta && new Date(usuario.pin_bloqueado_hasta) > new Date()) {
      await registrarIntento(device_id, codigo_empleado, false, 'cuenta_bloqueada');
      return res.status(401).json({
        success: false,
        codigo: 'cuenta_bloqueada',
        message: 'Cuenta temporalmente bloqueada. Espera unos minutos.'
      });
    }

    // 4. ¿Tiene PIN asignado?
    if (!usuario.pin_hash) {
      await registrarIntento(device_id, codigo_empleado, false, 'sin_pin');
      return res.status(401).json({
        success: false,
        codigo: 'invalid_credentials',
        message: 'Credenciales inválidas'
      });
    }

    // 5. Comparar PIN
    const ok = await bcrypt.compare(String(pin), usuario.pin_hash);
    if (!ok) {
      const nuevoConteo = (usuario.intentos_pin_fallidos || 0) + 1;
      if (nuevoConteo >= MAX_INTENTOS_PIN) {
        await pool.query(
          `UPDATE core.tblusuarios
             SET intentos_pin_fallidos = $1,
                 pin_bloqueado_hasta = NOW() + INTERVAL '15 minutes'
           WHERE id = $2`,
          [nuevoConteo, usuario.id]
        );
      } else {
        await pool.query(
          `UPDATE core.tblusuarios SET intentos_pin_fallidos = $1 WHERE id = $2`,
          [nuevoConteo, usuario.id]
        );
      }
      await registrarIntento(device_id, codigo_empleado, false, 'pin_incorrecto');
      return res.status(401).json({
        success: false,
        codigo: 'invalid_credentials',
        message: 'Credenciales inválidas'
      });
    }

    // 6. Login exitoso → resetear contador y registrar acceso
    await pool.query(
      `UPDATE core.tblusuarios
         SET intentos_pin_fallidos = 0,
             pin_bloqueado_hasta = NULL,
             ultimo_acceso = NOW()
       WHERE id = $1`,
      [usuario.id]
    );

    await registrarIntento(device_id, codigo_empleado, true, null);

    // 7. JWT corto (12 h) para empleado por voz
    const token = jwt.sign(
      { userId: usuario.id, email: usuario.email, rol: usuario.rol, via: 'voz' },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: usuario.id,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        rol: usuario.rol,
        codigo_empleado: usuario.codigo_empleado
      }
    });
  } catch (error) {
    console.error('Error /api/auth/login-empleado:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// =====================================================================
// PUT /api/auth/asignar-codigo/:usuarioId  (admin)
// =====================================================================
router.put('/asignar-codigo/:usuarioId',
  verifyToken,
  verifyRole('gerencia', 'direccion_general'),
  async (req, res) => {
    const { usuarioId } = req.params;
    const codigo = parseInt(req.body.codigo_empleado);

    if (!Number.isInteger(codigo) || codigo < 100 || codigo > 999999) {
      return res.status(400).json({
        success: false,
        message: 'codigo_empleado debe ser un entero entre 100 y 999999'
      });
    }

    try {
      const u = await pool.query(
        `SELECT id, rol FROM core.tblusuarios WHERE id = $1 AND activo = TRUE`,
        [usuarioId]
      );
      if (!u.rows[0]) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }
      if (!ROLES_VOZ.includes(u.rows[0].rol)) {
        return res.status(400).json({
          success: false,
          message: 'Solo empleados/gerencia/dirección pueden tener código de voz'
        });
      }

      const dup = await pool.query(
        `SELECT id FROM core.tblusuarios WHERE codigo_empleado = $1 AND id != $2`,
        [codigo, usuarioId]
      );
      if (dup.rows[0]) {
        return res.status(409).json({ success: false, message: 'Ese código ya está en uso por otro empleado' });
      }

      await pool.query(
        `UPDATE core.tblusuarios SET codigo_empleado = $1, updated_at = NOW() WHERE id = $2`,
        [codigo, usuarioId]
      );

      return res.json({ success: true, message: 'Código asignado correctamente' });
    } catch (error) {
      console.error('Error /asignar-codigo:', error);
      return res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
  }
);

// =====================================================================
// PUT /api/auth/asignar-pin/:usuarioId  (admin)
// =====================================================================
router.put('/asignar-pin/:usuarioId',
  verifyToken,
  verifyRole('gerencia', 'direccion_general'),
  async (req, res) => {
    const { usuarioId } = req.params;
    const { pin } = req.body;

    if (!pin || !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({
        success: false,
        message: 'PIN debe ser numérico de 4 a 6 dígitos'
      });
    }

    try {
      const u = await pool.query(
        `SELECT id, rol FROM core.tblusuarios WHERE id = $1 AND activo = TRUE`,
        [usuarioId]
      );
      if (!u.rows[0]) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }
      if (!ROLES_VOZ.includes(u.rows[0].rol)) {
        return res.status(400).json({
          success: false,
          message: 'Solo empleados/gerencia/dirección pueden tener PIN de voz'
        });
      }

      const pin_hash = await bcrypt.hash(String(pin), 10);
      await pool.query(
        `UPDATE core.tblusuarios
           SET pin_hash = $1,
               pin_actualizado_at = NOW(),
               intentos_pin_fallidos = 0,
               pin_bloqueado_hasta = NULL,
               updated_at = NOW()
         WHERE id = $2`,
        [pin_hash, usuarioId]
      );

      return res.json({ success: true, message: 'PIN asignado correctamente' });
    } catch (error) {
      console.error('Error /asignar-pin:', error);
      return res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
  }
);

// =====================================================================
// DELETE /api/auth/revocar-acceso-voz/:usuarioId  (admin)
// =====================================================================
router.delete('/revocar-acceso-voz/:usuarioId',
  verifyToken,
  verifyRole('gerencia', 'direccion_general'),
  async (req, res) => {
    const { usuarioId } = req.params;
    try {
      await pool.query(
        `UPDATE core.tblusuarios
           SET codigo_empleado = NULL,
               pin_hash = NULL,
               pin_actualizado_at = NULL,
               intentos_pin_fallidos = 0,
               pin_bloqueado_hasta = NULL,
               updated_at = NOW()
         WHERE id = $1`,
        [usuarioId]
      );
      return res.json({ success: true, message: 'Acceso por voz revocado' });
    } catch (error) {
      console.error('Error /revocar-acceso-voz:', error);
      return res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
  }
);

// =====================================================================
// POST /api/auth/alexa/generar-codigo  (requiere sesión web)
// Genera un código de 6 dígitos de un solo uso (expira en 5 minutos)
// para vincular la cuenta del usuario con la skill de Alexa por voz.
// =====================================================================
router.post('/alexa/generar-codigo', verifyToken, async (req, res) => {
  try {
    const usuarioId = req.user.userId;

    // Invalidar códigos previos sin usar del mismo usuario
    await pool.query(
      `UPDATE core.tblcodigos_vinculacion_alexa
          SET usado = TRUE
        WHERE usuario_id = $1 AND usado = FALSE`,
      [usuarioId]
    );

    // Generar código de 6 dígitos SIN ceros a la izquierda
    // (Alexa transcribe con AMAZON.NUMBER y perdería el cero inicial)
    let codigo = null;
    for (let intento = 0; intento < 5 && !codigo; intento++) {
      const candidato = String(crypto.randomInt(100000, 1000000));
      const dup = await pool.query(
        `SELECT id FROM core.tblcodigos_vinculacion_alexa
          WHERE codigo = $1 AND usado = FALSE AND expira_en > NOW()`,
        [candidato]
      );
      if (!dup.rows[0]) codigo = candidato;
    }
    if (!codigo) {
      return res.status(500).json({ success: false, message: 'No se pudo generar el código, intenta de nuevo' });
    }

    await pool.query(
      `INSERT INTO core.tblcodigos_vinculacion_alexa (codigo, usuario_id, expira_en)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [codigo, usuarioId]
    );

    return res.json({ success: true, codigo, expira_en_segundos: 300 });
  } catch (error) {
    console.error('Error /alexa/generar-codigo:', error);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// =====================================================================
// POST /api/auth/alexa/canjear-codigo  (público, lo llama la skill)
// { codigo, device_id } -> JWT (7 días) si el código es vigente.
// Un solo uso; rate limit por device reutilizando tbllogin_intentos_voz.
// =====================================================================
router.post('/alexa/canjear-codigo', async (req, res) => {
  const { codigo, device_id } = req.body;

  if (!codigo || !device_id) {
    return res.status(400).json({
      success: false,
      codigo: 'invalid_request',
      message: 'codigo y device_id son requeridos'
    });
  }

  try {
    // Rate limit por device (mismos umbrales que login-empleado)
    const ventana = await pool.query(
      `SELECT COUNT(*) AS n FROM core.tbllogin_intentos_voz
       WHERE device_id = $1 AND exito = FALSE
       AND created_at > NOW() - INTERVAL '15 minutes'`,
      [device_id]
    );
    if (parseInt(ventana.rows[0].n) >= MAX_INTENTOS_DEVICE) {
      await registrarIntento(device_id, null, false, 'rate_limit_device');
      return res.status(429).json({
        success: false,
        codigo: 'rate_limit',
        message: 'Demasiados intentos desde este dispositivo. Intenta en unos minutos.'
      });
    }

    const result = await pool.query(
      `SELECT c.id AS codigo_id, c.usado, c.expira_en,
              u.id, u.nombre, u.apellido, u.email, u.rol, u.activo
         FROM core.tblcodigos_vinculacion_alexa c
         JOIN core.tblusuarios u ON u.id = c.usuario_id
        WHERE c.codigo = $1
        ORDER BY c.created_at DESC
        LIMIT 1`,
      [String(codigo)]
    );
    const fila = result.rows[0];

    const invalido = !fila || fila.usado
      || new Date(fila.expira_en) < new Date()
      || !fila.activo;

    if (invalido) {
      // Respuesta genérica: no revelamos si existe, expiró o ya se usó
      await registrarIntento(device_id, null, false, 'codigo_vinculacion_invalido');
      return res.status(401).json({
        success: false,
        codigo: 'invalid_code',
        message: 'Código inválido o expirado'
      });
    }

    // Marcar como usado (un solo canje) y registrar qué Alexa lo usó
    await pool.query(
      `UPDATE core.tblcodigos_vinculacion_alexa
          SET usado = TRUE, device_id = $1
        WHERE id = $2`,
      [device_id, fila.codigo_id]
    );

    await registrarIntento(device_id, null, true, null);
    await pool.query(
      `UPDATE core.tblusuarios SET ultimo_acceso = NOW() WHERE id = $1`,
      [fila.id]
    );

    const token = jwt.sign(
      { userId: fila.id, email: fila.email, rol: fila.rol, via: 'alexa_codigo' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: fila.id,
        nombre: fila.nombre,
        apellido: fila.apellido,
        rol: fila.rol
      }
    });
  } catch (error) {
    console.error('Error /alexa/canjear-codigo:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// =====================================================================
// GET /api/auth/intentos-voz  (admin)
// Últimos 100 intentos para auditoría
// =====================================================================
router.get('/intentos-voz',
  verifyToken,
  verifyRole('gerencia', 'direccion_general'),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT iv.id, iv.device_id, iv.codigo_empleado, iv.exito, iv.motivo_fallo, iv.created_at,
                u.nombre, u.apellido, u.rol
           FROM core.tbllogin_intentos_voz iv
           LEFT JOIN core.tblusuarios u ON u.codigo_empleado = iv.codigo_empleado
          ORDER BY iv.created_at DESC
          LIMIT 100`
      );
      return res.json({ success: true, intentos: result.rows });
    } catch (error) {
      console.error('Error /intentos-voz:', error);
      return res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
  }
);

module.exports = router;
