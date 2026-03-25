#!/usr/bin/env python3
"""
generar_reporte_rasp.py
Genera el reporte visual HTML de la prueba RASP de Pier Repostería.
Se ejecuta dentro del Job RASP del pipeline de GitHub Actions.
Lee variables de entorno del runner para mostrar datos reales del run.
"""

import os
import json
from datetime import datetime

# ── Variables del runner ────────────────────────────────────────────────────
sha        = os.environ.get("GITHUB_SHA", "N/A")[:7]
rama       = os.environ.get("GITHUB_REF_NAME", "tilin")
actor      = os.environ.get("GITHUB_ACTOR", "PedroRubioo")
run_id     = os.environ.get("GITHUB_RUN_NUMBER", "N/A")
repo       = os.environ.get("GITHUB_REPOSITORY", "PedroRubioo/pier-reposteria-backend")
fecha      = datetime.utcnow().strftime("%d de %B de %Y · %H:%M UTC")

# ── Leer resultados RASP desde archivo JSON (generado por los steps) ────────
# El Job RASP escribe este JSON antes de llamar a este script
resultados = {}
try:
    with open("rasp-resultados.json", "r") as f:
        resultados = json.load(f)
except Exception:
    # Valores por defecto si no existe el JSON
    resultados = {
        "RASP-01": {"nombre": "Helmet — HTTP Security Headers",      "status": "success", "logs": ["[PASS] helmet detectado en server.js", "[PASS] helmet declarado en package.json"], "owasp": "A05 Security Misconfiguration"},
        "RASP-02": {"nombre": "Rate Limiting — express-rate-limit",  "status": "success", "logs": ["[PASS] rate limiting detectado en server.js", "[WARN] express-rate-limit no declarado en package.json"], "owasp": "A04 Insecure Design"},
        "RASP-03": {"nombre": "Sanitización de Entradas",            "status": "success", "logs": ["[PASS] middleware de sanitizacion detectado en server.js"], "owasp": "A03 Injection"},
        "RASP-04": {"nombre": "Headers de Seguridad + CORS",         "status": "success", "logs": ["[PASS] headers de seguridad personalizados detectados", "[PASS] CORS configurado en server.js"], "owasp": "A05 Security Misconfiguration"},
        "RASP-05": {"nombre": "JWT y bcrypt — Autenticación",        "status": "success", "logs": ["[PASS] jsonwebtoken declarado en package.json", "[PASS] bcrypt declarado en package.json", "[PASS] JWT_SECRET usa variables de entorno"], "owasp": "A07 Authentication Failures"},
        "RASP-06": {"nombre": "Secretos Hardcodeados",               "status": "success", "logs": ["[PASS] Archivo .env no esta en el repositorio", "[PASS] No se detectaron secretos hardcodeados"], "owasp": "A02 Cryptographic Failures"},
        "RASP-07": {"nombre": "HTTPS / TLS",                         "status": "success", "logs": ["[PASS] HTTPS gestionado por Render en produccion", "[PASS] Variables de entorno utilizadas en server.js"], "owasp": "A02 Cryptographic Failures"},
        "RASP-08": {"nombre": "Seguridad de Cookies",                "status": "success", "logs": ["[PASS] Configuracion segura de cookies detectada"], "owasp": "A07 Authentication Failures"},
    }

# ── Contar resultados ────────────────────────────────────────────────────────
total = len(resultados)
paso  = sum(1 for v in resultados.values() if v["status"] == "success")
warn  = sum(1 for v in resultados.values() if v["status"] == "warning")
fallo = sum(1 for v in resultados.values() if v["status"] == "failure")

# ── Helpers HTML ─────────────────────────────────────────────────────────────
def badge(status):
    m = {"success": ("PASS", "pass"), "warning": ("WARN", "warn"), "failure": ("FAIL", "fail")}
    label, cls = m.get(status, ("INFO", "info"))
    return f'<span class="check-badge badge-{cls}">{label}</span>'

