// services/notificacionHelper.js — Servicio centralizado de notificaciones
const { pool } = require('../config/database');

// ══════════════════════════════════════════════
// CREAR NOTIFICACIÓN EN PLATAFORMA
// ══════════════════════════════════════════════
async function crearNotificacion({ usuario_id, tipo, titulo, mensaje }) {
  try {
    await pool.query(
      'INSERT INTO core.tblnotificaciones (usuario_id, tipo, titulo, mensaje, leida, created_at) VALUES ($1,$2,$3,$4,false,NOW())',
      [usuario_id, tipo, titulo, mensaje]
    );
  } catch (error) {
    console.error('Error creando notificación:', error.message);
  }
}

// ══════════════════════════════════════════════
// CREAR NOTIFICACIÓN MASIVA (para todos los clientes activos)
// ══════════════════════════════════════════════
async function crearNotificacionMasiva({ tipo, titulo, mensaje, enviado_por }) {
  try {
    const usuarios = await pool.query(
      "SELECT id FROM core.tblusuarios WHERE activo = true AND rol = 'cliente'"
    );
    for (const u of usuarios.rows) {
      await pool.query(
        'INSERT INTO core.tblnotificaciones (usuario_id, tipo, titulo, mensaje, leida, created_at) VALUES ($1,$2,$3,$4,false,NOW())',
        [u.id, tipo, titulo, mensaje]
      );
    }

    // Registrar envío masivo
    if (enviado_por) {
      await pool.query(
        `INSERT INTO core.tblnotificaciones_envios (enviado_por, tipo, titulo, mensaje, audiencia, total_enviados, estado, created_at)
         VALUES ($1,$2,$3,$4,'clientes',$5,'enviada',NOW())`,
        [enviado_por, tipo, titulo, mensaje, usuarios.rows.length]
      );
    }

    return usuarios.rows.length;
  } catch (error) {
    console.error('Error creando notificación masiva:', error.message);
    return 0;
  }
}

// ══════════════════════════════════════════════
// ENVIAR EMAIL POR BREVO (para notificaciones importantes)
// ══════════════════════════════════════════════
async function enviarEmailNotificacion({ email, nombre, asunto, contenido }) {
  try {
    // Verificar que Brevo esté configurado
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
      console.log('⚠️ Brevo no configurado, email no enviado');
      return;
    }

    const SibApiV3Sdk = require('sib-api-v3-sdk');
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = process.env.BREVO_API_KEY;

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.sender = { name: 'Pier Repostería', email: process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ email, name: nombre || '' }];
    sendSmtpEmail.subject = asunto;
    sendSmtpEmail.htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #2D1B4E 0%, #1A1025 100%); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .header p { margin: 8px 0 0; font-size: 14px; color: #d4a574; }
          .content { padding: 30px; background-color: #ffffff; }
          .content h2 { color: #2D1B4E; font-size: 20px; margin-top: 0; }
          .content p { color: #555; font-size: 15px; }
          .highlight-box { background: #f5f1ed; border-left: 4px solid #d4a574; padding: 15px 20px; border-radius: 4px; margin: 20px 0; }
          .btn { display: inline-block; background: #6b7c3e; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 15px 0; }
          .footer { text-align: center; padding: 20px; background-color: #f8f9fa; color: #6c757d; font-size: 12px; border-top: 1px solid #dee2e6; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Pier Repostería</h1>
            <p>Repostería artesanal • Huejutla de Reyes</p>
          </div>
          <div class="content">
            ${contenido}
          </div>
          <div class="footer">
            <p>Pier Repostería — Huejutla de Reyes, Hidalgo</p>
            <p>Este correo fue enviado automáticamente. No responder a este email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`📧 Email enviado a ${email}: ${asunto}`);
  } catch (error) {
    console.error('Error enviando email:', error.message);
  }
}

// ══════════════════════════════════════════════
// NOTIFICACIÓN + EMAIL COMBINADA (para las importantes)
// ══════════════════════════════════════════════
async function notificarConEmail({ usuario_id, tipo, titulo, mensaje, email, nombre, asunto, contenidoHtml }) {
  // 1. Crear notificación en plataforma
  await crearNotificacion({ usuario_id, tipo, titulo, mensaje });

  // 2. Enviar email si se proporcionó
  if (email) {
    await enviarEmailNotificacion({
      email,
      nombre,
      asunto: asunto || `🍰 ${titulo}`,
      contenido: contenidoHtml || `<h2>${titulo}</h2><p>${mensaje}</p>`
    });
  }
}

module.exports = {
  crearNotificacion,
  crearNotificacionMasiva,
  enviarEmailNotificacion,
  notificarConEmail
};