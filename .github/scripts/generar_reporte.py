import json
import os
from datetime import datetime

fecha = datetime.now().strftime('%d/%m/%Y %H:%M:%S UTC')
commit = os.environ.get('GITHUB_SHA', 'N/A')[:7]
branch = os.environ.get('GITHUB_REF_NAME', 'N/A')
actor = os.environ.get('GITHUB_ACTOR', 'N/A')

# ---------- Semgrep ----------
semgrep_results = []
semgrep_scanned = 0
try:
    with open('sast-semgrep-results.json') as f:
        data = json.load(f)
    semgrep_results = data.get('results', [])
    semgrep_scanned = len(data.get('paths', {}).get('scanned', []))
except Exception:
    pass

# ---------- ESLint ----------
eslint_rows_html = ''
eslint_errors = 0
eslint_warnings = 0
try:
    with open('sast-eslint-results.json') as f:
        eslint_data = json.load(f)
    items = []
    for file_result in eslint_data:
        for msg in file_result.get('messages', []):
            sev_str = 'ERROR' if msg.get('severity') == 2 else 'WARNING'
            sev_class = 'sev-error' if msg.get('severity') == 2 else 'sev-warning'
            if msg.get('severity') == 2:
                eslint_errors += 1
            else:
                eslint_warnings += 1
            fp = file_result.get('filePath', '').replace(
                '/home/runner/work/pier-reposteria-backend/pier-reposteria-backend/', ''
            )
            rule = msg.get('ruleId', '')
            message = msg.get('message', '')[:80]
            line = msg.get('line', 0)
            items.append(
                f'<tr>'
                f'<td><span class="sev-tag {sev_class}">{sev_str}</span></td>'
                f'<td><code>{fp}</code></td>'
                f'<td>{line}</td>'
                f'<td><code>{rule}</code></td>'
                f'<td>{message}</td>'
                f'</tr>'
            )
    eslint_rows_html = (
        ''.join(items) if items
        else '<tr><td colspan="5" class="empty-row">Sin problemas detectados</td></tr>'
    )
except Exception:
    eslint_rows_html = '<tr><td colspan="5" class="empty-row">Sin problemas detectados</td></tr>'

# ---------- npm audit ----------
npm_vulns = {'critical': 0, 'high': 0, 'moderate': 0, 'low': 0, 'total': 0}
npm_deps_total = 0
npm_detail_html = ''
npm_data_vulns = {}
try:
    with open('sast-npm-audit.json') as f:
        npm_data = json.load(f)
    meta = npm_data.get('metadata', {})
    v = meta.get('vulnerabilities', {})
    npm_vulns = {
        'critical': v.get('critical', 0),
        'high':     v.get('high', 0),
        'moderate': v.get('moderate', 0),
        'low':      v.get('low', 0),
        'total':    v.get('total', 0),
    }
    npm_deps_total = meta.get('dependencies', {}).get('total', 0)
    npm_data_vulns = npm_data.get('vulnerabilities', {})

    for pkg_name, pkg_data in npm_data_vulns.items():
        sev = pkg_data.get('severity', '')
        sev_class = (
            'critica' if sev == 'critical' else
            'alta' if sev == 'high' else
            'moderada' if sev == 'moderate' else
            'baja'
        )
        sev_label = sev.upper()
        fix_avail = pkg_data.get('fixAvailable', False)
        fix_badge = (
            '<span class="fix-badge fix-yes">Fix disponible</span>'
            if fix_avail
            else '<span class="fix-badge fix-no">Sin fix</span>'
        )
        pkg_range = pkg_data.get('range', 'N/A')
        is_direct = 'Directa' if pkg_data.get('isDirect') else 'Indirecta'

        advisories_html = ''
        for v_item in pkg_data.get('via', []):
            if isinstance(v_item, dict):
                title = v_item.get('title', 'Sin titulo')
                url = v_item.get('url', '#')
                cwe_list = v_item.get('cwe', [])
                cvss_score = v_item.get('cvss', {}).get('score', 0)
                ghsa_id = url.split('/')[-1] if url != '#' else 'N/A'
                cwe_tags = ''.join(
                    [f'<span class="cwe-tag">{c}</span>' for c in cwe_list]
                )
                cvss_info = (
                    f'<span class="cvss-tag">CVSS {cvss_score}</span>'
                    if cvss_score
                    else '<span class="cvss-tag">CVSS N/D</span>'
                )
                link_tag = (
                    f'<a class="advisory-link" href="{url}" target="_blank">'
                    f'{ghsa_id} &rarr;</a>'
                    if url != '#' else ''
                )
                advisories_html += (
                    f'<div class="advisory-item">'
                    f'<div class="advisory-title">{title}</div>'
                    f'<div class="advisory-details">{cwe_tags}{cvss_info}{link_tag}</div>'
                    f'</div>'
                )
            elif isinstance(v_item, str):
                advisories_html += (
                    f'<div class="advisory-item">'
                    f'<div class="advisory-title">Hereda de <code>{v_item}</code></div>'
                    f'<div class="advisory-details">'
                    f'<span class="cwe-tag">Herencia transitiva</span>'
                    f'</div></div>'
                )

        if not advisories_html:
            advisories_html = (
                '<div class="advisory-item">'
                '<div class="advisory-title">Ver dependencia padre</div>'
                '</div>'
            )

        npm_detail_html += (
            f'<div class="npm-vuln-card {sev_class}">'
            f'<div class="npm-vuln-header">'
            f'<div>'
            f'<div class="npm-pkg-name">{pkg_name}</div>'
            f'<div class="npm-pkg-range">Rango: {pkg_range} &bull; {is_direct}</div>'
            f'</div>'
            f'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            f'<span class="sev-tag sev-{sev_class}">{sev_label}</span>'
            f'{fix_badge}'
            f'</div>'
            f'</div>'
            f'<div class="npm-advisories">{advisories_html}</div>'
            f'</div>'
        )