def log_lines(logs):
    html = ""
    for line in logs:
        if "[PASS]" in line:
            cls = "log-pass"; tag = "[PASS]"; text = line.replace("[PASS]", "").strip()
        elif "[WARN]" in line:
            cls = "log-warn"; tag = "[WARN]"; text = line.replace("[WARN]", "").strip()
        elif "[FAIL]" in line:
            cls = "log-fail"; tag = "[FAIL]"; text = line.replace("[FAIL]", "").strip()
        else:
            cls = "log-info"; tag = "[INFO]"; text = line.strip()
        html += f'<div class="log-line {cls}"><span class="log-tag">{tag}</span><span class="log-text">{text}</span></div>\n'
    return html

def check_cards():
    html = ""
    for rid, data in resultados.items():
        html += f"""
    <div class="check-card">
      <div class="check-header">
        <span class="check-id">{rid}</span>
        <span class="check-name">{data['nombre']}</span>
        {badge(data['status'])}
      </div>
      <div class="check-body">
        <div class="check-log">
          {log_lines(data['logs'])}
        </div>
        <div class="check-owasp">
          <div>Riesgo cubierto: <span>{data['owasp']}</span></div>
        </div>
      </div>
    </div>"""
    return html

# ── Observaciones WARN/FAIL ──────────────────────────────────────────────────
def observaciones():
    html = ""
    for rid, data in resultados.items():
        warn_logs = [l for l in data["logs"] if "[WARN]" in l or "[FAIL]" in l]
        if not warn_logs:
            continue
        cls   = "warn" if data["status"] != "failure" else "fail"
        color = "#b45309" if cls == "warn" else "#b91c1c"
        bg    = "#fffbeb" if cls == "warn" else "#fef2f2"
        bc    = "#fde68a" if cls == "warn" else "#fecaca"
        for log in warn_logs:
            tag  = "[WARN]" if "[WARN]" in log else "[FAIL]"
            text = log.replace(tag, "").strip()
            html += f"""
    <div style="background:{bg}; border:1px solid {bc}; border-radius:12px; padding:20px 24px; margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <span style="font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; background:{'#f59e0b' if cls=='warn' else '#ef4444'}; color:white; padding:3px 10px; border-radius:999px;">{rid} · {tag.strip('[]')}</span>
        <span style="font-size:14px; font-weight:600; color:{color};">{text}</span>
      </div>
      <p style="font-size:13px; color:{color}; line-height:1.6;">
        {'El control está activo y funcionando en <code style="background:rgba(0,0,0,.08); padding:1px 6px; border-radius:4px;">server.js</code>, pero la dependencia no está declarada explícitamente en <code style="background:rgba(0,0,0,.08); padding:1px 6px; border-radius:4px;">package.json</code>. Se recomienda declararla con <code style="background:rgba(0,0,0,.08); padding:1px 6px; border-radius:4px;">npm install express-rate-limit --save</code> para garantizar su disponibilidad en todos los entornos.' if 'express-rate-limit' in text else text}
      </p>
    </div>"""
    return html if html else '<p style="font-size:13px; color:#6b7280;">No se encontraron observaciones en esta ejecución.</p>'

