const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyToken, verifyRole } = require('../middleware/auth');

const GITHUB_REPO = 'PedroRubioo/pier-reposteria';

function getGitHubHeaders() {
  return {
    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };
}

// Listar backups
router.get('/list', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts`,
      { headers: getGitHubHeaders() }
    );

    const backups = response.data.artifacts
      .filter(a => a.name.startsWith('neon-backup'))
      .map(a => ({
        id: a.id,
        nombre: a.name,
        creado: new Date(a.created_at).toLocaleString('es-MX', {
          timeZone: 'America/Mexico_City',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        tamaño: (a.size_in_bytes / 1024).toFixed(2) + ' KB',
        url: a.archive_download_url
      }));

    res.json({ success: true, backups });
  } catch (error) {
    console.error('Error en /list:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener backups' });
  }
});

// Descargar backup
router.get('/download/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios({
      method: 'get',
      url: `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts/${id}/zip`,
      headers: getGitHubHeaders(),
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=backup-${id}.zip`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error en /download:', error.message);
    res.status(500).json({ success: false, message: 'Error al descargar' });
  }
});

// Eliminar backup
router.delete('/delete/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { id } = req.params;
    await axios.delete(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts/${id}`,
      { headers: getGitHubHeaders() }
    );

    res.json({ success: true, message: 'Backup eliminado correctamente' });
  } catch (error) {
    console.error('Error en /delete:', error.message);
    if (error.response?.status === 404) {
      res.status(404).json({ success: false, message: 'Backup no encontrado' });
    } else {
      res.status(500).json({ success: false, message: 'Error al eliminar backup' });
    }
  }
});

module.exports = router;