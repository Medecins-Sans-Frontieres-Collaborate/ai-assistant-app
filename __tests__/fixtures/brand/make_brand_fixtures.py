"""Builds the brand fixtures: one small document per format, each with
content that follows a brand and content that breaks it, and the brand's logo.

  python make_brand_fixtures.py __tests__/fixtures/brand   (needs python-pptx,
                                                            python-docx, pymupdf, pillow)

The brand ("Northwind"):
  palette  ink #1b2a41, teal #0f7c80, sand #f2e8d5 (white and black allowed)
  fonts    Montserrat for headings, Source Sans Pro for text
  logo     logo.png: a teal disc with an ink bar, 400 x 200 px

Every document holds, so each check has both sides:
  - a heading in Montserrat, ink (follows the brand)
  - a paragraph in Source Sans Pro, teal (follows)
  - a paragraph in Comic Sans MS, #ff00ff (breaks font and colour)
  - a paragraph in 7 pt (below a 9 pt minimum)
  - the word "cheap" (a banned term) in an otherwise compliant paragraph
  - the logo at its own proportions, and the logo squashed to half its
    height (distorted)
In brand.pptx the logo also sits on the master (every slide shows it).
locked.pdf is brand.pdf with a password.
"""
import copy
import io
import sys
from pathlib import Path

import fitz
from docx import Document
from docx.shared import Pt as DocxPt, RGBColor as DocxColor, Inches as DocxInches
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

INK = (0x1b, 0x2a, 0x41)
TEAL = (0x0f, 0x7c, 0x80)
OFF = (0xff, 0x00, 0xff)

TEXT = {
    'heading': 'Northwind annual review',
    'body': 'Our clinics served more families than ever.',
    'offbrand': 'Join the celebration this weekend!',
    'small': 'Terms apply to every programme.',
    'banned': 'Care that is never cheap and always close.',
}

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)


def logo_png():
    image = Image.new('RGBA', (400, 200), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((10, 10, 190, 190), fill=TEAL + (255,))
    draw.rectangle((210, 80, 390, 120), fill=INK + (255,))
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


LOGO = logo_png()
(out / 'logo.png').write_bytes(LOGO)


def pptx():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    # python-pptx places no picture on a master: one placed on the slide is
    # moved there, its image related from the master instead.
    placed = slide.shapes.add_picture(io.BytesIO(LOGO), Inches(8.6), Inches(0.2), Inches(1.2), Inches(0.6))
    master = prs.slide_master
    _, rid = master.part.get_or_add_image_part(io.BytesIO(LOGO))
    pic = copy.deepcopy(placed._element)
    pic.xpath('.//a:blip')[0].set(
        '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed', rid)
    master.shapes._spTree.append(pic)
    placed._element.getparent().remove(placed._element)
    rows = [('heading', 'Montserrat', 28, INK), ('body', 'Source Sans Pro', 18, TEAL),
            ('offbrand', 'Comic Sans MS', 18, OFF), ('small', 'Source Sans Pro', 7, INK),
            ('banned', 'Source Sans Pro', 18, INK)]
    for index, (key, font, size, color) in enumerate(rows):
        box = slide.shapes.add_textbox(Inches(0.5), Inches(0.4 + index * 0.8), Inches(7), Inches(0.6))
        run = box.text_frame.paragraphs[0].add_run()
        run.text = TEXT[key]
        run.font.name = font
        run.font.size = Pt(size)
        run.font.color.rgb = RGBColor(*color)
    slide.shapes.add_picture(io.BytesIO(LOGO), Inches(0.5), Inches(4.6), Inches(2), Inches(1))
    group = slide.shapes.add_group_shape()
    group.shapes.add_picture(io.BytesIO(LOGO), Inches(4), Inches(4.6), Inches(2), Inches(0.5))
    prs.save(out / 'brand.pptx')


def docx():
    doc = Document()
    rows = [('heading', 'Montserrat', 20, INK), ('body', 'Source Sans Pro', 11, TEAL),
            ('offbrand', 'Comic Sans MS', 11, OFF), ('small', 'Source Sans Pro', 7, INK),
            ('banned', 'Source Sans Pro', 11, INK)]
    for key, font, size, color in rows:
        run = doc.add_paragraph().add_run(TEXT[key])
        run.font.name = font
        run.font.size = DocxPt(size)
        run.font.color.rgb = DocxColor(*color)
    doc.add_picture(io.BytesIO(LOGO), width=DocxInches(2), height=DocxInches(1))
    doc.add_picture(io.BytesIO(LOGO), width=DocxInches(2), height=DocxInches(0.5))
    header = doc.sections[0].header.paragraphs[0].add_run('Northwind')
    header.font.name = 'Montserrat'
    doc.save(out / 'brand.docx')


def pdf():
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    rows = [('heading', 'helv', 20, INK), ('body', 'helv', 11, TEAL),
            ('offbrand', 'cour', 11, OFF), ('small', 'helv', 7, INK), ('banned', 'helv', 11, INK)]
    for index, (key, font, size, color) in enumerate(rows):
        page.insert_text((50, 80 + index * 40), TEXT[key], fontname=font, fontsize=size,
                         color=tuple(c / 255 for c in color))
    page.insert_image(fitz.Rect(50, 300, 250, 400), stream=LOGO)
    page.insert_image(fitz.Rect(300, 300, 500, 350), stream=LOGO, keep_proportion=False)
    doc.save(out / 'brand.pdf')
    # The same, password protected: the reader must refuse it.
    doc.save(out / 'locked.pdf', encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user')


pptx()
docx()
pdf()
print('wrote', ', '.join(sorted(p.name for p in out.iterdir() if p.suffix != '.py')))
