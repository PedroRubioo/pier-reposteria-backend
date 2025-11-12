const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');

// ========================================
// RUTAS PÚBLICAS
// ========================================

// Registro de usuario
router.post('/register', authController.register);

// Verificar email
router.post('/verify-email', authController.verifyEmail);

// Reenviar código de verificación
router.post('/resend-verification', authController.resendVerificationCode);

// Iniciar sesión
router.post('/login', authController.login);

// Solicitar recuperación de contraseña
router.post('/request-password-reset', authController.requestPasswordReset);

// Restablecer contraseña
router.post('/reset-password', authController.resetPassword);

// ========================================
// RUTAS PROTEGIDAS (requieren autenticación)
// ========================================

// Obtener perfil del usuario
router.get('/profile', verifyToken, authController.getProfile);

module.exports = router;