except Exception:
    pass

# ---------- Semgrep rows ----------
if semgrep_results:
    rows = []
    for r in semgrep_results:
        sev = r['extra']['severity']
        sev_class = 'sev-error' if sev in ('ERROR', 'CRITICAL') else 'sev-warning'
        path = r['path'].replace(
            '/home/runner/work/pier-reposteria-backend/pier-reposteria-backend/', ''
        )
        line = r['start']['line']
        rule = r['check_id'].split('.')[-1]
        msg = r['extra']['message'][:100]
        rows.append(
            f'<tr>'
            f'<td><span class="sev-tag {sev_class}">{sev}</span></td>'
            f'<td><code>{path}</code></td>'
            f'<td>{line}</td>'
            f'<td><code>{rule}</code></td>'
            f'<td>{msg}</td>'
            f'</tr>'
        )
    semgrep_rows_html = ''.join(rows)
else:
    semgrep_rows_html = (
        '<tr><td colspan="5" class="empty-row">'
        'Sin vulnerabilidades detectadas en el codigo fuente'
        '</td></tr>'
    )

# ---------- Estado ----------
total_critico = (
    npm_vulns['critical'] + npm_vulns['high']
    + eslint_errors + len(semgrep_results)
)
estado = 'REQUIERE ATENCION' if total_critico > 0 else 'SEGURO'
estado_class = 'status-atencion' if total_critico > 0 else 'status-ok'
estado_icon = 'WARNING' if total_critico > 0 else 'OK'


def card_class(n, level='critica'):
    return level if n > 0 else 'verde'


npm_count_badge = (
    f"{npm_vulns['total']} vulnerabilidades en {len(npm_data_vulns)} paquetes"
    if npm_vulns['total'] > 0
    else "Sin vulnerabilidades"
)
npm_section_content = (
    npm_detail_html if npm_detail_html
    else '<div class="empty-row">Sin vulnerabilidades en dependencias</div>'
)

# ---------- HTML ----------
HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte SAST Backend - Pier Reposteria</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --verde:#6b7c3e;--dorado:#d4a574;--bg:#0d0f0a;--bg2:#13160e;--bg3:#1a1e12;
  --border:rgba(107,124,62,0.25);--text:#e8e4df;--text2:#9a9488;
  --critica:#e74c3c;--alta:#e67e22;--moderada:#f1c40f;--baja:#27ae60;--info:#3498db;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Syne',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(ellipse 80% 50% at 10% 20%,rgba(107,124,62,0.08) 0%,transparent 60%),
             radial-gradient(ellipse 60% 40% at 90% 80%,rgba(212,165,116,0.06) 0%,transparent 60%);}
.wrapper{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 24px 60px;}
header{padding:48px 0 36px;border-bottom:1px solid var(--border);margin-bottom:40px;
  display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;}
