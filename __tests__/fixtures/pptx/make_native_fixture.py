"""Builds native.pptx: the deck the Preserve formatting deck script is tested on.

  python make_native_fixture.py __tests__/fixtures/pptx     (needs python-pptx, lxml)

One feature per slide (slide numbers are pages):
  1  title placeholder whose size is set ONLY on the master (40 pt), body
     placeholder with two bullets, mixed formatting (a bold run) and a
     slide-number field; speaker notes.
  2  nested groups: a text box inside a group inside a group, with the
     groups' child coordinates scaled.
  3  a 3x2 table whose first row is merged across both columns.
  4  a chart with a title, series name and categories, and its embedded
     workbook.
  5  SmartArt written by hand (data model plus cached drawing; no tool
     here makes it): two nodes.
  6  alternate content: a text box in mc:Choice with a fallback copy, and a
     paragraph holding an equation (a14:m).
  7  hidden.
  8  fit: "JUST FITS" in a box sized for it, and "DOES NOT FIT" in a box
     of the same size (the case that must fail, see the deck test).
  9  a numbered list (automatic numbering) and a hyperlinked run.
  The master carries a non-placeholder text box ("Confidential").
"""
import copy
import sys
import zipfile
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Emu, Inches, Pt

A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
prs = Presentation()
prs.slide_width, prs.slide_height = Inches(10), Inches(7.5)

# Master: title size only here; a non-placeholder text box.
master = prs.slide_master
title_style = master._element.find('{%s}txStyles/{%s}titleStyle' % (P, P))
title_style.find('{%s}lvl1pPr/{%s}defRPr' % (A, A)).set('sz', '4000')
for layout in prs.slide_layouts:
    for ph in layout.placeholders:
        if ph.placeholder_format.type is not None and ph.name.lower().startswith('title'):
            for rpr in ph._element.iter('{%s}defRPr' % A):
                rpr.attrib.pop('sz', None)
master._element.find('{%s}cSld/{%s}spTree' % (P, P)).append(etree.fromstring(
    f'<p:sp xmlns:p="{P}" xmlns:a="{A}"><p:nvSpPr><p:cNvPr id="90" name="Mark"/><p:cNvSpPr txBox="1"/>'
    f'<p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{Inches(8)}" y="{Inches(7)}"/>'
    f'<a:ext cx="{Inches(1.8)}" cy="{Inches(0.4)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    f'</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1000"/>'
    f'<a:t>Confidential</a:t></a:r></a:p></p:txBody></p:sp>'))

# 1: title, bullets with a bold run and a field, notes.
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = 'Annual report'
body = s.placeholders[1].text_frame
body.text = 'The clinic opened in March.'
para = body.add_paragraph()
run = para.add_run(); run.text = 'Patients seen: '
run = para.add_run(); run.text = '1,200'; run.font.bold = True
run = para.add_run(); run.text = ' this year, page '
fld = etree.SubElement(para._p, '{%s}fld' % A, id='{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}', type='slidenum')
etree.SubElement(fld, '{%s}rPr' % A, lang='en-US')
etree.SubElement(fld, '{%s}t' % A).text = '1'
s.notes_slide.notes_text_frame.text = 'Remember to thank the volunteers.'

