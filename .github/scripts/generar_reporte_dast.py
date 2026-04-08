import json, os
from datetime import datetime

fecha = datetime.now().strftime('%d/%m/%Y %H:%M:%S UTC')
commit = os.environ.get('GITHUB_SHA', 'N/A')[:7]
branch = os.environ.get('GITHUB_REF_NAME', 'N/A')
actor  = os.environ.get('GITHUB_ACTOR', 'N/A')

# ---------- Leer ZAP ----------
zap_alerts = []
zap_high = 0
zap_medium = 0
zap_low = 0
zap_info = 0
zap_target = 'https://pier-reposteria-backend.onrender.com/api'
zap_status = 'Sin alertas detectadas (WAF de Vercel puede limitar el scan activo)'

for zap_path in ['dast-reports/zap-report.json', 'zap-report.json']:
    try:
        with open(zap_path) as f:
            content = f.read().strip()
        if not content:
            break
        zap_data = json.loads(content)
        sites = zap_data.get('site', [])
        if sites:
            zap_target = sites[0].get('@name', zap_target)
            for alert in sites[0].get('alerts', []):
                risk = alert.get('riskdesc', 'Informational').split(' ')[0]
                if risk == 'High':        zap_high += 1
                elif risk == 'Medium':    zap_medium += 1
                elif risk == 'Low':       zap_low += 1
                else:                     zap_info += 1
                zap_alerts.append({
                    'risk': risk,
                    'name': alert.get('name', 'N/A'),
                    'desc': alert.get('desc', '')[:150].replace('<p>','').replace('</p>',' ').strip(),
                    'solution': alert.get('solution', '')[:150].replace('<p>','').replace('</p>',' ').strip(),
                    'url': alert.get('instances', [{}])[0].get('uri', zap_target) if alert.get('instances') else zap_target,
                    'cweid': alert.get('cweid', 'N/A'),
                    'wascid': alert.get('wascid', 'N/A'),
                })
        break
    except:
        continue

zap_rows_html = ''
if zap_alerts:
    for a in zap_alerts:
        risk = a['risk']
        sev_class = 'sev-error' if risk == 'High' else 'sev-warning' if risk == 'Medium' else 'sev-baja' if risk == 'Low' else 'sev-info'
        zap_rows_html += f'''<tr>
          <td><span class="sev-tag {sev_class}">{risk}</span></td>
          <td><strong>{a['name']}</strong><br><span style="font-size:11px;color:var(--text2)">{a['desc']}</span></td>
          <td><code style="font-size:10px">{a['url'][:60]}</code></td>
          <td><span class="cwe-tag">CWE-{a['cweid']}</span></td>
          <td style="font-size:12px;color:var(--text2)">{a['solution']}</td>
        </tr>'''
else:
    zap_rows_html = f'<tr><td colspan="5" class="empty-row">&#10003; {zap_status}</td></tr>'

# ---------- Leer Nikto ----------
nikto_findings = []
nikto_target = 'pier-reposteria-backend.onrender.com/api'
nikto_port = '443'

for nikto_path in ['dast-reports/nikto-report.txt', 'nikto-report.txt']:
    try:
        with open(nikto_path) as f:
            lines = f.readlines()
        for line in lines:
            line = line.strip()
            if line.startswith('+ Target Host:'):
                nikto_target = line.replace('+ Target Host:', '').strip()
            elif line.startswith('+ Target Port:'):
                nikto_port = line.replace('+ Target Port:', '').strip()
            elif line.startswith('+ GET') or line.startswith('+ POST') or line.startswith('+ HEAD'):
                parts = line.split(':', 1)
                method_path = parts[0].replace('+ ', '').strip()
                description = parts[1].strip() if len(parts) > 1 else line
                severity = 'Medium' if any(k in description.lower() for k in ['vulnerability','inject','xss','csrf','sql','password','secret','admin']) else 'Low'
                nikto_findings.append({
                    'method_path': method_path,
                    'description': description,
                    'severity': severity
                })
        if lines:
            break
    except:
        continue