.logo-badge{display:inline-flex;align-items:center;gap:10px;background:rgba(107,124,62,0.15);
  border:1px solid rgba(107,124,62,0.3);padding:6px 14px 6px 10px;border-radius:100px;
  font-size:12px;font-family:'JetBrains Mono',monospace;color:#a8bc6a;margin-bottom:16px;}
.logo-dot{width:8px;height:8px;border-radius:50%;background:#6b7c3e;animation:pulse 2s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)}}
h1{font-size:clamp(28px,4vw,42px);font-weight:800;line-height:1.1;letter-spacing:-0.02em;color:#fff;}
h1 span{color:var(--dorado);}
.subtitle{color:var(--text2);font-size:14px;margin-top:10px;line-height:1.6;}
.meta-chips{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
.chip{font-family:'JetBrains Mono',monospace;font-size:11px;padding:4px 10px;border-radius:6px;
  border:1px solid var(--border);color:var(--text2);background:var(--bg3);}
.status-badge{display:flex;flex-direction:column;align-items:flex-end;gap:8px;}
.status-pill{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;
  padding:10px 20px;border-radius:100px;letter-spacing:0.05em;}
.status-atencion{background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.4);color:#e74c3c;}
.status-ok{background:rgba(39,174,96,0.15);border:1px solid rgba(39,174,96,0.4);color:#27ae60;}
.cards-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:40px;}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:20px;
  position:relative;overflow:hidden;transition:transform 0.2s;}
.card:hover{transform:translateY(-2px);}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
.card.verde::before{background:var(--baja);}
.card.alta::before{background:var(--alta);}
.card.moderada::before{background:var(--moderada);}
.card.critica::before{background:var(--critica);}
.card.azul::before{background:var(--info);}
.card.naranja::before{background:var(--alta);}
.card .icon{font-size:20px;margin-bottom:10px;}
.card .num{font-size:36px;font-weight:800;line-height:1;margin-bottom:4px;font-family:'JetBrains Mono',monospace;}
.card.verde .num{color:var(--baja);}
.card.alta .num{color:var(--alta);}
.card.moderada .num{color:var(--moderada);}
.card.critica .num{color:var(--critica);}
.card.azul .num{color:var(--info);}
.card.naranja .num{color:var(--alta);}
.card .lbl{font-size:11px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;}
.section{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:24px;}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;
  padding-bottom:16px;border-bottom:1px solid var(--border);}
.section-title{font-size:16px;font-weight:700;display:flex;align-items:center;gap:10px;color:#fff;}
.count-badge{font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 10px;border-radius:100px;
  background:var(--bg3);border:1px solid var(--border);color:var(--text2);}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.info-item{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}
.info-key{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text2);
  margin-bottom:5px;font-family:'JetBrains Mono',monospace;}
.info-val{font-size:14px;font-weight:600;color:var(--text);}
.table-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border);}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{background:var(--bg3);padding:12px 16px;text-align:left;font-size:11px;font-weight:700;
  text-transform:uppercase;letter-spacing:0.06em;color:var(--text2);font-family:'JetBrains Mono',monospace;}
