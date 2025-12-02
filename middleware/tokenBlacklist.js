// middleware/tokenBlacklist.js

/**
 * 🔒 TOKEN BLACKLIST - Sistema para invalidar tokens JWT
 * 
 * Cuando un usuario hace logout, el token se agrega a la blacklist
 * y no puede ser usado nuevamente hasta que expire naturalmente.
 */

class TokenBlacklist {
  constructor() {
    this.blacklistedTokens = new Map(); // token -> expirationTime
  }

  /**
   * Agregar token a la blacklist
   */
  add(token, expiresAt) {
    this.blacklistedTokens.set(token, expiresAt);
  }

  /**
   * Verificar si un token está en la blacklist
   */
  isBlacklisted(token) {
    const expiresAt = this.blacklistedTokens.get(token);
    
    if (!expiresAt) {
      return false;
    }

    // Si el token ya expiró naturalmente, eliminarlo de la blacklist
    const now = Date.now();
    if (now > expiresAt) {
      this.blacklistedTokens.delete(token);
      return false;
    }

    return true;
  }

  /**
   * Limpiar tokens expirados de la blacklist
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, expiresAt] of this.blacklistedTokens.entries()) {
      if (now > expiresAt) {
        this.blacklistedTokens.delete(token);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🗑️  Limpiados ${cleaned} tokens expirados de la blacklist`);
    }
  }

  /**
   * Obtener tamaño de la blacklist
   */
  size() {
    return this.blacklistedTokens.size;
  }

  /**
   * Limpiar toda la blacklist (solo para testing)
   */
  clear() {
    this.blacklistedTokens.clear();
  }
}

// Instancia global
const tokenBlacklist = new TokenBlacklist();

// Limpiar tokens expirados cada 30 minutos
setInterval(() => {
  tokenBlacklist.cleanup();
}, 30 * 60 * 1000);

/**
 * Middleware para verificar si el token está en la blacklist
 * Debe usarse DESPUÉS de verifyToken
 */
function checkBlacklist(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return next();
  }

  const token = authHeader.split(' ')[1];

  if (tokenBlacklist.isBlacklisted(token)) {
    return res.status(401).json({
      success: false,
      message: 'Token inválido. Por favor inicia sesión nuevamente.'
    });
  }

  next();
}

module.exports = {
  tokenBlacklist,
  checkBlacklist
};