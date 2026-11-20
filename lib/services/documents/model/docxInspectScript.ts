/**
 * The Word reader: the Python program that describes a .docx as written
 * (the DOCUMENT MODEL, documentModel.ts: every paragraph with its declared
 * fonts, sizes and colours, its pictures and its theme) inside the
 * code-interpreter sandbox, uploaded and run AS IS.
 *
 * It is Python kept in a TypeScript string so it ships inside the server
 * bundle; the raw template keeps its backslashes, so the text must never
 * contain a backtick or a dollar-brace sequence (its test checks). Its
 * conventions are stated once, in its own docstring.
 */
import type { SandboxScript } from '@/lib/services/documents/sandbox/sandboxScriptRunner';

/** Filename the program is uploaded under; the launch snippet looks for it. */
export const DOCX_INSPECT_FILENAME = 'docx_inspect.py';

/** Archive each command leaves beside the program, by command. */
export const DOCX_INSPECT_ARCHIVES = {
  inspect: 'docx_inspect.zip',
} as const;

export type DocxInspectCommand = keyof typeof DOCX_INSPECT_ARCHIVES;

export const DOCX_INSPECT_SOURCE = String.raw`"""The Word reader, sandbox side: describes a .docx as written. One fixed command, no model-written code.

  python docx_inspect.py inspect   job.json + source.docx   -> docx_inspect.zip

job.json: {"source": "source.docx"}

A file that cannot be read still leaves its archive, holding only
refused.json: {"code": ..., "message": ...} (ENCRYPTED, DAMAGED, TOO_LARGE).

CONVENTIONS (the DOCUMENT MODEL in documentModel.ts)
  - A Word document has no pages in its file: units carry no page or box
    here. The server places them on the pages of the document's PDF
    rendering (placeUnits in documentModel.ts).
  - A UNIT is one paragraph (w:p) of the body, a table cell, a header or a
    footer, in reading order. Its id is derived from its part and its
    place among the part's paragraphs, so it is stable for the same file.
  - RUNS carry the formatting as DECLARED, resolved most specific first:
    the run's own properties, its character style, its paragraph's style
    (with the styles each is based on), the document defaults, and the
    theme's fonts and colours for theme references. A colour of 'auto' is
    reported as none.
"""
import hashlib
import json
import os
import sys
import zipfile

from lxml import etree

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
W = '{%s}' % W_NS
A = '{%s}' % A_NS
R = '{%s}' % R_NS

OUTPUT_ARCHIVE = {'inspect': 'docx_inspect.zip'}
MAX_ENTRIES = 20000
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_XML_BYTES = 64 * 1024 * 1024
MAX_IMAGES = 400
MAX_IMAGE_BYTES = 20 * 1024 * 1024
DEFAULT_SIZE = 11.0
IMAGE_TYPES = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif',
               'bmp': 'image/bmp', 'tif': 'image/tiff', 'tiff': 'image/tiff', 'svg': 'image/svg+xml',
               'emf': 'image/emf', 'wmf': 'image/wmf'}
SCHEME_COLORS = ('dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4',
                 'accent5', 'accent6', 'hlink', 'folHlink')
# w:themeColor values to the theme's scheme names.
THEME_COLOR_NAMES = {'text1': 'dk1', 'dark1': 'dk1', 'background1': 'lt1', 'light1': 'lt1',
                     'text2': 'dk2', 'dark2': 'dk2', 'background2': 'lt2', 'light2': 'lt2',
                     'hyperlink': 'hlink', 'followedHyperlink': 'folHlink'}


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def parse_xml(data):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)
    if b'<!DOCTYPE' in data[:2048] or b'<!ENTITY' in data[:4096]:
        raise Refusal('DOCTYPE', 'The document declares a doctype, which is not allowed.')
    return etree.fromstring(data, parser)


def resolve(folder, target):
    parts = (target[1:].split('/') if target.startswith('/')
             else (folder.split('/') if folder else []) + target.split('/'))
    out = []
    for part in parts:
        if part == '..':
            if out:
                out.pop()
        elif part not in ('', '.'):
            out.append(part)
    return '/'.join(out)


class Package:
    def __init__(self, path):
        with open(path, 'rb') as handle:
            head = handle.read(8)
        if head.startswith(b'\xd0\xcf\x11\xe0'):
            raise Refusal('ENCRYPTED', 'The document is password protected or encrypted.')
        try:
            self.zip = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            raise Refusal('DAMAGED', 'The document is damaged: it is not a readable package.')
        infos = self.zip.infolist()
        if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_TOTAL_BYTES:
            raise Refusal('TOO_LARGE', 'The document is too large to read.')
        self.present = set(i.filename for i in infos)

    def has(self, name):
        return name in self.present

    def raw(self, name):
        if (name.endswith('.xml') or name.endswith('.rels')) and \
                self.zip.getinfo(name).file_size > MAX_XML_BYTES:
            raise Refusal('TOO_LARGE', 'The part %s is too large.' % name)
        return self.zip.read(name)

    def xml(self, name):
        return parse_xml(self.raw(name)) if self.has(name) else None

    def rels(self, name):
        folder, base = name.rsplit('/', 1) if '/' in name else ('', name)
        rels = self.xml((folder + '/' if folder else '') + '_rels/' + base + '.rels')
        found = {}
        for rel in (rels if rels is not None else []):
            external = rel.get('TargetMode') == 'External'
            target = rel.get('Target') or ''
            found[rel.get('Id')] = (rel.get('Type') or '', target if external else resolve(folder, target), external)
        return found


def on(el, name):
    """A w:b-like toggle: present without val, or val not false."""
    found = el.find(W + name) if el is not None else None
    if found is None:
        return None
    return found.get(W + 'val') not in ('0', 'false', 'off')


class Styles:
    """Style inheritance of a document (see RUNS in CONVENTIONS)."""

    def __init__(self, styles, theme):
        self.by_id = {}
        self.default_rpr = None
        self.default_paragraph = None
        if styles is not None:
            for style in styles.findall(W + 'style'):
                self.by_id[style.get(W + 'styleId')] = style
                if style.get(W + 'type') == 'paragraph' and style.get(W + 'default') in ('1', 'true'):
                    self.default_paragraph = style.get(W + 'styleId')
            defaults = styles.find(W + 'docDefaults/' + W + 'rPrDefault/' + W + 'rPr')
            self.default_rpr = defaults
        self.colors, self.fonts = {}, {'major': None, 'minor': None}
        if theme is not None:
            scheme = theme.find('.//' + A + 'clrScheme')
            for name in SCHEME_COLORS:
                el = scheme.find(A + name) if scheme is not None else None
                if el is not None and len(el):
                    value = el[0].get('val') if el[0].tag == A + 'srgbClr' else el[0].get('lastClr')
                    if value and len(value) == 6:
                        self.colors[name] = '#' + value.lower()
            for kind in ('major', 'minor'):
                latin = theme.find('.//' + A + kind + 'Font/' + A + 'latin')
                if latin is not None and latin.get('typeface'):
                    self.fonts[kind] = latin.get('typeface')

    def chain(self, style_id):
        """The rPr of a style and every style it is based on, nearest first."""
        found, seen = [], set()
        while style_id and style_id not in seen and style_id in self.by_id:
            seen.add(style_id)
            style = self.by_id[style_id]
            rpr = style.find(W + 'rPr')
            if rpr is not None:
                found.append(rpr)
            based = style.find(W + 'basedOn')
            style_id = based.get(W + 'val') if based is not None else None
        return found

    def resolved(self, run, paragraph):
        """The run's properties, most specific first (CONVENTIONS)."""
        layers = []
        rpr = run.find(W + 'rPr')
        if rpr is not None:
            layers.append(rpr)
            rstyle = rpr.find(W + 'rStyle')
            if rstyle is not None:
                layers += self.chain(rstyle.get(W + 'val'))
        ppr = paragraph.find(W + 'pPr')
        pstyle = ppr.find(W + 'pStyle') if ppr is not None else None
        layers += self.chain(pstyle.get(W + 'val') if pstyle is not None else self.default_paragraph)
        if self.default_rpr is not None:
            layers.append(self.default_rpr)
        return layers

    def font(self, layers):
        for rpr in layers:
            fonts = rpr.find(W + 'rFonts')
            if fonts is None:
                continue
            if fonts.get(W + 'ascii'):
                return fonts.get(W + 'ascii')
            theme = fonts.get(W + 'asciiTheme') or ''
            if theme.startswith('major'):
                return self.fonts['major']
            if theme.startswith('minor'):
                return self.fonts['minor']
        return self.fonts['minor']

    def size(self, layers):
        for rpr in layers:
            sz = rpr.find(W + 'sz')
            if sz is not None and (sz.get(W + 'val') or '').isdigit():
                return int(sz.get(W + 'val')) / 2.0
        return DEFAULT_SIZE

    def color(self, layers):
        for rpr in layers:
            color = rpr.find(W + 'color')
            if color is None:
                continue
            theme = color.get(W + 'themeColor')
            if theme:
                return self.colors.get(THEME_COLOR_NAMES.get(theme, theme))
            value = (color.get(W + 'val') or '').lower()
            if value == 'auto':
                return None
            if len(value) == 6:
                return '#' + value
        return None

    def toggle(self, layers, name):
        for rpr in layers:
            found = on(rpr, name)
            if found is not None:
                return found
        return False

    def lang(self, layers):
        for rpr in layers:
            lang = rpr.find(W + 'lang')
            if lang is not None and lang.get(W + 'val'):
                return lang.get(W + 'val')
        return None


def paragraph_runs(paragraph, styles):
    runs = []
    for run in paragraph.iter(W + 'r'):
        text = ''.join((t.text or '') if t.tag == W + 't' else ('\t' if t.tag == W + 'tab' else '\n')
                       for t in run if t.tag in (W + 't', W + 'tab', W + 'br'))
        if not text:
            continue
        layers = styles.resolved(run, paragraph)
        runs.append({'text': text, 'font': styles.font(layers), 'size': styles.size(layers),
                     'color': styles.color(layers), 'bold': styles.toggle(layers, 'b'),
                     'italic': styles.toggle(layers, 'i'), 'lang': styles.lang(layers)})
    return runs


def read_part(part, tree, kind, styles, units):
    body = tree.find(W + 'body') if tree.tag == W + 'document' else tree
    if body is None:
        return
    for index, paragraph in enumerate(body.iter(W + 'p')):
        runs = paragraph_runs(paragraph, styles)
        text = ''.join(run['text'] for run in runs).strip()
        if not text:
            continue
        in_table = any(ancestor.tag == W + 'tc' for ancestor in paragraph.iterancestors())
        units.append({
            'id': 'w' + hashlib.sha1(('%s#%d' % (part, index)).encode()).hexdigest()[:14],
            'page': None, 'kind': 'table' if in_table and kind == 'body' else kind,
            'text': text, 'box': None, 'runs': runs,
        })


def inspect(job, work):
    package = Package(os.path.join(work, job['source']))
    main = 'word/document.xml'
    if not package.has(main):
        raise Refusal('DAMAGED', 'The package has no document part.')
    rels = package.rels(main)
    theme_part = next((t for kind, t, ext in rels.values() if kind.endswith('/theme') and not ext), None)
    styles_part = next((t for kind, t, ext in rels.values() if kind.endswith('/styles') and not ext), None)
    styles = Styles(package.xml(styles_part) if styles_part else None,
                    package.xml(theme_part) if theme_part else None)
    units = []
    read_part(main, package.xml(main), 'body', styles, units)
    for kind, target, external in sorted(rels.values(), key=lambda rel: rel[1]):
        for name in ('header', 'footer'):
            if kind.endswith('/' + name) and not external and package.has(target):
                read_part(target, package.xml(target), name, styles, units)
    images, files = [], {}
    for rid, (kind, target, external) in rels.items():
        if external or not kind.endswith('/image') or not package.has(target) or len(images) >= MAX_IMAGES:
            continue
        if package.zip.getinfo(target).file_size > MAX_IMAGE_BYTES:
            continue
        ext = target.rsplit('.', 1)[-1].lower()
        if ext not in IMAGE_TYPES:
            continue
        data = package.raw(target)
        digest = hashlib.sha256(data).hexdigest()
        file_name = 'images/%s.%s' % (digest[:32], ext)
        files[file_name] = data
        images.append({'id': 'i' + hashlib.sha1(('%s#%s' % (main, rid)).encode()).hexdigest()[:14],
                       'page': None, 'box': None, 'name': target.rsplit('/', 1)[-1],
                       'sha256': digest, 'file': file_name, 'contentType': IMAGE_TYPES[ext],
                       'inherited': None})
    theme = {'colors': styles.colors, 'fonts': styles.fonts} if theme_part else None
    model = {'scheme': 1, 'format': 'docx', 'pageCount': 0, 'pages': [],
             'units': units, 'images': images, 'theme': theme}
    return model, files


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    work = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 2:
        work = os.path.abspath(sys.argv[2])
    if command not in OUTPUT_ARCHIVE:
        print('usage: docx_inspect.py inspect [work dir]')
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
        print('inspected %d units and %d pictures' % (len(model['units']), len(model['images'])))
    except Refusal as refusal:
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
            out.writestr('refused.json', json.dumps({'code': refusal.code, 'message': refusal.message}))
        print('refused: %s: %s' % (refusal.code, refusal.message))


if __name__ == '__main__':
    main()
`;

/** The program as the sandbox runner takes it. */
export const DOCX_INSPECT_SCRIPT: SandboxScript = {
  filename: DOCX_INSPECT_FILENAME,
  source: DOCX_INSPECT_SOURCE,
  archives: DOCX_INSPECT_ARCHIVES,
  usageLabel: 'document-sandbox',
};
