-- =====================================================================
-- MIGRACIÓN 003: Política real de envío
--   - Envío GRATIS dentro de la ciudad de Huejutla de Reyes
--   - Envío con costo a localidades cercanas (~10 min)
-- Colonias de la ciudad tomadas del catálogo SEPOMEX (CP 43000).
-- El catálogo completo se administra desde Dirección → Zonas de Envío;
-- esta semilla es el punto de partida y la tarifa de alrededores ($30)
-- es editable desde esa pantalla.
-- Reemplaza la semilla de la migración 001.
-- =====================================================================

BEGIN;

DELETE FROM core.tblzonas_colonias;
DELETE FROM core.tblzonas_envio;

INSERT INTO core.tblzonas_envio (nombre, tarifa) VALUES
  ('Huejutla - Ciudad (envío gratis)', 0.00),
  ('Alrededores (hasta 10 min)', 30.00);

INSERT INTO core.tblzonas_colonias (zona_id, colonia)
SELECT z.id, c.colonia
FROM (VALUES
  -- ── Ciudad (SEPOMEX CP 43000) ──
  ('Huejutla - Ciudad (envío gratis)', 'Centro'),
  ('Huejutla - Ciudad (envío gratis)', 'Huejutla de Reyes Centro'),
  ('Huejutla - Ciudad (envío gratis)', 'Bella Airosa'),
  ('Huejutla - Ciudad (envío gratis)', 'Asociación Civil'),
  ('Huejutla - Ciudad (envío gratis)', 'Netzahualcóyotl'),
  ('Huejutla - Ciudad (envío gratis)', 'Aviación Civil'),
  ('Huejutla - Ciudad (envío gratis)', 'El Campamento'),
  ('Huejutla - Ciudad (envío gratis)', 'Cerecedo Estrada'),
  ('Huejutla - Ciudad (envío gratis)', '5 de Mayo'),
  ('Huejutla - Ciudad (envío gratis)', 'Colalambre'),
  ('Huejutla - Ciudad (envío gratis)', 'Cruz Verde'),
  ('Huejutla - Ciudad (envío gratis)', 'Chacatitla'),
  ('Huejutla - Ciudad (envío gratis)', 'El Zapote'),
  ('Huejutla - Ciudad (envío gratis)', 'Flavio Crespo'),
  ('Huejutla - Ciudad (envío gratis)', 'FOVISSSTE'),
  ('Huejutla - Ciudad (envío gratis)', 'Jacarandas'),
  ('Huejutla - Ciudad (envío gratis)', 'Jericó'),
  ('Huejutla - Ciudad (envío gratis)', 'Juárez'),
  ('Huejutla - Ciudad (envío gratis)', 'La Lomita'),
  ('Huejutla - Ciudad (envío gratis)', 'Las Américas'),
  ('Huejutla - Ciudad (envío gratis)', 'Rojo Lugo'),
  ('Huejutla - Ciudad (envío gratis)', 'Marcelo Vite'),
  ('Huejutla - Ciudad (envío gratis)', 'Miguel Hidalgo'),
  ('Huejutla - Ciudad (envío gratis)', 'Olímpica'),
  ('Huejutla - Ciudad (envío gratis)', '1ro. de Mayo'),
  ('Huejutla - Ciudad (envío gratis)', 'Santa Elena'),
  ('Huejutla - Ciudad (envío gratis)', 'Santa Fe'),
  ('Huejutla - Ciudad (envío gratis)', 'Santa Irene'),
  ('Huejutla - Ciudad (envío gratis)', 'Tahuizán'),
  ('Huejutla - Ciudad (envío gratis)', 'Nueva Tenochtitlán'),
  ('Huejutla - Ciudad (envío gratis)', 'Valle del Encinal'),
  ('Huejutla - Ciudad (envío gratis)', 'Villa de Guadalupe'),
  ('Huejutla - Ciudad (envío gratis)', 'Loma Bonita'),
  ('Huejutla - Ciudad (envío gratis)', 'San José'),
  ('Huejutla - Ciudad (envío gratis)', 'Electricistas'),
  ('Huejutla - Ciudad (envío gratis)', 'Obrera'),
  ('Huejutla - Ciudad (envío gratis)', 'Carlos Fayad'),
  ('Huejutla - Ciudad (envío gratis)', 'Huasteco'),
  ('Huejutla - Ciudad (envío gratis)', 'Unidad Militar'),
  ('Huejutla - Ciudad (envío gratis)', 'Nuevo México'),
  ('Huejutla - Ciudad (envío gratis)', 'Carlos Salinas de Gortari'),
  ('Huejutla - Ciudad (envío gratis)', 'Del Carmen'),
  ('Huejutla - Ciudad (envío gratis)', 'Los Prados'),
  ('Huejutla - Ciudad (envío gratis)', 'Bugambilias'),
  ('Huejutla - Ciudad (envío gratis)', 'Tepeyac'),
  ('Huejutla - Ciudad (envío gratis)', 'El Mirador'),
  ('Huejutla - Ciudad (envío gratis)', 'Magisterial'),
  ('Huejutla - Ciudad (envío gratis)', 'Las Chacas'),
  ('Huejutla - Ciudad (envío gratis)', 'El Seminario'),
  ('Huejutla - Ciudad (envío gratis)', 'Adolfo López Mateos'),
  ('Huejutla - Ciudad (envío gratis)', 'Horacio Camargo'),
  ('Huejutla - Ciudad (envío gratis)', 'Capitán Antonio Reyes'),
  ('Huejutla - Ciudad (envío gratis)', 'Los Frailes'),
  ('Huejutla - Ciudad (envío gratis)', 'Parque de Poblamiento'),
  ('Huejutla - Ciudad (envío gratis)', 'CAPTE'),
  ('Huejutla - Ciudad (envío gratis)', 'Los Fresnos'),
  -- ── Localidades cercanas (~10 min, con costo) ──
  ('Alrededores (hasta 10 min)', 'Chalahuiyapa'),
  ('Alrededores (hasta 10 min)', 'Ixcatlán'),
  ('Alrededores (hasta 10 min)', 'Macuxtepetla'),
  ('Alrededores (hasta 10 min)', 'Chililico'),
  ('Alrededores (hasta 10 min)', 'Santa Cruz')
) AS c(zona_nombre, colonia)
JOIN core.tblzonas_envio z ON z.nombre = c.zona_nombre;

COMMIT;

-- =====================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =====================================================================
-- SELECT z.nombre, z.tarifa, COUNT(c.id) AS colonias
--   FROM core.tblzonas_envio z LEFT JOIN core.tblzonas_colonias c ON c.zona_id = z.id
--  GROUP BY z.id ORDER BY z.tarifa;
