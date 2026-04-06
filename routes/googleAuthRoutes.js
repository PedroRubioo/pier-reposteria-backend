// routes/googleAuthRoutes.js
const express = require('express');
const router = express.Router();
const passport = require('../config/passport');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

console.log('🔐 Configuración Google OAuth:');
console.log('   FRONTEND_URL:', FRONTEND_URL);
console.log('   GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL);

// ========================================
// WEB — NO MODIFICAR
// ========================================

// Ruta para iniciar autenticación con Google
router.get('/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email']
  })
);

// Callback de Google después de autenticación
router.get('/google/callback',
  passport.authenticate('google', { 
    failureRedirect: `${FRONTEND_URL}/login?error=google_auth_failed`
  }),
  (req, res) => {
    try {
      const user = req.user;
      
      // Generar token JWT — usa user.id (PostgreSQL), NO user._id (MongoDB)
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          rol: user.rol 
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      console.log('✅ Login con Google exitoso:', user.email);
      console.log('🔗 Redirigiendo a frontend:', FRONTEND_URL);
      
      const redirectUrl = `${FRONTEND_URL}/auth/google/success?token=${token}&user=${encodeURIComponent(JSON.stringify(user))}`;
      
      console.log('🔍 URL de redirección:', redirectUrl);
      
      req.logout((err) => {
        if (err) console.error('Error al hacer logout:', err);
        res.redirect(redirectUrl);
      });
      
    } catch (error) {
      console.error('❌ Error en callback de Google:', error);
      res.redirect(`${FRONTEND_URL}/login?error=callback_error`);
    }
  }
);

// ========================================
// MÓVIL — Flutter / Android / iOS
// ========================================

const { pool } = require('../config/database');
const Usuario = require('../models/Usuario');
const { OAuth2Client } = require('google-auth-library');

// POST /api/auth/google/mobile
// Recibe el idToken de google_sign_in en Flutter
// Usa GOOGLE_CLIENT_ID_MOBILE (mismo proyecto que web, Web Client ID)
router.post('/google/mobile', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'idToken es requerido'
      });
    }

    // Usa GOOGLE_CLIENT_ID_MOBILE si existe, si no cae en GOOGLE_CLIENT_ID
    const mobileClientId = process.env.GOOGLE_CLIENT_ID_MOBILE || process.env.GOOGLE_CLIENT_ID;

    if (!mobileClientId) {
      console.error('❌ GOOGLE_CLIENT_ID_MOBILE no configurado');
      return res.status(500).json({
        success: false,
        message: 'Configuración de Google OAuth incompleta'
      });
    }

    // Verificar el idToken con Google
    const client = new OAuth2Client(mobileClientId);
    const ticket = await client.verifyIdToken({
      idToken,
      audience: mobileClientId,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, given_name, family_name, name } = payload;

    console.log('📱 Google Mobile OAuth para:', email);

    // Buscar usuario por google_id
    let result = await pool.query(
      'SELECT * FROM core.tblusuarios WHERE google_id = $1',
      [googleId]
    );

    let usuarioDoc = result.rows[0];

    if (usuarioDoc) {
      // Usuario existente — actualizar último acceso
      await pool.query(
        'UPDATE core.tblusuarios SET ultimo_acceso = NOW() WHERE id = $1',
        [usuarioDoc.id]
      );
      console.log('✅ Login móvil con Google (usuario existente):', email);
    } else {
      // Buscar por email
      result = await pool.query(
        'SELECT * FROM core.tblusuarios WHERE email = $1',
        [email.toLowerCase()]
      );
      usuarioDoc = result.rows[0];

      if (usuarioDoc) {
        // Vincular google_id al usuario existente
        await pool.query(
          'UPDATE core.tblusuarios SET google_id = $1, email_verificado = true, ultimo_acceso = NOW() WHERE id = $2',
          [googleId, usuarioDoc.id]
        );
        usuarioDoc.google_id = googleId;
        console.log('✅ Cuenta vinculada a Google (móvil):', email);
      } else {
        // Crear nuevo usuario
        const nombre = given_name || (name ? name.split(' ')[0] : 'Usuario');
        const apellido = family_name || (name ? name.split(' ').slice(1).join(' ') : 'Usuario');
        const password_hash = await Usuario.hashPassword('google-oauth-' + googleId);

        const insertResult = await pool.query(
          `INSERT INTO core.tblusuarios 
           (nombre, apellido, email, password_hash, telefono, rol, activo, email_verificado, google_id, created_at, updated_at, ultimo_acceso)
           VALUES ($1, $2, $3, $4, $5, 'cliente', true, true, $6, NOW(), NOW(), NOW())
           RETURNING *`,
          [nombre, apellido, email.toLowerCase(), password_hash, '0000000000', googleId]
        );

        usuarioDoc = insertResult.rows[0];
        console.log('✅ Nuevo usuario registrado con Google (móvil):', email);
      }
    }

    // Generar JWT
    const usuario = new Usuario(usuarioDoc);
    const token = jwt.sign(
      {
        userId: usuarioDoc.id,
        email: usuarioDoc.email,
        rol: usuarioDoc.rol,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Autenticación con Google exitosa',
      token,
      user: usuario.toJSON(),
    });

  } catch (error) {
    console.error('❌ Error en Google Mobile OAuth:', error.message);
    return res.status(401).json({
      success: false,
      message: 'Token de Google inválido o expirado'
    });
  }
});

module.exports = router;