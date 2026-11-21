"""Builds the PowerPoint test fixtures in this folder.

  python make_fixtures.py __tests__/fixtures/pptx     (needs python-pptx)

  rich.pptx     one feature per slide: title and bullets with speaker notes,
                a table, a chart with a title, a hidden slide (4), a text
                box in a group.
  rich.pptm     the same deck declared macro-enabled, with a stand-in macro
                part (ppt/vbaProject.bin) that must survive byte for byte.
  hidden.pptx   five slides titled "Slide 1".."Slide 5", slide 3 hidden.

Not made here:
  rich.ppt      rich.pptx saved as PowerPoint 97 by LibreOffice:
                libreoffice --headless --convert-to 'ppt:MS PowerPoint 97' rich.pptx
  rich.fr.pptx  rich.pptx as the document translation service returned it
                in French (dev instance, 2026-11-19): what merging is tested
                against.
"""
import sys, zipfile
from pathlib import Path
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = 'Annual report'
s.placeholders[1].text_frame.text = 'The clinic opened in March.'
s.notes_slide.notes_text_frame.text = 'Remember to thank the volunteers.'
s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Budget table'
t = s.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
t.cell(0,0).text='Medicine'; t.cell(0,1).text='Transport'; t.cell(1,0).text='Training'; t.cell(1,1).text='Housing'
s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Spending chart'
d = CategoryChartData(); d.categories = ['North', 'South']; d.add_series('Spending', (3, 5))
ch = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(6), Inches(4), d).chart
ch.has_title = True; ch.chart_title.text_frame.text = 'Spending by region'
s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Hidden slide'
s._element.set('show', '0')
s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Grouped shapes'
g = s.shapes.add_group_shape(); b = g.shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1)); b.text_frame.text = 'Text inside a group'
p.save(out / 'rich.pptx')
# The macro-enabled copy: its main content type, a macro part, and the
# relationship and content type that declare it.
VBA = bytes(range(256)) * 4
with zipfile.ZipFile(out / 'rich.pptx') as src, zipfile.ZipFile(out / 'rich.pptm', 'w', zipfile.ZIP_DEFLATED) as dst:
    for item in src.infolist():
        data = src.read(item)
        if item.filename == '[Content_Types].xml':
            data = data.replace(
                b'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
                b'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml')
            data = data.replace(b'</Types>', b'<Override PartName="/ppt/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')
        if item.filename == 'ppt/_rels/presentation.xml.rels':
            data = data.replace(b'</Relationships>', b'<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>')
        dst.writestr(item, data)
    dst.writestr('ppt/vbaProject.bin', VBA)

small = Presentation()
for number in range(1, 6):
    slide = small.slides.add_slide(small.slide_layouts[5])
    slide.shapes.title.text = f'Slide {number}'
    if number == 3:
        slide._element.set('show', '0')
small.save(out / 'hidden.pptx')
print('ok')
