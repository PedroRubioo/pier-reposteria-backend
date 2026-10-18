// routes/uploadRoutes.js — Subida y eliminación de imágenes con Cloudinary
const express = require('express');
const router = express.Router();
const { verifyToken, verifyRole } = require('../middleware/auth');

// ════════════════════════════════════════════
// CONFIGURACIÓN DE CLOUDINARY
// ════════════════════════════════════════════
// Requiere estas variables en .env:
//   CLOUDINARY_CLOUD_NAME=tu_cloud_name
//   CLOUDINARY_API_KEY=tu_api_key
//   CLOUDINARY_API_SECRET=tu_api_secret

let cloudinary;
let multer;
let streamifier;

try {
  cloudinary = require('cloudinary').v2;
  multer = require('multer');
  streamifier = require('streamifier');

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  console.log('☁️  Cloudinary configurado:', process.env.CLOUDINARY_CLOUD_NAME ? '✅' : '❌ Falta CLOUDINARY_CLOUD_NAME');
} catch (error) {
  console.warn('⚠️  Cloudinary no disponible. Instala: npm install cloudinary multer streamifier');
}

const MSG_TIPO_NO_PERMITIDO = 'Solo se permiten imágenes JPEG, PNG, WebP o GIF';

// Multer en memoria (no guarda archivos en disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB máximo
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const error = new Error(MSG_TIPO_NO_PERMITIDO);
      error.code = 'TIPO_NO_PERMITIDO';
      cb(error);
    }
  }
});

// upload.single con sus errores en JSON (Diseno_Panel_Cliente.md §5.12): sin
// esto, el archivo grande o de otro tipo terminaba en el 500 del servidor
function subirUna(campo) {
  const recibir = upload.single(campo);
  return (req, res, next) => recibir(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'La foto pesa más de 5 MB' });
    if (error.code === 'TIPO_NO_PERMITIDO') return res.status(400).json({ success: false, message: MSG_TIPO_NO_PERMITIDO });
    return next(error);
  });
}

// Lo que un cliente sube: su foto de perfil o la evidencia de un reembolso
const TIPOS_CLIENTE = ['perfil', 'reembolso'];

// ════════════════════════════════════════════
// HELPER: Subir buffer a Cloudinary
// ════════════════════════════════════════════
function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || 'pier-reposteria',
        transformation: options.transformation || [
          { width: 800, height: 800, crop: 'limit', quality: 'auto', format: 'webp' }
        ],
        ...options
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// ════════════════════════════════════════════
// SUBIR IMAGEN ÚNICA (productos, categorías, perfil)
// ════════════════════════════════════════════
router.post('/imagen', verifyToken, subirUna('imagen'), async (req, res) => {
  try {
    if (!cloudinary) {
      return res.status(503).json({ success: false, message: 'Cloudinary no está configurado' });
    }

    const { tipo } = req.body; // 'producto', 'categoria', 'perfil', 'reembolso', 'entrega'…
    if (req.user.rol === 'cliente' && !TIPOS_CLIENTE.includes(tipo)) {
      return res.status(400).json({ success: false, message: 'Tipo de imagen no válido' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se envió ninguna imagen' });
    }

    const folder = `pier-reposteria/${tipo || 'general'}`;

    const result = await uploadToCloudinary(req.file.buffer, { folder });

    res.json({
      success: true,
      imagen: {
        url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes
      }
    });
  } catch (error) {
    console.error('Error subiendo imagen:', error.message);
    if (error.message.includes('Solo se permiten')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: 'Error al subir imagen' });
  }
});

// ════════════════════════════════════════════
// SUBIR MÚLTIPLES IMÁGENES (galería de producto)
// ════════════════════════════════════════════
router.post('/imagenes', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general', 'repartidor'), upload.array('imagenes', 6), async (req, res) => {
  try {
    if (!cloudinary) {
      return res.status(503).json({ success: false, message: 'Cloudinary no está configurado' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No se enviaron imágenes' });
    }

    const { tipo } = req.body;
    const folder = `pier-reposteria/${tipo || 'productos'}`;

    const resultados = await Promise.all(
      req.files.map(file => uploadToCloudinary(file.buffer, { folder }))
    );

    // Formato JSONB compatible con campo imagenes de tblproductos: [{url, public_id}]
    const imagenes = resultados.map(r => ({
      url: r.secure_url,
      public_id: r.public_id
    }));

    res.json({ success: true, imagenes });
  } catch (error) {
    console.error('Error subiendo imágenes:', error.message);
    res.status(500).json({ success: false, message: 'Error al subir imágenes' });
  }
});

// ════════════════════════════════════════════
// ELIMINAR IMAGEN POR PUBLIC_ID
// ════════════════════════════════════════════
router.delete('/imagen', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    if (!cloudinary) {
      return res.status(503).json({ success: false, message: 'Cloudinary no está configurado' });
    }

    const { public_id } = req.body;

    if (!public_id) {
      return res.status(400).json({ success: false, message: 'public_id es requerido' });
    }

    // Verificar que pertenece a Pier (seguridad)
    if (!public_id.startsWith('pier-reposteria/')) {
      return res.status(403).json({ success: false, message: 'No se puede eliminar esta imagen' });
    }

    const result = await cloudinary.uploader.destroy(public_id);

    res.json({
      success: true,
      message: result.result === 'ok' ? 'Imagen eliminada' : 'Imagen no encontrada en Cloudinary',
      resultado: result.result
    });
  } catch (error) {
    console.error('Error eliminando imagen:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar imagen' });
  }
});

module.exports = router;