tbody td{padding:14px 16px;border-bottom:1px solid rgba(107,124,62,0.1);vertical-align:top;line-height:1.5;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover td{background:rgba(107,124,62,0.04);}
.sev-tag{display:inline-flex;align-items:center;font-family:'JetBrains Mono',monospace;font-size:11px;
  font-weight:600;padding:3px 10px;border-radius:6px;white-space:nowrap;}
.sev-critica{background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.3);color:#e74c3c;}
.sev-alta{background:rgba(230,126,34,0.15);border:1px solid rgba(230,126,34,0.3);color:#e67e22;}
.sev-moderada{background:rgba(241,196,15,0.12);border:1px solid rgba(241,196,15,0.3);color:#f1c40f;}
.sev-baja{background:rgba(39,174,96,0.12);border:1px solid rgba(39,174,96,0.3);color:#27ae60;}
.sev-warning{background:rgba(230,126,34,0.12);border:1px solid rgba(230,126,34,0.3);color:#e67e22;}
.sev-error{background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.3);color:#e74c3c;}
code{font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--bg3);
  border:1px solid var(--border);padding:2px 7px;border-radius:5px;color:#a8bc6a;}
.npm-vuln-card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;
  padding:20px;margin-bottom:14px;position:relative;overflow:hidden;}
.npm-vuln-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;}
.npm-vuln-card.alta::before{background:var(--alta);}
.npm-vuln-card.moderada::before{background:var(--moderada);}
.npm-vuln-card.critica::before{background:var(--critica);}
.npm-vuln-card.baja::before{background:var(--baja);}
.npm-vuln-header{display:flex;align-items:flex-start;justify-content:space-between;
  gap:12px;margin-bottom:12px;flex-wrap:wrap;}
.npm-pkg-name{font-size:17px;font-weight:800;color:#fff;}
.npm-pkg-range{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2);margin-top:2px;}
.npm-advisories{display:flex;flex-direction:column;gap:10px;}
.advisory-item{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);
  border-radius:8px;padding:12px 14px;}
.advisory-title{font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;}
.advisory-details{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.cwe-tag{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:4px;
  background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.25);color:#3498db;}
.cvss-tag{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:4px;
  background:rgba(212,165,116,0.1);border:1px solid rgba(212,165,116,0.25);color:#d4a574;}
.advisory-link{font-family:'JetBrains Mono',monospace;font-size:10px;color:#6b9bd2;text-decoration:none;
  padding:2px 7px;border-radius:4px;background:rgba(107,155,210,0.08);border:1px solid rgba(107,155,210,0.2);}
.advisory-link:hover{background:rgba(107,155,210,0.18);}
.fix-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 9px;
  border-radius:100px;font-weight:600;}
.fix-yes{background:rgba(39,174,96,0.12);border:1px solid rgba(39,174,96,0.3);color:#27ae60;}
.fix-no{background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.3);color:#e74c3c;}
.empty-row{text-align:center;padding:32px;color:var(--baja);font-weight:600;font-size:14px;}
footer{text-align:center;padding:32px 0 20px;border-top:1px solid var(--border);
  color:var(--text2);font-size:12px;font-family:'JetBrains Mono',monospace;}
footer span{color:#d4a574;}
</style>
</head>
<body>
<div class="wrapper">

<header>
  <div class="header-left">
    <div class="logo-badge"><div class="logo-dot"></div>SECURITY REPORT &bull; BACKEND &bull; GITHUB ACTIONS</div>
    <h1>Reporte <span>SAST</span><br>Backend Node.js</h1>
    <p class="subtitle">Analisis estatico automatizado &bull; Semgrep + ESLint Security + npm audit<br>Docente: Ing. Ana Maria Felipe Redondo</p>
    <div class="meta-chips">
      <span class="chip">Pedro Rubio Angeles &bull; 20230074</span>
      <span class="chip">Alexander Hernandez Meza &bull; 20230106</span>
      <span class="chip">Seguridad Informatica &bull; 8 Cuatrimestre</span>
      <span class="chip">pier-reposteria-backend</span>
    </div>
  </div>
  <div class="status-badge">
    <span class="status-pill STATUS_CLASS">ESTADO_ICON ESTADO</span>
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">FECHA</span>
  </div>
</header>

<div class="cards-grid">
  <div class="card CARD_SEMGREP"><div class="icon">&#128269;</div><div class="num">SEMGREP_COUNT</div><div class="lbl">Alertas Semgrep</div></div>
  <div class="card CARD_ESLINT_E"><div class="icon">&#9889;</div><div class="num">ESLINT_ERRORS</div><div class="lbl">Errores ESLint</div></div>
  <div class="card CARD_ESLINT_W"><div class="icon">&#9888;</div><div class="num">ESLINT_WARNINGS</div><div class="lbl">Warnings ESLint</div></div>
  <div class="card CARD_NPM_C"><div class="icon">&#128308;</div><div class="num">NPM_CRITICAL</div><div class="lbl">npm Criticas</div></div>
  <div class="card CARD_NPM_H"><div class="icon">&#128992;</div><div class="num">NPM_HIGH</div><div class="lbl">npm Altas</div></div>
  <div class="card CARD_NPM_M"><div class="icon">&#128993;</div><div class="num">NPM_MODERATE</div><div class="lbl">npm Moderadas</div></div>
  <div class="card azul"><div class="icon">&#128193;</div><div class="num">NPM_TOTAL_DEPS</div><div class="lbl">Dependencias</div></div>
  <div class="card azul"><div class="icon">&#128196;</div><div class="num">SEMGREP_SCANNED</div><div class="lbl">Archivos escaneados</div></div>
</div>

<div class="section">
  <div class="section-header"><div class="section-title">&#8505; Informacion del Escaneo</div></div>
  <div class="info-grid">
    <div class="info-item"><div class="info-key">Proyecto</div><div class="info-val">Pier Reposteria Backend v1.0</div></div>
    <div class="info-item"><div class="info-key">Fecha de escaneo</div><div class="info-val">FECHA</div></div>
    <div class="info-item"><div class="info-key">Herramientas</div><div class="info-val">Semgrep &bull; ESLint Security Plugin &bull; npm audit</div></div>
    <div class="info-item"><div class="info-key">Alcance</div><div class="info-val">Node.js/Express (config, controllers, middleware, models, routes, services, utils)</div></div>
    <div class="info-item"><div class="info-key">Reglas aplicadas</div><div class="info-val">p/nodejs &bull; p/express &bull; p/jwt &bull; p/secrets &bull; p/sql-injection</div></div>
    <div class="info-item"><div class="info-key">Archivos escaneados</div><div class="info-val">SEMGREP_SCANNED archivos</div></div>
    <div class="info-item"><div class="info-key">Commit</div><div class="info-val"><code>COMMIT</code></div></div>
    <div class="info-item"><div class="info-key">Rama / Autor</div><div class="info-val"><code>BRANCH</code> &bull; ACTOR</div></div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">&#128269; Resultados Semgrep</div>
    <span class="count-badge">SEMGREP_COUNT alertas</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Severidad</th><th>Archivo</th><th>Linea</th><th>Regla</th><th>Descripcion</th></tr></thead>
      <tbody>SEMGREP_ROWS</tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">&#9889; Resultados ESLint Security Plugin</div>
    <span class="count-badge">ESLINT_ERRORS errores &bull; ESLINT_WARNINGS warnings</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Severidad</th><th>Archivo</th><th>Linea</th><th>Regla</th><th>Mensaje</th></tr></thead>
      <tbody>ESLINT_ROWS</tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">&#128230; npm audit &mdash; Vulnerabilidades en Dependencias</div>
    <span class="count-badge">NPM_COUNT_BADGE</span>
  </div>
  NPM_SECTION
</div>

<footer>Generado automaticamente por <span>GitHub Actions CI/CD</span> &bull; Pier Reposteria Security Pipeline &bull; UTHH 2026</footer>
</div>
</body>
</html>"""

HTML = HTML.replace('STATUS_CLASS', estado_class)
HTML = HTML.replace('ESTADO_ICON', estado_icon)
HTML = HTML.replace('ESTADO', estado)
HTML = HTML.replace('FECHA', fecha)
HTML = HTML.replace('COMMIT', commit)
HTML = HTML.replace('BRANCH', branch)
HTML = HTML.replace('ACTOR', actor)
HTML = HTML.replace('SEMGREP_COUNT', str(len(semgrep_results)))
HTML = HTML.replace('SEMGREP_SCANNED', str(semgrep_scanned))
HTML = HTML.replace('ESLINT_ERRORS', str(eslint_errors))
HTML = HTML.replace('ESLINT_WARNINGS', str(eslint_warnings))
HTML = HTML.replace('NPM_CRITICAL', str(npm_vulns['critical']))
HTML = HTML.replace('NPM_HIGH', str(npm_vulns['high']))
HTML = HTML.replace('NPM_MODERATE', str(npm_vulns['moderate']))
HTML = HTML.replace('NPM_TOTAL_DEPS', str(npm_deps_total))
HTML = HTML.replace('CARD_SEMGREP', card_class(len(semgrep_results)))
HTML = HTML.replace('CARD_ESLINT_E', card_class(eslint_errors))
HTML = HTML.replace('CARD_ESLINT_W', card_class(eslint_warnings, 'naranja'))
HTML = HTML.replace('CARD_NPM_C', card_class(npm_vulns['critical']))
HTML = HTML.replace('CARD_NPM_H', card_class(npm_vulns['high'], 'alta'))
HTML = HTML.replace('CARD_NPM_M', card_class(npm_vulns['moderate'], 'moderada'))
HTML = HTML.replace('SEMGREP_ROWS', semgrep_rows_html)
HTML = HTML.replace('ESLINT_ROWS', eslint_rows_html)
HTML = HTML.replace('NPM_COUNT_BADGE', npm_count_badge)
HTML = HTML.replace('NPM_SECTION', npm_section_content)

with open('sast-reporte-visual.html', 'w', encoding='utf-8') as f:
    f.write(HTML)

print(f"Reporte HTML generado correctamente")
print(f"  Semgrep:   {len(semgrep_results)} alertas")
print(f"  ESLint:    {eslint_errors} errores, {eslint_warnings} warnings")
print(f"  npm audit: {npm_vulns['total']} vulnerabilidades")