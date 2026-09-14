"""Deterministic, invented prescription tables. Requires ImageMagick + a Korean font.
Never reads a patient image. Committed PNGs run without these generator dependencies.
"""
import json, os, subprocess
from pathlib import Path
from xml.sax.saxutils import escape
ROOT = Path(__file__).resolve().parents[2] / 'test/fixtures/prescriptions'
previous = json.loads((ROOT/'dataset.json').read_text()) if (ROOT/'dataset.json').exists() else {'fixtures': []}
FONT = os.environ.get('RX_FIXTURE_FONT', '/usr/share/fonts/truetype/nanum/NanumGothic.ttf')
def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
def medication(code, name, package, dose, unit, freq, days):
    return dict(productCode=code, rawName=name+'/'+package, drugName=name, dosePerAdministration=dose, doseUnit=unit, frequencyPerDay=freq, durationDays=days)
reference = [medication('644913501','듀파락-이지시럽','15mL/포',1,'포',3,10), medication('649401610','에도스캡슐','1캡슐',1,'캡슐',2,60), medication('650202970','애니코프캡슐300mg','1캡슐',1,'캡슐',2,60), medication('642204150','셀벡스캡슐(내복)','1캡슐',1,'캡슐',2,60)]
other = [medication(None,'가상알파정10mg','1정',.5,'정',2,7), medication(None,'가상베타시럽','5mL',2.5,'mL',3,14)]
wrapped = [medication('123456789','가상긴이름-서방정200mg','1정',.5,'정',1,30), medication('234567890','가상감마캡슐(내복)','1캡슐',1,'캡슐',2,10)]
specs = [
 ('reference-rendered', reference, ['table','with-code','liquid'], 'wide-table'),
 ('borderless', other, ['borderless','without-code','decimal-dose','liquid'], 'spaced-text'),
 ('wrapped', wrapped, ['table','wrapped-name','with-code','decimal-dose'], 'tall-rows'),
 ('reordered', other, ['table','without-code','reordered-columns','decimal-dose','liquid'], 'dose-before-name'),
 ('skewed', wrapped, ['table','with-code','skewed','decimal-dose'], 'rotated-table'),
 ('low-light', other, ['borderless','without-code','low-light','liquid','decimal-dose'], 'dim-text'),
 ('mobile-simulated', reference[:2], ['table','with-code','mobile-photo','liquid','skewed'], 'simulated-camera'),
 ('decimal-liquid', [medication('345678901','가상델타정','1정',.5,'정',1,60),medication('456789012','가상액체-시럽','15mL/포',1,'포',3,10)], ['table','with-code','decimal-dose','liquid'], 'compact-table')
]
manifest = dict(schemaVersion=1, description='Synthetic bootstrap set; real reviewed images can be added without changing evaluator.', fixtures=[])
refdir = ROOT/'cases/current-reference'
dump(refdir/'labels.json', dict(schemaVersion=1, medications=reference))
dump(refdir/'ocr.json', dict(provenance='manual-transcription', text='\n'.join(f"{r['productCode']} {r['rawName']} {r['dosePerAdministration']} {r['frequencyPerDay']} {r['durationDays']}" for r in reference)))
manifest['fixtures'].append(dict(id='current-reference', source='transcribed-reference', status='awaiting-image', image=None, labels='cases/current-reference/labels.json', ocr='cases/current-reference/ocr.json', privacyReviewed=True, layoutFamily='user-reference-unknown', tags=['table','with-code','liquid'], notes='User supplied medication text only; no original image available. Parser transcript score is not image OCR accuracy.'))
for ident, rows, tags, family in specs:
    directory=ROOT/'cases'/ident; directory.mkdir(parents=True,exist_ok=True)
    dump(directory/'labels.json',dict(schemaVersion=1,medications=rows))
    columns=[40,1060,1320,1540] if ident!='reordered' else [300,40,1320,1540]
    headers=['처방의약품의 명칭','1회 투여량','1일 투여횟수','총 투약일수']
    words=[]; elements=[]
    def word(text,x,y,width):
        words.append(dict(text=str(text),x0=x,y0=y,x1=x+width,y1=y+30,confidence=95))
        elements.append(f'<text x="{x}" y="{y+28}" font-size="30">{escape(str(text))}</text>')
    for i,header in enumerate(headers): word(header,columns[i],70,260 if i==0 else 180)
    for i,row in enumerate(rows):
        y=155+i*110
        name=(row['productCode']+' ' if row['productCode'] else '')+row['rawName']
        if ident=='wrapped' and i==0:
            word(row['productCode']+' 가상긴이름-',columns[0],y,520)
            word('서방정200mg/1정',columns[0],y+40,360)
            y+=40
        else: word(name,columns[0],y,900)
        for j,f in enumerate(['dosePerAdministration','frequencyPerDay','durationDays']): word(row[f],columns[j+1]+35,y,35)
    h=190+len(rows)*110
    if 'table' in tags:
        for y in [50,125]+[235+i*110 for i in range(len(rows))]: elements.insert(0,f'<line x1="20" y1="{y}" x2="1790" y2="{y}" stroke="#777"/>')
        for x in ([20,1030,1280,1500,1790] if ident!='reordered' else [20,260,1280,1500,1790]): elements.insert(0,f'<line x1="{x}" y1="50" x2="{x}" y2="{h-65}" stroke="#777"/>')
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="1820" height="{h}"><rect width="100%" height="100%" fill="white"/><g font-family="NanumGothic" fill="#111">'+''.join(elements)+'</g></svg>'
    (directory/'render.svg').write_text(svg)
    args=['convert','-font',FONT,'-background','white',str(directory/'render.svg')]
    if ident=='skewed': args+=['-rotate','3']
    if ident=='low-light': args+=['-brightness-contrast','-55x-25']
    if ident=='mobile-simulated': args+=['-rotate','-2','-resize','75%','-blur','0x0.4']
    args+=['-strip',str(directory/'image.png')]; subprocess.run(args,check=True)
    dump(directory/'ocr.json',dict(provenance='synthetic-tokens', notes='Ideal pre-distortion tokens, NOT engine output. Only tests parser structure.', words=words))
    manifest['fixtures'].append(dict(id=ident,source='synthetic',status='ready',image=f'cases/{ident}/image.png',labels=f'cases/{ident}/labels.json',ocr=f'cases/{ident}/ocr.json',privacyReviewed=True,layoutFamily=family,tags=tags,notes='Invented rendering; mobile-photo tag here is a simulation, not a real camera capture.'))
generated = {f['id'] for f in manifest['fixtures']}
for old in previous['fixtures']:
    if old['id'] not in generated: manifest['fixtures'].append(old)
    elif old['id'] == 'current-reference' and old.get('image'): manifest['fixtures'][0] = old
dump(ROOT/'dataset.json',manifest)