# 2: nested groups with scaled child coordinates.
s = prs.slides.add_slide(prs.slide_layouts[6])
outer = s.shapes.add_group_shape()
inner = outer.shapes.add_group_shape()
tb = inner.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
tb.text_frame.text = 'Text inside two groups'
for grp in (outer, inner):
    xfrm = grp._element.find('{%s}grpSpPr/{%s}xfrm' % (P, A))
    xfrm.find('{%s}chExt' % A).set('cx', str(int(xfrm.find('{%s}ext' % A).get('cx')) // 2))

# 3: table with a merged first row.
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = 'Budget table'
t = s.shapes.add_table(3, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
t.cell(0, 0).merge(t.cell(0, 1))
t.cell(0, 0).text = 'Spending in 2026'
t.cell(1, 0).text = 'Medicine'; t.cell(1, 1).text = 'Transport'
t.cell(2, 0).text = 'Training'; t.cell(2, 1).text = 'Housing'

# 4: chart with a workbook.
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = 'Spending chart'
data = CategoryChartData(); data.categories = ['North', 'South']; data.add_series('Spending', (3, 5))
chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(6), Inches(4), data).chart
chart.has_title = True
chart.chart_title.text_frame.text = 'Spending by region'

# 5: SmartArt placeholder frame; its parts are added below.
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = 'Process'
smartart_slide = s

# 6: alternate content and an equation.
s = prs.slides.add_slide(prs.slide_layouts[6])
choice_box = s.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
choice_box.text_frame.text = 'Shown by new readers'
eq_box = s.shapes.add_textbox(Inches(1), Inches(3), Inches(6), Inches(1))
eq_para = eq_box.text_frame.paragraphs[0]
r = eq_para.add_run(); r.text = 'Area is '
alternate_slide = s

# 7: hidden.
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = 'Hidden slide'
s._element.set('show', '0')

# 8: fit bracket. 24 pt Arial, one line each; the box holds one line.
s = prs.slides.add_slide(prs.slide_layouts[6])
for top, text in ((1, 'JUST FITS'), (3, 'DOES NOT FIT')):
    tb = s.shapes.add_textbox(Inches(1), Inches(top), Inches(3), Emu(int(Pt(24) * 1.2) + 91440))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = None
    tf.text = text
    for run in tf.paragraphs[0].runs:
        run.font.size = Pt(24); run.font.name = 'Arial'
    body_pr = tf._txBody.find('{%s}bodyPr' % A)
    for child in list(body_pr):
        body_pr.remove(child)
    etree.SubElement(body_pr, '{%s}noAutofit' % A)

# 9: a numbered list and a link.
s = prs.slides.add_slide(prs.slide_layouts[6])
tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(2))
tf = tb.text_frame
tf.text = 'First step'
second = tf.add_paragraph(); second.text = 'Second step'
for para in tf.paragraphs:
    ppr = para._p.get_or_add_pPr()
    ppr.set('marL', '342900'); ppr.set('indent', '-342900')
    etree.SubElement(ppr, '{%s}buAutoNum' % A, type='arabicPeriod')
link_para = tf.add_paragraph()
run = link_para.add_run(); run.text = 'Read the '
run = link_para.add_run(); run.text = 'full report'
run.hyperlink.address = 'https://example.org/report'

path = out / 'native.pptx'
prs.save(path)

# ── hand-written parts: alternate content, equation, SmartArt ──────────────
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
A14 = 'http://schemas.microsoft.com/office/drawing/2010/main'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

with zipfile.ZipFile(path) as zf:
    parts = {info.filename: zf.read(info.filename) for info in zf.infolist()}
order = list(parts)


def slide_name(slide):
    return slide.part.partname.lstrip('/')


# 6: wrap the first text box in mc:AlternateContent with a fallback copy,
# and put an equation in the second box's paragraph.
name = slide_name(alternate_slide)
root = etree.fromstring(parts[name])
tree = root.find('{%s}cSld/{%s}spTree' % (P, P))
sp = [e for e in tree if e.tag == '{%s}sp' % P][0]
index = tree.index(sp)
alt = etree.Element('{%s}AlternateContent' % MC, nsmap={'mc': MC, 'a14': A14})
choice = etree.SubElement(alt, '{%s}Choice' % MC, Requires='a14')
fallback = etree.SubElement(alt, '{%s}Fallback' % MC)
tree.remove(sp)
choice.append(sp)
fallback.append(copy.deepcopy(sp))
tree.insert(index, alt)
eq_p = root.findall('.//{%s}p' % A)[-1]
math = etree.SubElement(eq_p, '{%s}AlternateContent' % MC)
mchoice = etree.SubElement(math, '{%s}Choice' % MC, Requires='a14')
a14m = etree.SubElement(mchoice, '{%s}m' % A14)
omp = etree.SubElement(a14m, '{%s}oMathPara' % M, nsmap={'m': M})
om = etree.SubElement(omp, '{%s}oMath' % M)
mr = etree.SubElement(om, '{%s}r' % M)
etree.SubElement(mr, '{%s}t' % M).text = 'πr²'
mfallback = etree.SubElement(math, '{%s}Fallback' % MC)
fr = etree.SubElement(mfallback, '{%s}r' % A)
etree.SubElement(fr, '{%s}t' % A).text = 'πr²'
end = eq_p.find('{%s}endParaRPr' % A)
if end is not None:
    eq_p.remove(end)
    eq_p.append(end)
parts[name] = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)