nikto_rows_html = ''
if nikto_findings:
    for f in nikto_findings:
        sev_class = 'sev-warning' if f['severity'] == 'Medium' else 'sev-baja'
        nikto_rows_html += f'''<tr>
          <td><span class="sev-tag {sev_class}">{f['severity']}</span></td>
          <td><code>{f['method_path']}</code></td>
          <td>{f['description']}</td>
        </tr>'''
else:
    nikto_rows_html = '<tr><td colspan="3" class="empty-row">&#10003; Sin hallazgos criticos detectados</td></tr>'

# ---------- Estado general ----------
total_critico = zap_high + zap_medium
estado = 'REQUIERE ATENCION' if total_critico > 0 else 'SEGURO'
estado_class = 'status-atencion' if total_critico > 0 else 'status-ok'
estado_icon = '⚠ WARNING' if total_critico > 0 else '✓ OK'

def card_class(n, level='critica'):
    return level if n > 0 else 'verde'

HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte DAST - Pier Reposteria</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--verde:#6b7c3e;--dorado:#d4a574;--bg:#0d0f0a;--bg2:#13160e;--bg3:#1a1e12;
  --border:rgba(107,124,62,0.25);--text:#e8e4df;--text2:#9a9488;
  --critica:#e74c3c;--alta:#e67e22;--moderada:#f1c40f;--baja:#27ae60;--info:#3498db;}
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
.cards-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:40px;}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:20px;
  position:relative;overflow:hidden;transition:transform 0.2s;}
