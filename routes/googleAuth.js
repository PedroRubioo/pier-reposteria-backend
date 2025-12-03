const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { getDB } = require('../config/database');
const Usuario = require('../models/Usuario');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Configurar cliente OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

// Generar URL de autenticación
router.get('/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.redirect(url);
});

// Callback de Google
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;

    // Intercambiar código por tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Obtener info del usuario
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    console.log('✅ Usuario autenticado:', profile.email);

    // Buscar o crear usuario
    const db = await getDB();
    
    let usuarioDoc = await db.collection('Usuarios').findOne({
      email: profile.email.toLowerCase()
    });

    if (!usuarioDoc) {
      // Crear nuevo usuario
      const nuevoUsuario = new Usuario({
        nombre: profile.given_name || profile.name.split(' ')[0],
        apellido: profile.family_name || profile.name.split(' ').slice(1).join(' ') || 'Usuario',
        email: profile.email,
        password: 'google-oauth-' + profile.id,
        telefono: '0000000000',
        rol: 'cliente',
        googleId: profile.id,
        emailVerificado: true,
        activo: true,
        fechaRegistro: new Date(),
        ultimoAcceso: new Date()
      });

      await nuevoUsuario.hashPassword();
      const resultado = await db.collection('Usuarios').insertOne(nuevoUsuario.toDocument());
      usuarioDoc = nuevoUsuario.toDocument();
      
      console.log('✅ Nuevo usuario creado:', profile.email);
    } else {
      // Actualizar usuario existente
      await db.collection('Usuarios').updateOne(
        { _id: usuarioDoc._id },
        { 
          $set: { 
            googleId: profile.id,
            emailVerificado: true,
            ultimoAcceso: new Date()
          } 
        }
      );
      
      console.log('✅ Usuario existente actualizado:', profile.email);
    }

    // Generar JWT
    const token = jwt.sign(
      { 
        userId: usuarioDoc._id, 
        email: usuarioDoc.email, 
        rol: usuarioDoc.rol 
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const usuario = new Usuario(usuarioDoc);

    // Redirigir al frontend con el token
    const redirectUrl = `${FRONTEND_URL}/auth/google/success?token=${token}&user=${encodeURIComponent(JSON.stringify(usuario.toJSON()))}`;
    
    console.log('🔗 Redirigiendo a:', FRONTEND_URL);
    
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('❌ Error en Google OAuth:', error);
    res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
  }
});

module.exports = router;