# 5: SmartArt data model, cached drawing and the frame on the slide.
name = slide_name(smartart_slide)
folder = 'ppt/diagrams/'
data_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:dgm="{DGM}" xmlns:a="{A}" xmlns:dsp="{DSP}" xmlns:r="{R}">
<dgm:ptLst>
<dgm:pt modelId="{{00000000-0000-0000-0000-000000000000}}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>
<dgm:pt modelId="{{11111111-1111-1111-1111-111111111111}}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Plan the visit</a:t></a:r></a:p></dgm:t></dgm:pt>
<dgm:pt modelId="{{22222222-2222-2222-2222-222222222222}}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Report back</a:t></a:r></a:p></dgm:t></dgm:pt>
</dgm:ptLst>
<dgm:cxnLst/><dgm:bg/><dgm:whole/>
<dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt relId="rId99" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst>
</dgm:dataModel>'''
drawing_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dsp:drawing xmlns:dgm="{DGM}" xmlns:dsp="{DSP}" xmlns:a="{A}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>
<dsp:sp modelId="{{11111111-1111-1111-1111-111111111111}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>Plan the visit</a:t></a:r></a:p></dsp:txBody><dsp:txXfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="1371600"/></dsp:txXfrm></dsp:sp>
<dsp:sp modelId="{{22222222-2222-2222-2222-222222222222}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="3200400" y="0"/><a:ext cx="2743200" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>Report back</a:t></a:r></a:p></dsp:txBody><dsp:txXfrm><a:off x="3200400" y="0"/><a:ext cx="2743200" cy="1371600"/></dsp:txXfrm></dsp:sp>
</dsp:spTree></dsp:drawing>'''
parts[folder + 'data1.xml'] = data_xml.encode()
parts[folder + 'drawing1.xml'] = drawing_xml.encode()
order += [folder + 'data1.xml', folder + 'drawing1.xml']
rels_name = 'ppt/slides/_rels/' + name.split('/')[-1] + '.rels'
rels = etree.fromstring(parts[rels_name])
RNS = 'http://schemas.openxmlformats.org/package/2006/relationships'
etree.SubElement(rels, '{%s}Relationship' % RNS, Id='rId98', Target='../diagrams/data1.xml',
                 Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData')
etree.SubElement(rels, '{%s}Relationship' % RNS, Id='rId99', Target='../diagrams/drawing1.xml',
                 Type='http://schemas.microsoft.com/office/2007/relationships/diagramDrawing')
parts[rels_name] = etree.tostring(rels, xml_declaration=True, encoding='UTF-8', standalone=True)
root = etree.fromstring(parts[name])
tree = root.find('{%s}cSld/{%s}spTree' % (P, P))
frame = etree.fromstring(f'''<p:graphicFrame xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}" xmlns:dgm="{DGM}">
<p:nvGraphicFramePr><p:cNvPr id="40" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="914400" y="2286000"/><a:ext cx="5943600" cy="1371600"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rId98" r:lo="rId98" r:qs="rId98" r:cs="rId98"/></a:graphicData></a:graphic>
</p:graphicFrame>''')
tree.append(frame)
parts[name] = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
types = etree.fromstring(parts['[Content_Types].xml'])
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
etree.SubElement(types, '{%s}Override' % CT, PartName='/ppt/diagrams/data1.xml',
                 ContentType='application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml')
etree.SubElement(types, '{%s}Override' % CT, PartName='/ppt/diagrams/drawing1.xml',
                 ContentType='application/vnd.ms-office.drawingml.diagramDrawing+xml')
parts['[Content_Types].xml'] = etree.tostring(types, xml_declaration=True, encoding='UTF-8', standalone=True)

with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for entry in order:
        zf.writestr(entry, parts[entry])
print('wrote', path)