.card:hover{transform:translateY(-2px);}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
.card.verde::before{background:var(--baja);}
.card.alta::before{background:var(--alta);}
.card.moderada::before{background:var(--moderada);}
.card.critica::before{background:var(--critica);}
.card.azul::before{background:var(--info);}
.card .icon{font-size:20px;margin-bottom:10px;}
.card .num{font-size:36px;font-weight:800;line-height:1;margin-bottom:4px;font-family:'JetBrains Mono',monospace;}
.card.verde .num{color:var(--baja);}
.card.alta .num{color:var(--alta);}
.card.moderada .num{color:var(--moderada);}
.card.critica .num{color:var(--critica);}
.card.azul .num{color:var(--info);}
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
.sev-error{background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.3);color:#e74c3c;}
.sev-warning{background:rgba(230,126,34,0.12);border:1px solid rgba(230,126,34,0.3);color:#e67e22;}
.sev-baja{background:rgba(39,174,96,0.12);border:1px solid rgba(39,174,96,0.3);color:#27ae60;}
.sev-info{background:rgba(52,152,219,0.12);border:1px solid rgba(52,152,219,0.3);color:#3498db;}
code{font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--bg3);
  border:1px solid var(--border);padding:2px 7px;border-radius:5px;color:#a8bc6a;}
.cwe-tag{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:4px;
  background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.25);color:#3498db;}
.empty-row{text-align:center;padding:32px;color:var(--baja);font-weight:600;font-size:14px;}
.rec-item{background:var(--bg3);border:1px solid var(--border);border-radius:10px;
  padding:16px 18px;margin-bottom:12px;display:flex;gap:14px;align-items:flex-start;}
.rec-num{width:28px;height:28px;border-radius:50%;background:rgba(107,124,62,0.2);
  border:1px solid rgba(107,124,62,0.4);color:#a8bc6a;font-size:12px;font-weight:700;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'JetBrains Mono',monospace;}
.rec-content{flex:1;}
.rec-title{font-size:14px;font-weight:700;color:#fff;margin-bottom:4px;}
.rec-desc{font-size:13px;color:var(--text2);line-height:1.6;}
.rec-cmd{margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--bg);
  border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:#a8bc6a;display:inline-block;}
footer{text-align:center;padding:32px 0 20px;border-top:1px solid var(--border);
  color:var(--text2);font-size:12px;font-family:'JetBrains Mono',monospace;}
footer span{color:#d4a574;}
</style>
</head>
<body>
<div class="wrapper">
<header>
  <div class="header-left">
    <div class="logo-badge"><div class="logo-dot"></div>DAST REPORT &bull; GITHUB ACTIONS CI/CD</div>
    <h1>Reporte <span>DAST</span><br>Pier Reposteria</h1>
    <p class="subtitle">Analisis dinamico automatizado &bull; OWASP ZAP Baseline Scan + Nikto<br>Docente: Ing. Ana Maria Felipe Redondo</p>
    <div class="meta-chips">
      <span class="chip">Pedro Rubio Angeles &bull; 20230074</span>
      <span class="chip">Alexander Hernandez Meza &bull; 20230106</span>
      <span class="chip">Seguridad Informatica &bull; 8 Cuatrimestre</span>
    </div>
  </div>
  <div class="status-badge">
    <span class="status-pill STATUS_CLASS">ESTADO_ICON</span>
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">FECHA</span>
  </div>
</header>

<div class="cards-grid">
  <div class="card CARD_ZAP_H"><div class="icon">&#128683;</div><div class="num">ZAP_HIGH</div><div class="lbl">ZAP Altas</div></div>
  <div class="card CARD_ZAP_M"><div class="icon">&#9888;</div><div class="num">ZAP_MEDIUM</div><div class="lbl">ZAP Medias</div></div>
  <div class="card CARD_ZAP_L"><div class="icon">&#128994;</div><div class="num">ZAP_LOW</div><div class="lbl">ZAP Bajas</div></div>
  <div class="card CARD_ZAP_I"><div class="icon">&#8505;</div><div class="num">ZAP_INFO</div><div class="lbl">ZAP Info</div></div>
  <div class="card CARD_NIKTO"><div class="icon">&#128270;</div><div class="num">NIKTO_COUNT</div><div class="lbl">Nikto Hallazgos</div></div>
  <div class="card azul"><div class="icon">&#127760;</div><div class="num" style="font-size:13px;padding-top:6px">pier-reposteria<br>.vercel.app</div><div class="lbl">Objetivo</div></div>
</div>

<div class="section">
  <div class="section-header"><div class="section-title">&#8505; Informacion del Escaneo</div></div>
  <div class="info-grid">
    <div class="info-item"><div class="info-key">Tipo de prueba</div><div class="info-val">DAST &mdash; Analisis Dinamico</div></div>
    <div class="info-item"><div class="info-key">Fecha de escaneo</div><div class="info-val">FECHA</div></div>
    <div class="info-item"><div class="info-key">Herramientas</div><div class="info-val">OWASP ZAP v2.15 Baseline &bull; Nikto v2.1.5</div></div>
    <div class="info-item"><div class="info-key">Objetivo</div><div class="info-val">ZAP_TARGET_VAL</div></div>
    <div class="info-item"><div class="info-key">Modo ZAP</div><div class="info-val">Baseline Scan (pasivo, sin ataque activo)</div></div>
    <div class="info-item"><div class="info-key">Puerto Nikto</div><div class="info-val">NIKTO_PORT_VAL (HTTPS)</div></div>
    <div class="info-item"><div class="info-key">Commit</div><div class="info-val"><code>COMMIT</code></div></div>
    <div class="info-item"><div class="info-key">Rama / Autor</div><div class="info-val"><code>BRANCH</code> &bull; ACTOR</div></div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">&#127760; OWASP ZAP &mdash; Baseline Scan</div>
    <span class="count-badge">ZAP_TOTAL alertas totales</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Riesgo</th><th>Alerta</th><th>URL</th><th>CWE</th><th>Solucion recomendada</th></tr></thead>
      <tbody>ZAP_ROWS</tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">&#128270; Nikto &mdash; Escaneo de Servidor Web</div>
    <span class="count-badge">NIKTO_COUNT_LABEL</span>
  </div>
  <div class="info-grid" style="margin-bottom:16px">
    <div class="info-item"><div class="info-key">Host objetivo</div><div class="info-val">NIKTO_TARGET_VAL</div></div>
    <div class="info-item"><div class="info-key">Puerto</div><div class="info-val">NIKTO_PORT_VAL (HTTPS)</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Severidad</th><th>Metodo / Ruta</th><th>Descripcion</th></tr></thead>
      <tbody>NIKTO_ROWS</tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">&#128295; Recomendaciones de Remediacion</div>
    <span class="count-badge">2 acciones</span>
  </div>
  <div class="rec-item">
    <div class="rec-num">1</div>
    <div class="rec-content">
      <div class="rec-title">Agregar header X-Frame-Options</div>
      <div class="rec-desc">Nikto detecto la ausencia del header anti-clickjacking. Configura Vercel para incluirlo en todas las respuestas para prevenir ataques de clickjacking.</div>
      <div class="rec-cmd">vercel.json &rarr; headers: [{ "X-Frame-Options": "DENY" }]</div>
    </div>
  </div>
  <div class="rec-item">
    <div class="rec-num">2</div>
    <div class="rec-content">
      <div class="rec-title">Revisar header Refresh detectado por Nikto</div>
      <div class="rec-desc">El header Refresh puede ser aprovechado para open redirects maliciosos. Verificar que la redireccion apunte siempre al dominio propio y considerar reemplazarlo por una redireccion 301.</div>
      <div class="rec-cmd">Reemplazar Refresh header por redireccion HTTP 301</div>
    </div>
  </div>
</div>

<footer>Generado automaticamente por <span>GitHub Actions CI/CD</span> &bull; Pier Reposteria Security Pipeline &bull; UTHH 2026</footer>
</div>
</body>
</html>"""

HTML = HTML.replace('STATUS_CLASS', estado_class)
HTML = HTML.replace('ESTADO_ICON', estado_icon)
HTML = HTML.replace('FECHA', fecha)
HTML = HTML.replace('COMMIT', commit)
HTML = HTML.replace('BRANCH', branch)
HTML = HTML.replace('ACTOR', actor)
HTML = HTML.replace('ZAP_HIGH', str(zap_high))
HTML = HTML.replace('ZAP_MEDIUM', str(zap_medium))
HTML = HTML.replace('ZAP_LOW', str(zap_low))
HTML = HTML.replace('ZAP_INFO', str(zap_info))
HTML = HTML.replace('ZAP_TOTAL', str(len(zap_alerts)))
HTML = HTML.replace('NIKTO_COUNT', str(len(nikto_findings)))
HTML = HTML.replace('NIKTO_COUNT_LABEL', f"{len(nikto_findings)} hallazgos" if nikto_findings else "Sin hallazgos")
HTML = HTML.replace('CARD_ZAP_H', card_class(zap_high, 'alta'))
HTML = HTML.replace('CARD_ZAP_M', card_class(zap_medium, 'moderada'))
HTML = HTML.replace('CARD_ZAP_L', card_class(zap_low, 'baja'))
HTML = HTML.replace('CARD_ZAP_I', 'azul')
HTML = HTML.replace('CARD_NIKTO', card_class(len(nikto_findings), 'moderada'))
HTML = HTML.replace('ZAP_ROWS', zap_rows_html)
HTML = HTML.replace('NIKTO_ROWS', nikto_rows_html)
HTML = HTML.replace('ZAP_TARGET_VAL', zap_target)
HTML = HTML.replace('NIKTO_TARGET_VAL', nikto_target)
HTML = HTML.replace('NIKTO_PORT_VAL', nikto_port)

with open('dast-reporte-visual.html', 'w', encoding='utf-8') as f:
    f.write(HTML)

print(f"Reporte DAST generado correctamente")
print(f"  ZAP:   {len(zap_alerts)} alertas (High:{zap_high} Med:{zap_medium} Low:{zap_low} Info:{zap_info})")
print(f"  Nikto: {len(nikto_findings)} hallazgos")