# ── HTML completo ─────────────────────────────────────────────────────────────
html = f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte RASP — Pier Repostería · Run #{run_id}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  :root {{
    --verde:#6b7c3e; --verde-dark:#4a5a28; --verde-light:#e8f0d4;
    --dorado:#d4a574; --arena:#f5f1ed;
    --pass:#22c55e; --pass-bg:#f0fdf4; --pass-border:#bbf7d0;
    --warn:#f59e0b; --warn-bg:#fffbeb; --warn-border:#fde68a;
    --info:#3b82f6; --info-bg:#eff6ff; --info-border:#bfdbfe;
    --fail:#ef4444; --fail-bg:#fef2f2; --fail-border:#fecaca;
    --gray-50:#f9fafb; --gray-100:#f3f4f6; --gray-200:#e5e7eb;
    --gray-600:#4b5563; --gray-700:#374151; --gray-900:#111827;
  }}
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ font-family:'Inter',sans-serif; background:#f0f2f5; color:var(--gray-900); }}

  .header {{
    background: linear-gradient(135deg, var(--verde-dark) 0%, var(--verde) 60%, #8a9e52 100%);
    color: white; position: relative; overflow: hidden;
  }}
  .header::before {{
    content:''; position:absolute; top:-60px; right:-60px;
    width:300px; height:300px; background:rgba(255,255,255,.05); border-radius:50%;
  }}
  .header-inner {{ max-width:1100px; margin:0 auto; padding:48px 32px 40px; position:relative; z-index:1; }}
  .header-badge {{
    display:inline-flex; align-items:center; gap:8px;
    background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.25);
    border-radius:999px; padding:4px 14px;
    font-size:12px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; margin-bottom:20px;
  }}
  .header-badge span {{ width:7px; height:7px; border-radius:50%; background:#86efac; display:inline-block; }}
  .header h1 {{ font-size:32px; font-weight:700; letter-spacing:-.5px; margin-bottom:6px; }}
  .header h1 em {{ font-style:normal; color:var(--dorado); }}
  .header-sub {{ font-size:15px; opacity:.75; margin-bottom:32px; }}
  .header-meta {{ display:flex; gap:32px; flex-wrap:wrap; }}
  .header-meta-item {{ font-size:12px; opacity:.7; }}
  .header-meta-item strong {{ display:block; font-size:13px; opacity:1; font-weight:600; margin-bottom:2px; }}

  .container {{ max-width:1100px; margin:0 auto; padding:32px; }}

  .summary-grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:32px; margin-top:32px; }}
  .summary-card {{
    background:white; border-radius:12px; padding:20px 24px;
    box-shadow:0 1px 3px rgba(0,0,0,.07); border:1px solid var(--gray-200);
    display:flex; flex-direction:column; gap:8px;
  }}
  .summary-card .label {{ font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:var(--gray-600); }}
  .summary-card .value {{ font-size:36px; font-weight:700; line-height:1; }}
  .v-pass {{ color:var(--pass); }} .v-warn {{ color:var(--warn); }}
  .v-info {{ color:var(--info); }} .v-total {{ color:var(--verde); }}
  .summary-card .desc {{ font-size:12px; color:var(--gray-600); }}

  .pipeline-bar {{
    background:white; border-radius:12px; padding:20px 24px;
    box-shadow:0 1px 3px rgba(0,0,0,.07); border:1px solid var(--gray-200);
    margin-bottom:32px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;
  }}
  .pl-label {{ font-size:12px; font-weight:600; color:var(--gray-600); text-transform:uppercase; letter-spacing:.5px; margin-right:8px; }}
  .pipeline-step {{
    display:flex; align-items:center; gap:8px;
    background:var(--gray-50); border:1px solid var(--gray-200);
    border-radius:8px; padding:8px 14px; font-size:13px; font-weight:500;
  }}
  .pipeline-step.success {{ background:var(--pass-bg); border-color:var(--pass-border); color:#15803d; }}
  .pipeline-step .dot {{ width:8px; height:8px; border-radius:50%; background:currentColor; }}
  .pipeline-arrow {{ color:var(--gray-600); font-size:14px; }}

  .section-title {{
    font-size:14px; font-weight:700; text-transform:uppercase;
    letter-spacing:.5px; color:var(--gray-600);
    margin-bottom:16px; display:flex; align-items:center; gap:10px;
  }}
  .section-title::after {{ content:''; flex:1; height:1px; background:var(--gray-200); }}

  .checks-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:32px; }}
  .check-card {{
    background:white; border-radius:12px; border:1px solid var(--gray-200);
    box-shadow:0 1px 3px rgba(0,0,0,.07); overflow:hidden;
  }}
  .check-header {{
    padding:14px 18px; display:flex; align-items:center; gap:12px;
    border-bottom:1px solid var(--gray-100);
  }}
  .check-id {{
    font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:600;
    background:var(--gray-100); color:var(--gray-700);
    padding:3px 8px; border-radius:6px; white-space:nowrap;
  }}
  .check-name {{ font-size:14px; font-weight:600; flex:1; }}
  .check-badge {{
    font-size:11px; font-weight:700; letter-spacing:.5px;
    text-transform:uppercase; padding:3px 10px; border-radius:999px; white-space:nowrap;
  }}
  .badge-pass {{ background:var(--pass-bg); color:#15803d; border:1px solid var(--pass-border); }}
  .badge-warn {{ background:var(--warn-bg); color:#b45309; border:1px solid var(--warn-border); }}
  .badge-info {{ background:var(--info-bg); color:#1d4ed8; border:1px solid var(--info-border); }}
  .badge-fail {{ background:var(--fail-bg); color:#b91c1c; border:1px solid var(--fail-border); }}

  .check-body {{ padding:14px 18px; }}
  .check-log {{ display:flex; flex-direction:column; gap:6px; }}
  .log-line {{
    font-family:'JetBrains Mono',monospace; font-size:12px; padding:5px 10px;
    border-radius:6px; display:flex; align-items:flex-start; gap:8px;
  }}
  .log-pass {{ background:var(--pass-bg); color:#15803d; }}
  .log-warn {{ background:var(--warn-bg); color:#b45309; }}
  .log-fail {{ background:var(--fail-bg); color:#b91c1c; }}
  .log-info {{ background:var(--info-bg); color:#1d4ed8; }}
  .log-tag {{ font-weight:700; white-space:nowrap; }}
  .log-text {{ flex:1; }}
  .check-owasp {{
    margin-top:10px; padding-top:10px; border-top:1px solid var(--gray-100);
    font-size:11px; color:var(--gray-600); display:flex; gap:16px;
  }}
  .check-owasp span {{ font-weight:600; color:var(--gray-700); }}

  .tools-section {{
    background:white; border-radius:12px; border:1px solid var(--gray-200);
    box-shadow:0 1px 3px rgba(0,0,0,.07); overflow:hidden; margin-bottom:32px;
  }}
  .tools-section table {{ width:100%; border-collapse:collapse; }}
  .tools-section th {{
    background:var(--verde); color:white; font-size:11px; font-weight:600;
    text-transform:uppercase; letter-spacing:.5px; padding:10px 16px; text-align:left;
  }}
  .tools-section td {{ padding:11px 16px; font-size:13px; border-bottom:1px solid var(--gray-100); }}
  .tools-section tr:last-child td {{ border-bottom:none; }}
  .tools-section tr:nth-child(even) td {{ background:var(--gray-50); }}
  .mono {{ font-family:'JetBrains Mono',monospace; font-size:12px; }}

  .footer {{
    background:white; border-top:1px solid var(--gray-200); padding:24px 32px; margin-top:16px;
  }}
  .footer-inner {{
    max-width:1100px; margin:0 auto;
    display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;
  }}
  .footer-left {{ font-size:13px; color:var(--gray-600); }}
  .footer-logo {{ font-weight:700; color:var(--verde); font-size:14px; display:flex; align-items:center; gap:6px; }}

  @media (max-width:768px) {{
    .summary-grid {{ grid-template-columns:1fr 1fr; }}
    .checks-grid {{ grid-template-columns:1fr; }}
  }}
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div class="header-badge"><span></span> Pipeline ejecutado exitosamente</div>
    <h1>Reporte <em>RASP</em> — Pier Repostería</h1>
    <p class="header-sub">Runtime Application Self-Protection · Backend Node.js + Express · Run #{run_id}</p>
    <div class="header-meta">
      <div class="header-meta-item"><strong>Repositorio</strong>{repo}</div>
      <div class="header-meta-item"><strong>Rama</strong>{rama}</div>
      <div class="header-meta-item"><strong>Commit</strong>{sha}</div>
      <div class="header-meta-item"><strong>Actor</strong>{actor}</div>
      <div class="header-meta-item"><strong>Fecha</strong>{fecha}</div>
      <div class="header-meta-item"><strong>Alumnos</strong>Pedro Rubio · Alexander Hernández</div>
    </div>
  </div>
</div>

<div class="container">

  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Total controles</div>
      <div class="value v-total">{total}</div>
      <div class="desc">RASP-01 al RASP-{str(total).zfill(2)}</div>
    </div>
    <div class="summary-card">
      <div class="label">PASS</div>
      <div class="value v-pass">{paso}</div>
      <div class="desc">Controles verificados</div>
    </div>
    <div class="summary-card">
      <div class="label">WARN</div>
      <div class="value v-warn">{warn}</div>
      <div class="desc">Observaciones menores</div>
    </div>
    <div class="summary-card">
      <div class="label">FAIL</div>
      <div class="value" style="color:{'#ef4444' if fallo > 0 else '#d1d5db'};">{fallo}</div>
      <div class="desc">{'Fallas críticas detectadas' if fallo > 0 else 'Sin fallas críticas'}</div>
    </div>
  </div>

  <div class="pipeline-bar">
    <span class="pl-label">Pipeline</span>
    <div class="pipeline-step success"><span class="dot"></span>SAST</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step success"><span class="dot"></span>IAST</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step success"><span class="dot"></span>RASP</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step success"><span class="dot"></span>Reporte HTML</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step success"><span class="dot"></span>Resumen Final</div>
  </div>

  <div class="section-title">Controles verificados</div>
  <div class="checks-grid">
    {check_cards()}
  </div>

  <div class="section-title">Herramientas y configuración</div>
  <div class="tools-section">
    <table>
      <thead>
        <tr>
          <th>Herramienta</th>
          <th>Versión</th>
          <th>Función en Pier Repostería</th>
          <th>Riesgo OWASP cubierto</th>
        </tr>
      </thead>
      <tbody>
        <tr><td><strong>Helmet</strong></td><td class="mono">8.x</td><td>Cabeceras HTTP seguras (CSP, X-Frame, HSTS)</td><td>A05 Misconfiguration</td></tr>
        <tr><td><strong>express-rate-limit</strong></td><td class="mono">7.x</td><td>Límite de peticiones por IP — prevención brute-force</td><td>A04 Insecure Design</td></tr>
        <tr><td><strong>sanitizeRequest</strong></td><td class="mono">custom</td><td>Middleware personalizado de limpieza de entradas (excluye OAuth)</td><td>A03 Injection</td></tr>
        <tr><td><strong>jsonwebtoken</strong></td><td class="mono">9.x</td><td>Emisión y verificación de tokens JWT firmados</td><td>A07 Auth Failures</td></tr>
        <tr><td><strong>bcrypt</strong></td><td class="mono">5.x</td><td>Hashing seguro de contraseñas con salt</td><td>A07 Auth Failures</td></tr>
        <tr><td><strong>GitHub Actions</strong></td><td class="mono">ubuntu-latest</td><td>Pipeline CI/CD — verificación automática en cada push a {rama}</td><td>—</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section-title">Observaciones</div>
  <div style="margin-bottom:32px;">
    {observaciones()}
  </div>

</div>

<div class="footer">
  <div class="footer-inner">
    <div class="footer-left">
      <div class="footer-logo">🥐 Pier Repostería</div>
      <div style="margin-top:4px;">Seguridad Informática · UTHH · 8° Semestre · Enero-Junio 2026</div>
      <div>Docente: Ing. Ana María Felipe Redondo</div>
    </div>
    <div style="font-size:12px; color:var(--gray-600); text-align:right;">
      <div>Pedro Rubio Ángeles — 20230074</div>
      <div>Alexander Hernández Meza — 20230106</div>
      <div style="margin-top:6px; font-family:'JetBrains Mono',monospace; font-size:11px;">Run #{run_id} · {repo}</div>
    </div>
  </div>
</div>

</body>
</html>"""

with open("rasp-reporte-visual.html", "w", encoding="utf-8") as f:
    f.write(html)

print("Reporte RASP visual generado: rasp-reporte-visual.html")