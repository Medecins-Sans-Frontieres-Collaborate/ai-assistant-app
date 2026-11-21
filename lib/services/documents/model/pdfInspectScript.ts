/**
 * The PDF reader: the Python program that describes a PDF's pages, text
 * and pictures (the DOCUMENT MODEL, documentModel.ts) inside the
 * code-interpreter sandbox, uploaded and run AS IS.
 *
 * It is Python kept in a TypeScript string so it ships inside the server
 * bundle; the raw template keeps its backslashes, so the text must never
 * contain a backtick or a dollar-brace sequence (its test checks). Its
 * conventions are stated once, in its own docstring.
 */
import type { SandboxScript } from '@/lib/services/documents/sandbox/sandboxScriptRunner';

/** Filename the program is uploaded under; the launch snippet looks for it. */
export const PDF_INSPECT_FILENAME = 'pdf_inspect.py';

/** Archive each command leaves beside the program, by command. */
export const PDF_INSPECT_ARCHIVES = {
  inspect: 'pdf_inspect.zip',
} as const;

export type PdfInspectCommand = keyof typeof PDF_INSPECT_ARCHIVES;

export const PDF_INSPECT_SOURCE = String.raw`"""The PDF reader, sandbox side: describes a PDF's pages, text and pictures. One fixed command, no model-written code.

  python pdf_inspect.py inspect   job.json + source.pdf   -> pdf_inspect.zip

job.json: {"source": "source.pdf", "pages": [1, 2]}   (pages: all when absent)

A file that cannot be read still leaves its archive, holding only
refused.json: {"code": ..., "message": ...} (ENCRYPTED, DAMAGED).

CONVENTIONS (the DOCUMENT MODEL in documentModel.ts)
  - PAGES: page n is the PDF's nth page.
  - COORDINATES are points from the page's top-left corner.
  - A UNIT is one text block as the PDF lays it out (usually a paragraph or
    a heading); its runs are the block's spans, each with the font as the
    PDF names it (any subset prefix removed), its size, colour and weight.
    A unit's id is derived from its page and its place among the page's
    blocks, so it is stable for the same file.
  - PICTURES are the images placed on a page, each with every place it is
    drawn (one entry per placement) and its bytes once, by content hash.
"""
import hashlib
import json
import os
import sys
import zipfile

import fitz

OUTPUT_ARCHIVE = {'inspect': 'pdf_inspect.zip'}
MAX_IMAGES = 400
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_PAGES = 2000
BOLD_FLAG = 16
ITALIC_FLAG = 2
IMAGE_TYPES = {'png': 'image/png', 'jpeg': 'image/jpeg', 'jpg': 'image/jpeg', 'jpx': 'image/jp2',
               'gif': 'image/gif', 'bmp': 'image/bmp', 'tiff': 'image/tiff'}


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def font_name(raw):
    """A font's name without its subset prefix (ABCDEF+Calibri-Bold)."""
    name = raw or ''
    if len(name) > 7 and name[6] == '+' and name[:6].isalpha() and name[:6].isupper():
        name = name[7:]
    return name or None


def hex_color(value):
    if value is None:
        return None
    return '#%06x' % (int(value) & 0xFFFFFF)


def unit_id(page, index):
    return 'p' + hashlib.sha1(('%d#%d' % (page, index)).encode()).hexdigest()[:14]


def rounded(box):
    return [round(float(v), 2) for v in box]


def inspect(job, work):
    try:
        doc = fitz.open(os.path.join(work, job['source']))
    except Exception:  # noqa: BLE001 - any failure to open is damage
        raise Refusal('DAMAGED', 'The PDF is damaged: it could not be opened.')
    if doc.needs_pass:
        raise Refusal('ENCRYPTED', 'The PDF is password protected.')
    count = doc.page_count
    if count > MAX_PAGES:
        raise Refusal('TOO_LARGE', 'The PDF has more than %d pages.' % MAX_PAGES)
    wanted = sorted(set(int(p) for p in job.get('pages', []) if 1 <= int(p) <= count)) \
        or list(range(1, count + 1))
    pages, units, images, files = [], [], [], {}
    for number in wanted:
        page = doc[number - 1]
        rect = page.rect
        pages.append({'page': number, 'width': round(rect.width, 2), 'height': round(rect.height, 2)})
        text = page.get_text('dict')
        for index, block in enumerate(text.get('blocks', [])):
            if block.get('type') != 0:
                continue
            runs = []
            for line in block.get('lines', []):
                for span in line.get('spans', []):
                    if not span.get('text'):
                        continue
                    flags = int(span.get('flags', 0))
                    runs.append({
                        'text': span['text'],
                        'font': font_name(span.get('font')),
                        'size': round(float(span.get('size', 0)), 2),
                        'color': hex_color(span.get('color')),
                        'bold': bool(flags & BOLD_FLAG) or 'bold' in (span.get('font') or '').lower(),
                        'italic': bool(flags & ITALIC_FLAG),
                        'lang': None,
                    })
                if runs and not runs[-1]['text'].endswith(' '):
                    runs[-1]['text'] += ' '
            content = ''.join(run['text'] for run in runs).strip()
            if not content:
                continue
            if runs:
                runs[-1]['text'] = runs[-1]['text'].rstrip()
            units.append({'id': unit_id(number, index), 'page': number, 'kind': 'text',
                          'text': content, 'box': rounded(block['bbox']), 'runs': runs})
        seen = set()
        for info in page.get_images(full=True):
            if len(images) >= MAX_IMAGES:
                break
            xref = info[0]
            # An image drawn twice is listed twice; its places come at once.
            if xref in seen:
                continue
            seen.add(xref)
            try:
                extracted = doc.extract_image(xref)
            except Exception:  # noqa: BLE001 - an unreadable image is skipped
                continue
            data = extracted.get('image') or b''
            ext = (extracted.get('ext') or '').lower()
            # A picture's transparency is kept apart from it, as a soft mask
            # (info[1]); without it the transparent parts read as black and
            # the picture no longer looks like what is drawn. Joined here.
            if info[1]:
                try:
                    base = fitz.Pixmap(doc, xref)
                    if base.colorspace and base.colorspace.n > 3:
                        base = fitz.Pixmap(fitz.csRGB, base)
                    if base.alpha:
                        base = fitz.Pixmap(base, 0)
                    data = fitz.Pixmap(base, fitz.Pixmap(doc, info[1])).tobytes('png')
                    ext = 'png'
                except Exception:  # noqa: BLE001 - keep the picture without its mask
                    pass
            if not data or len(data) > MAX_IMAGE_BYTES or ext not in IMAGE_TYPES:
                continue
            digest = hashlib.sha256(data).hexdigest()
            file_name = 'images/%s.%s' % (digest[:32], ext)
            files[file_name] = data
            for place, box in enumerate(page.get_image_rects(xref) or [None]):
                images.append({
                    'id': 'i' + hashlib.sha1(('%d#%d#%d' % (number, xref, place)).encode()).hexdigest()[:14],
                    'page': number, 'box': rounded(box) if box is not None else None,
                    'name': info[7] if len(info) > 7 else None,
                    'sha256': digest, 'file': file_name, 'contentType': IMAGE_TYPES[ext],
                    'pixels': [extracted.get('width'), extracted.get('height')],
                    'inherited': None,
                })
    model = {'scheme': 1, 'format': 'pdf', 'pageCount': count, 'pages': pages,
             'units': units, 'images': images, 'theme': None}
    return model, files


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    work = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 2:
        work = os.path.abspath(sys.argv[2])
    if command not in OUTPUT_ARCHIVE:
        print('usage: pdf_inspect.py inspect [work dir]')
        sys.exit(2)
    archive = os.path.join(work, OUTPUT_ARCHIVE[command])
    with open(os.path.join(work, 'job.json'), encoding='utf-8') as handle:
        job = json.load(handle)
    try:
        model, files = inspect(job, work)
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
            out.writestr('model.json', json.dumps(model, ensure_ascii=False))
            for name, data in files.items():
                out.writestr(name, data)
        print('inspected %d units and %d pictures on %d pages'
              % (len(model['units']), len(model['images']), len(model['pages'])))
    except Refusal as refusal:
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
            out.writestr('refused.json', json.dumps({'code': refusal.code, 'message': refusal.message}))
        print('refused: %s: %s' % (refusal.code, refusal.message))


if __name__ == '__main__':
    main()
`;

/** The program as the sandbox runner takes it. */
export const PDF_INSPECT_SCRIPT: SandboxScript = {
  filename: PDF_INSPECT_FILENAME,
  source: PDF_INSPECT_SOURCE,
  archives: PDF_INSPECT_ARCHIVES,
  usageLabel: 'document-sandbox',
};
