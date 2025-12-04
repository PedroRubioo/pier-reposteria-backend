const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');
const { 
  loginRateLimitMiddleware, 
  passwordResetRateLimitMiddleware 
} = require('../middleware/rateLimiting');

// ========================================
// RUTAS PÚBLICAS CON PROTECCIÓN
// ========================================

// 🔒 Registro de usuario (con sanitización automática del middleware global)
router.post('/register', authController.register);

// 🔒 Verificar email
router.post('/verify-email', authController.verifyEmail);

// 🔒 Reenviar código de verificación
router.post('/resend-verification', authController.resendVerificationCode);

// 🔒 Iniciar sesión (con rate limiting para prevenir fuerza bruta)
router.post('/login', loginRateLimitMiddleware, authController.login);

// 🔒 Solicitar recuperación de contraseña (con rate limiting: máx 3 por hora)
router.post(
  '/request-password-reset', 
  passwordResetRateLimitMiddleware, 
  authController.requestPasswordReset
);

// 🔒 Restablecer contraseña
router.post('/reset-password', authController.resetPassword);

// ========================================
// RUTAS PROTEGIDAS (requieren autenticación)
// ========================================

// 🔒 Obtener perfil del usuario
router.get('/profile', verifyToken, authController.getProfile);

// 🔒 Cerrar sesión (invalidar token)
router.post('/logout', verifyToken, authController.logout);

module.exports = router;