const express = require('express');
const router = express.Router();
const passport = require('../config/passport');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'pierreposteria_secret_key_2025';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

console.log('🔐 Configuración Google OAuth:');
console.log('   FRONTEND_URL:', FRONTEND_URL);
console.log('   GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL);

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

module.exports = router;