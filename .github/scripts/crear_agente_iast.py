"""
Crea iast-agent.js en la raiz del proyecto.
Se usa desde el pipeline para evitar problemas de indentacion en heredocs YAML.
"""

agente = """// Cargar variables de entorno PRIMERO antes que cualquier import
require('dotenv').config();

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');

const sdk = new NodeSDK({
  serviceName: 'pier-reposteria-iast',
  traceExporter: new ConsoleSpanExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-http': { enabled: true },
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-pg': { enabled: true },
    })
  ]
});

sdk.start();
console.log('[IAST] OpenTelemetry activo');
console.log('[IAST] Monitoreando: HTTP + Express + PostgreSQL');
process.on('SIGTERM', () => sdk.shutdown());
"""

with open('iast-agent.js', 'w') as f:
    f.write(agente)

print('iast-agent.js creado correctamente')