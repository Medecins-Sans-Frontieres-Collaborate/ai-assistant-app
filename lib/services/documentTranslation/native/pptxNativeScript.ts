/**
 * The Python program Preserve formatting runs inside the code interpreter
 * sandbox for presentations. Like the PDF script (pdfNativeScript.ts) it is
 * uploaded and executed AS IS: the sandbox model starts it and never writes
 * or changes deck code.
 *
 * It is kept in a TypeScript string so it ships inside the server bundle;
 * the raw template keeps its backslashes, so the text must never contain a
 * backtick or a dollar-brace sequence (the deck script test checks).
 *
 * Its conventions (pages, coordinates, what a unit is, locations, inline
 * tags, fit, which parts are written) are stated once, in its docstring.
 */
import { SandboxScript } from './sandboxScriptRunner';

/** Filename the script is uploaded under; the launch snippet looks for it. */
export const PPTX_NATIVE_SCRIPT_FILENAME = 'pptx_native.py';

/** Archive each command leaves beside the script, by command. */
export const PPTX_NATIVE_OUTPUT_ARCHIVE = {
  extract: 'native_deck_extract.zip',
  rebuild: 'native_deck_rebuild.zip',
} as const;

export type PptxNativeCommand = keyof typeof PPTX_NATIVE_OUTPUT_ARCHIVE;

export const PPTX_NATIVE_SCRIPT = String.raw`"""Native presentation translation, sandbox side. Two fixed commands, no model-written code.

  python pptx_native.py extract   job.json + source.pptx                  -> native_deck_extract.zip
  python pptx_native.py rebuild   job.json + source.pptx + units.json     -> native_deck_rebuild.zip

A command that refuses its input still leaves its archive, holding only
refused.json: {"code": ..., "message": ...}.

CONVENTIONS (stated once; everything below cites these)
  - PAGES: page n is slide n in presentation order (p:sldIdLst), hidden
    slides counted. Speaker notes and master/layout text belong to a page.
  - COORDINATES are points (EMU / 12700), origin at the slide's top left.
  - A UNIT is one paragraph (a:p), or one cached chart string (c:v). A
    paragraph is never merged or split: animations build by paragraph
    position. A unit's id is derived from its part and its place in it, so
    it is stable across runs of the same deck.
  - LOCATIONS: a unit's place is the path of child indices from its part's
    root. Every rebuild starts from the ORIGINAL deck, so paths stay valid.
  - INLINE TAGS: runs formatted unlike the paragraph's main formatting are
    wrapped in numbered tags <g1>...</g1>; fields (slide numbers, dates) and
    equations are tags too and are put back exactly as they were. Text is
    HTML-escaped around them.
  - WHERE WE MEASURE vs WHERE WE ACT: 'bbox' estimates where a paragraph's
    text sits; 'room' is the part of its text box it may use; 'box' is the
    text box (or cell) the fit is decided in. Fit is decided per text box:
    every paragraph of a box shrinks together (peers), never below
    MIN_SCALE; what still does not fit gets shrink-on-overflow and fits=false.
  - WRITTEN PARTS: only parts with a changed unit are serialized again; all
    other parts are copied unchanged. Namespace declarations (including the
    prefixes mc:Ignorable names) are kept as parsed.
"""
import copy
import hashlib
import html
import io
import json
import os
import re
import sys
import unicodedata
import zipfile

from lxml import etree

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
    'dgm': 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
    'dsp': 'http://schemas.microsoft.com/office/drawing/2008/diagram',
    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
}
A = '{%s}' % NS['a']
P = '{%s}' % NS['p']
R = '{%s}' % NS['r']
C = '{%s}' % NS['c']
DGM = '{%s}' % NS['dgm']
DSP = '{%s}' % NS['dsp']
MC = '{%s}' % NS['mc']
X = '{%s}' % NS['x']

EMU_PER_PT = 12700.0
OUTPUT_ARCHIVE = {'extract': 'native_deck_extract.zip', 'rebuild': 'native_deck_rebuild.zip'}

# Package limits: a deck past these is refused, not opened.
MAX_ENTRIES = 20000
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_XML_BYTES = 64 * 1024 * 1024
MAX_RATIO = 200          # compressed-to-uncompressed, for entries over RATIO_FLOOR
RATIO_FLOOR = 1024 * 1024

# Fit (see CONVENTIONS): the smallest share of its size a paragraph is set at.
MIN_SCALE = 0.7
SCALE_STEP = 0.025
FIT_EPSILON = 0.5        # points: a box authored to the point measures a hair over
LINE_HEIGHT = 1.2        # line pitch per point of font size

DEFAULT_SIZE = 18.0
DEFAULT_INSETS = (91440, 45720, 91440, 45720)   # l, t, r, b in EMU
DEFAULT_CELL_MARGINS = (91440, 45720, 91440, 45720)

TEXT_NAME_FACTOR = {
    # Average advance width relative to Arial (Liberation Sans) per family.
    'calibri': 0.9, 'carlito': 0.9, 'aptos': 0.96, 'arial': 1.0, 'helvetica': 1.0,
    'liberation sans': 1.0, 'segoe ui': 0.99, 'tahoma': 1.02, 'verdana': 1.13,
    'times new roman': 0.92, 'times': 0.92, 'cambria': 0.98, 'georgia': 1.04,
    'garamond': 0.88, 'century gothic': 1.12, 'trebuchet ms': 0.98, 'gill sans mt': 0.92,
    'arial narrow': 0.82, 'franklin gothic book': 0.96, 'consolas': 1.1, 'courier new': 1.2,
}

# Fonts for scripts a deck's own fonts usually lack, by target language.
SCRIPT_FONTS = {
    'ar': ('cs', 'Arial'), 'fa': ('cs', 'Arial'), 'ur': ('cs', 'Arial'), 'ps': ('cs', 'Arial'),
    'ckb': ('cs', 'Arial'), 'ku': ('cs', 'Arial'), 'he': ('cs', 'Arial'), 'yi': ('cs', 'Arial'),
    'hi': ('cs', 'Nirmala UI'), 'ne': ('cs', 'Nirmala UI'), 'mr': ('cs', 'Nirmala UI'),
    'bn': ('cs', 'Nirmala UI'), 'ta': ('cs', 'Nirmala UI'), 'te': ('cs', 'Nirmala UI'),
    'si': ('cs', 'Nirmala UI'), 'th': ('cs', 'Leelawadee UI'), 'km': ('cs', 'Khmer UI'),
    'my': ('cs', 'Myanmar Text'), 'am': ('cs', 'Nyala'), 'ti': ('cs', 'Nyala'),
    'zh': ('ea', 'Microsoft YaHei'), 'ja': ('ea', 'Yu Gothic'), 'ko': ('ea', 'Malgun Gothic'),
}
RTL_LANGUAGES = {'ar', 'fa', 'ur', 'ps', 'he', 'yi', 'ckb', 'ku', 'sd', 'ug', 'dv'}

# Order of children in a:rPr, a:pPr and p:spPr, so inserted elements are valid.
RPR_ORDER = ['ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill',
             'effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill',
             'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']
FILLS = {'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'}


class Refusal(Exception):
    """The input is not something this script will open; the reason is typed."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def local(el):
    tag = el.tag
    return tag.split('}', 1)[1] if isinstance(tag, str) and '}' in tag else tag


def emu(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def pt(value):
    return round(value / EMU_PER_PT, 2)


# ── package ──────────────────────────────────────────────────────────────

PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False,
                         huge_tree=False, remove_blank_text=False)


def parse_xml(data, name):
    head = data[:65536].upper()
    if b'<!DOCTYPE' in head or b'<!ENTITY' in head:
        raise Refusal('DOCTYPE', 'The part %s declares a document type, which is not allowed.' % name)
    try:
        return etree.fromstring(data, PARSER)
    except etree.XMLSyntaxError as error:
        raise Refusal('DAMAGED', 'The part %s is not well-formed XML (%s).' % (name, error))


def check_archive(zf, label):
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise Refusal('TOO_LARGE', '%s has too many parts.' % label)
    total = 0
    for info in infos:
        total += info.file_size
        if info.flag_bits & 0x1:
            raise Refusal('ENCRYPTED', '%s has encrypted parts.' % label)
        if info.file_size > RATIO_FLOOR and info.compress_size > 0 and \
                info.file_size / info.compress_size > MAX_RATIO:
            raise Refusal('ZIP_BOMB', '%s has a part that expands suspiciously far.' % label)
    if total > MAX_TOTAL_BYTES:
        raise Refusal('TOO_LARGE', '%s expands to more than allowed.' % label)


class Package:
    """An OPC package opened for reading, with parts replaced on save."""

    def __init__(self, path):
        with open(path, 'rb') as handle:
            head = handle.read(8)
        if head.startswith(b'\xd0\xcf\x11\xe0'):
            raise Refusal('ENCRYPTED', 'The presentation is password protected or encrypted.')
        try:
            self.zip = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            raise Refusal('DAMAGED', 'The presentation is damaged: it is not a readable package.')
        check_archive(self.zip, 'The presentation')
        self.names = [info.filename for info in self.zip.infolist()]
        self.present = set(self.names)
        self.trees = {}
        self.dirty = set()
        self.replaced = {}

    def has(self, name):
        return name in self.present

    def raw(self, name):
        info = self.zip.getinfo(name)
        if name.endswith('.xml') or name.endswith('.rels'):
            if info.file_size > MAX_XML_BYTES:
                raise Refusal('TOO_LARGE', 'The part %s is too large.' % name)
        return self.zip.read(name)

    def xml(self, name):
        if name not in self.trees:
            self.trees[name] = parse_xml(self.raw(name), name)
        return self.trees[name]

    def rels(self, name):
        """Relationship id to (type, absolute target, external) for a part."""
        folder, base = name.rsplit('/', 1) if '/' in name else ('', name)
        rels_name = (folder + '/' if folder else '') + '_rels/' + base + '.rels'
        found = {}
        if not self.has(rels_name):
            return found
        for rel in self.xml(rels_name):
            target = rel.get('Target') or ''
            external = rel.get('TargetMode') == 'External'
            if not external:
                target = resolve(folder, target)
            found[rel.get('Id')] = (rel.get('Type') or '', target, external)
        return found

    def related(self, name, kind):
        """Targets of a part's relationships whose type ends with /kind."""
        return [target for rtype, target, external in self.rels(name).values()
                if not external and rtype.endswith('/' + kind) and self.has(target)]

    def save(self, path):
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as out:
            for name in self.names:
                if name in self.dirty:
                    data = etree.tostring(self.trees[name], xml_declaration=True,
                                          encoding='UTF-8', standalone=True)
                elif name in self.replaced:
                    data = self.replaced[name]
                else:
                    data = self.zip.read(name)
                # A new entry record: writing must never change the source's.
                source = self.zip.getinfo(name)
                entry = zipfile.ZipInfo(name, date_time=source.date_time)
                entry.external_attr = source.external_attr
                out.writestr(entry, data, zipfile.ZIP_DEFLATED)


def resolve(folder, target):
    if target.startswith('/'):
        parts = target[1:].split('/')
    else:
        parts = (folder.split('/') if folder else []) + target.split('/')
    out = []
    for part in parts:
        if part == '..':
            if out:
                out.pop()
        elif part not in ('', '.'):
            out.append(part)
    return '/'.join(out)


def path_of(el):
    """Child indices from the root to an element (LOCATIONS)."""
    path = []
    while el.getparent() is not None:
        parent = el.getparent()
        path.append(parent.index(el))
        el = parent
    return list(reversed(path))


def at_path(root, path):
    el = root
    for index in path:
        el = el[index]
    return el


# ── deck structure ──────────────────────────────────────────────────────

class Deck:
    def __init__(self, package):
        self.pkg = package
        self.main = 'ppt/presentation.xml'
        if not package.has(self.main):
            raise Refusal('DAMAGED', 'The package has no presentation part.')
        pres = package.xml(self.main)
        rels = package.rels(self.main)
        self.slides = []
        lst = pres.find(P + 'sldIdLst')
        for sld in (lst if lst is not None else []):
            rel = rels.get(sld.get(R + 'id'))
            if rel and package.has(rel[1]):
                self.slides.append(rel[1])
        size = pres.find(P + 'sldSz')
        self.width = pt(emu(size.get('cx'), 9144000)) if size is not None else 720.0
        self.height = pt(emu(size.get('cy'), 6858000)) if size is not None else 540.0
        self.default_style = pres.find(P + 'defaultTextStyle')
        self.layout_of = {}
        self.master_of = {}
        self.themes = {}

    def layout(self, slide):
        if slide not in self.layout_of:
            found = self.pkg.related(slide, 'slideLayout')
            self.layout_of[slide] = found[0] if found else None
        return self.layout_of[slide]

    def master(self, layout):
        if layout is None:
            return None
        if layout not in self.master_of:
            found = self.pkg.related(layout, 'slideMaster')
            self.master_of[layout] = found[0] if found else None
        return self.master_of[layout]

    def theme(self, master):
        if master is None:
            return None
        if master not in self.themes:
            found = self.pkg.related(master, 'theme')
            self.themes[master] = self.pkg.xml(found[0]) if found else None
        return self.themes[master]

    def theme_fonts(self, master):
        theme = self.theme(master)
        fonts = {'major': 'Calibri Light', 'minor': 'Calibri'}
        if theme is not None:
            for kind in ('major', 'minor'):
                latin = theme.find('.//' + A + kind + 'Font/' + A + 'latin')
                if latin is not None and latin.get('typeface'):
                    fonts[kind] = latin.get('typeface')
        return fonts

    def scheme_color(self, master, name):
        theme = self.theme(master)
        if theme is None:
            return None
        aliases = {'tx1': 'dk1', 'tx2': 'dk2', 'bg1': 'lt1', 'bg2': 'lt2'}
        el = theme.find('.//' + A + 'clrScheme/' + A + aliases.get(name, name))
        if el is None or len(el) == 0:
            return None
        child = el[0]
        value = child.get('val') if local(child) == 'srgbClr' else child.get('lastClr')
        return ('#' + value.lower()) if value and len(value) == 6 else None


def placeholder(sp):
    nv = None
    for child in sp:
        if local(child).startswith('nv'):
            nv = child
    if nv is None:
        return None
    ph = nv.find(P + 'nvPr/' + P + 'ph')
    if ph is None:
        return None
    return {'type': ph.get('type', 'body'), 'idx': ph.get('idx')}


def find_placeholder(tree, ph):
    """The placeholder shape of a layout or master that a slide's placeholder inherits from."""
    if tree is None or ph is None:
        return None
    by_type = None
    want = {'ctrTitle': 'title', 'subTitle': 'body', 'obj': 'body'}.get(ph['type'], ph['type'])
    for sp in tree.iter(P + 'sp'):
        other = placeholder(sp)
        if other is None:
            continue
        if ph['idx'] is not None and other['idx'] == ph['idx']:
            return sp
        kind = {'ctrTitle': 'title', 'subTitle': 'body', 'obj': 'body'}.get(other['type'], other['type'])
        if by_type is None and kind == want:
            by_type = sp
    return by_type


def shape_xfrm(sp):
    sppr = sp.find(P + 'spPr')
    if sppr is None:
        return None
    xfrm = sppr.find(A + 'xfrm')
    if xfrm is None:
        return None
    off, ext = xfrm.find(A + 'off'), xfrm.find(A + 'ext')
    if off is None or ext is None:
        return None
    return (emu(off.get('x')), emu(off.get('y')), emu(ext.get('cx')), emu(ext.get('cy')),
            emu(xfrm.get('rot')))


class Transform:
    """Maps a group's child coordinates to slide EMU."""

    def __init__(self, ox=0.0, oy=0.0, sx=1.0, sy=1.0):
        self.ox, self.oy, self.sx, self.sy = ox, oy, sx, sy

    def apply(self, x, y, cx, cy):
        return (self.ox + x * self.sx, self.oy + y * self.sy, cx * self.sx, cy * self.sy)

    def child(self, grp):
        sppr = grp.find(P + 'grpSpPr')
        xfrm = sppr.find(A + 'xfrm') if sppr is not None else None
        if xfrm is None:
            return self
        off, ext = xfrm.find(A + 'off'), xfrm.find(A + 'ext')
        choff, chext = xfrm.find(A + 'chOff'), xfrm.find(A + 'chExt')
        if None in (off, ext, choff, chext):
            return self
        sx = emu(ext.get('cx')) / max(1, emu(chext.get('cx'), 1))
        sy = emu(ext.get('cy')) / max(1, emu(chext.get('cy'), 1))
        ox = emu(off.get('x')) - emu(choff.get('x')) * sx
        oy = emu(off.get('y')) - emu(choff.get('y')) * sy
        return Transform(self.ox + ox * self.sx, self.oy + oy * self.sy, self.sx * sx, self.sy * sy)


# ── text style inheritance ───────────────────────────────────────────────

def level_props(style, level):
    """a:lvlNpPr of a list style element (a:lstStyle, p:titleStyle, ...)."""
    if style is None:
        return None
    return style.find(A + 'lvl%dpPr' % (level + 1))


class StyleChain:
    """Where a paragraph's size, font and alignment come from, most specific first:
    run, paragraph, shape list style, layout placeholder, master placeholder,
    master text styles, presentation default."""

    def __init__(self, deck, master, styles, fonts):
        self.deck, self.master, self.styles, self.fonts = deck, master, styles, fonts

    def level(self, p):
        ppr = p.find(A + 'pPr')
        return min(8, emu(ppr.get('lvl'), 0)) if ppr is not None else 0

    def lookup(self, p, getter):
        lvl = self.level(p)
        ppr = p.find(A + 'pPr')
        if ppr is not None:
            found = getter(ppr, False)
            if found is not None:
                return found
        for style in self.styles:
            props = level_props(style, lvl)
            if props is not None:
                found = getter(props, True)
                if found is not None:
                    return found
        return None

    def size(self, p, rpr=None):
        if rpr is not None and rpr.get('sz'):
            return emu(rpr.get('sz')) / 100.0
        found = self.lookup(p, lambda el, lvl: (emu(el.find(A + 'defRPr').get('sz')) / 100.0)
                            if lvl and el.find(A + 'defRPr') is not None and el.find(A + 'defRPr').get('sz') else None)
        return found or DEFAULT_SIZE

    def font(self, p, rpr=None):
        def typeface(el):
            latin = el.find(A + 'latin') if el is not None else None
            return latin.get('typeface') if latin is not None else None
        face = typeface(rpr)
        if not face:
            face = self.lookup(p, lambda el, lvl: typeface(el.find(A + 'defRPr')) if lvl else None)
        if not face or face.startswith('+mn'):
            return self.fonts['minor']
        if face.startswith('+mj'):
            return self.fonts['major']
        return face

    def bold(self, p, rpr=None):
        if rpr is not None and rpr.get('b') is not None:
            return rpr.get('b') in ('1', 'true')
        found = self.lookup(p, lambda el, lvl: el.find(A + 'defRPr').get('b')
                            if lvl and el.find(A + 'defRPr') is not None else None)
        return found in ('1', 'true')

    def align(self, p):
        found = self.lookup(p, lambda el, lvl: el.get('algn'))
        return {'ctr': 'center', 'r': 'right', 'just': 'left', 'dist': 'left'}.get(found or 'l', 'left')

    def listed(self, p):
        def bullet(el, lvl):
            for child in el:
                name = local(child)
                if name == 'buNone':
                    return False
                if name in ('buChar', 'buAutoNum', 'buBlip'):
                    return True
            return None
        return bool(self.lookup(p, bullet))

    def color(self, p, rpr=None):
        def fill(el):
            if el is None:
                return None
            solid = el.find(A + 'solidFill')
            if solid is None or len(solid) == 0:
                return None
            child = solid[0]
            if local(child) == 'srgbClr' and child.get('val'):
                return '#' + child.get('val').lower()
            if local(child) == 'schemeClr':
                return self.deck.scheme_color(self.master, child.get('val'))
            return None
        found = fill(rpr)
        if found:
            return found
        return self.lookup(p, lambda el, lvl: fill(el.find(A + 'defRPr')) if lvl else None)


# ── measuring text ──────────────────────────────────────────────────────

class Widths:
    """Advance widths in ems. Uses Liberation Sans (Arial metrics) when the
    sandbox has it, scaled per family; a character-class estimate otherwise."""

    CANDIDATES = [
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    ]

    def __init__(self):
        self.table = None
        self.cache = {}
        try:
            from fontTools.ttLib import TTFont
            for candidate in self.CANDIDATES:
                if os.path.exists(candidate):
                    font = TTFont(candidate, lazy=True)
                    units = float(font['head'].unitsPerEm)
                    hmtx = font['hmtx']
                    self.table = {cp: hmtx[name][0] / units
                                  for cp, name in font.getBestCmap().items()}
                    break
        except Exception:
            self.table = None

    def char(self, ch):
        if ch in self.cache:
            return self.cache[ch]
        if unicodedata.combining(ch) or unicodedata.category(ch) in ('Mn', 'Me', 'Cf'):
            width = 0.0
        elif unicodedata.east_asian_width(ch) in ('W', 'F'):
            width = 1.0
        elif self.table is not None and ord(ch) in self.table:
            width = self.table[ord(ch)]
        elif ch == ' ':
            width = 0.278
        elif ch.isupper() or ch.isdigit():
            width = 0.62 if ch.isupper() else 0.556
        else:
            width = 0.52
        self.cache[ch] = width
        return width

    def text(self, text, size, family='', bold=False):
        factor = TEXT_NAME_FACTOR.get((family or '').lower(), 1.0) * (1.05 if bold else 1.0)
        return sum(self.char(ch) for ch in text) * size * factor


WIDTHS = None


def widths():
    global WIDTHS
    if WIDTHS is None:
        WIDTHS = Widths()
    return WIDTHS


def words_of(line):
    """Breakable pieces of a line: words with their trailing space; each wide character alone."""
    pieces, current = [], ''
    for ch in line:
        if unicodedata.east_asian_width(ch) in ('W', 'F'):
            if current:
                pieces.append(current)
                current = ''
            pieces.append(ch)
        else:
            current += ch
            if ch == ' ':
                pieces.append(current)
                current = ''
    if current:
        pieces.append(current)
    return pieces


def wrap(text, width, size, family, bold):
    """Lines a text takes in a box 'width' points wide, and its widest line."""
    lines, widest = 0, 0.0
    w = widths()
    for hard in (text.split('\n') or ['']):
        line = 0.0
        count = 1
        for piece in words_of(hard):
            piece_width = w.text(piece, size, family, bold)
            if line > 0 and line + w.text(piece.rstrip(' '), size, family, bold) > width + FIT_EPSILON:
                widest = max(widest, line)
                count += 1
                line = 0.0
            if w.text(piece.rstrip(' '), size, family, bold) > width + FIT_EPSILON:
                # A word wider than the box breaks between characters, as
                # PowerPoint breaks it.
                for ch in piece:
                    advance = w.text(ch, size, family, bold)
                    if line > 0 and line + advance > width + FIT_EPSILON and ch != ' ':
                        widest = max(widest, line)
                        count += 1
                        line = 0.0
                    line += advance
            else:
                line += piece_width
        widest = max(widest, line)
        lines += count
    return lines, min(widest, width)


TAG = re.compile(r'<(/?)(g\d+|b|i)>')


def visible(text):
    return html.unescape(TAG.sub('', text))


# ── reading units ────────────────────────────────────────────────────────

def rpr_key(rpr):
    if rpr is None:
        return ''
    clone = copy.deepcopy(rpr)
    for attr in ('lang', 'altLang', 'dirty', 'err', 'noProof', 'smtClean', 'smtId', 'bmk'):
        clone.attrib.pop(attr, None)
    return etree.tostring(clone, method='c14n')


def paragraph_items(p):
    """The paragraph's content children with their kind and visible text."""
    items = []
    for index, child in enumerate(p):
        name = local(child)
        if name == 'r':
            t = child.find(A + 't')
            items.append(('run', index, child, (t.text or '') if t is not None else ''))
        elif name == 'br':
            items.append(('br', index, child, '\n'))
        elif name == 'fld':
            t = child.find(A + 't')
            items.append(('keep', index, child, (t.text or '') if t is not None else ''))
        elif name in ('pPr', 'endParaRPr'):
            continue
        else:
            # Equations (a14:m in mc:AlternateContent) and anything unknown:
            # put back exactly as they were. Shown text: the first choice's.
            shown = child.find(MC + 'Choice') if child.tag == MC + 'AlternateContent' else None
            text = ''.join(t.text or '' for t in (shown if shown is not None else child).iter()
                           if local(t) == 't')
            items.append(('keep', index, child, text))
    return items


def tagged_text(p):
    """A paragraph's text with INLINE TAGS, and how to put each tag back."""
    items = paragraph_items(p)
    weight = {}
    linked = set()
    for kind, index, child, text in items:
        if kind == 'run':
            rpr = child.find(A + 'rPr')
            key = rpr_key(rpr)
            weight[key] = weight.get(key, 0) + len(text)
            if rpr is not None and rpr.find(A + 'hlinkClick') is not None:
                linked.add(key)
    # A linked run is never the paragraph's main formatting (unless all of
    # it is linked): untagged words of a translation would carry the link.
    plain = {key: chars for key, chars in weight.items() if key not in linked}
    pool = plain or weight
    base_key = max(pool, key=pool.get) if pool else None
    base_index = None
    tags, out, n = {}, [], 0
    current = None   # (tag, key) of the open run tag
    for kind, index, child, text in items:
        key = rpr_key(child.find(A + 'rPr')) if kind == 'run' else None
        if kind == 'run' and key == base_key:
            if base_index is None:
                base_index = index
        if current and (kind != 'run' or key != current[1]):
            out.append('</%s>' % current[0])
            current = None
        if kind == 'br':
            out.append('\n')
        elif kind == 'keep':
            n += 1
            name = 'g%d' % n
            tags[name] = {'kind': 'keep', 'child': index}
            out.append('<%s>%s</%s>' % (name, html.escape(text, quote=False), name))
        elif key == base_key:
            out.append(html.escape(text, quote=False))
        else:
            if current is None:
                n += 1
                name = 'g%d' % n
                tags[name] = {'kind': 'run', 'child': index}
                current = (name, key)
                out.append('<%s>' % name)
            out.append(html.escape(text, quote=False))
    if current:
        out.append('</%s>' % current[0])
    return ''.join(out), tags, base_index


def body_props(chain_bodies):
    """Insets, anchor and autofit of a text body, inherited through its placeholders."""
    props = {'insets': list(DEFAULT_INSETS), 'anchor': 't', 'autofit': 'none', 'vert': None}
    found = {'insets': [False] * 4, 'anchor': False, 'autofit': False, 'vert': False}
    for body in chain_bodies:
        if body is None:
            continue
        for i, attr in enumerate(('lIns', 'tIns', 'rIns', 'bIns')):
            if not found['insets'][i] and body.get(attr) is not None:
                props['insets'][i] = emu(body.get(attr))
                found['insets'][i] = True
        if not found['anchor'] and body.get('anchor'):
            props['anchor'] = body.get('anchor')
            found['anchor'] = True
        if not found['vert'] and body.get('vert'):
            props['vert'] = body.get('vert')
            found['vert'] = True
        if not found['autofit']:
            for child in body:
                if local(child) in ('spAutoFit', 'normAutofit', 'noAutofit'):
                    props['autofit'] = local(child)
                    found['autofit'] = True
    return props


class Extractor:
    def __init__(self, deck, notes):
        self.deck = deck
        self.notes = notes
        self.units = []
        self.counters = {}
        self.seen_parts = set()

    def next_n(self, page):
        self.counters[page] = self.counters.get(page, 0) + 1
        return self.counters[page]

    def unit_id(self, part, path):
        digest = hashlib.sha1(('%s#%s' % (part, '.'.join(map(str, path)))).encode()).hexdigest()
        return 'd' + digest[:14]

    def add_paragraphs(self, page, part, paragraphs, box, chain, body, kind, shape=None,
                       copies=None, extra=None):
        """Units of one text body. 'box' is (x, y, cx, cy) in slide EMU, or None for notes."""
        entries = []
        for p in paragraphs:
            text, tags, base = tagged_text(p)
            if not visible(text).strip():
                continue
            # A paragraph of nothing but fields and equations has nothing to translate.
            if not any(t['kind'] == 'run' for t in tags.values()) and not html.unescape(
                    TAG.sub('', re.sub(r'<(g\d+)>.*?</\1>', '', text))).strip():
                continue
            runs = [c for c in p if local(c) == 'r']
            first = runs[0].find(A + 'rPr') if runs else None
            base_rpr = p[base].find(A + 'rPr') if base is not None else first
            entries.append((p, text, tags, base, base_rpr))
        if not entries:
            return
        props = body_props(body) if body else None
        if box is not None:
            l, t, r, b = props['insets']
            inner = (box[0] + l, box[1] + t, max(1, box[2] - l - r), max(1, box[3] - t - b))
        else:
            inner = None
        measured = []
        for p, text, tags, base, base_rpr in entries:
            size = chain.size(p, base_rpr)
            family = chain.font(p, base_rpr)
            bold = chain.bold(p, base_rpr)
            if inner is not None:
                lines, used = wrap(visible(text), pt(inner[2]), size, family, bold)
            else:
                lines, used = len(visible(text).split('\n')), 0
            measured.append((size, family, bold, lines, used, size * LINE_HEIGHT * lines))
        total = sum(m[5] for m in measured)
        if inner is not None:
            free = pt(inner[3]) - total
            y = pt(inner[1])
            if props['anchor'] == 'ctr':
                y += max(0.0, free) / 2
            elif props['anchor'] == 'b':
                y += max(0.0, free)
            # WHERE WE MEASURE vs WHERE WE ACT: text tops stack by the
            # measured line heights; each room runs from its text's top to
            # the next paragraph's, the last one to the bottom of the box.
            tops = []
            for m in measured:
                tops.append(y)
                y += m[5]
            bottom = max(y, pt(inner[1] + inner[3]))
        for index, ((p, text, tags, base, base_rpr), (size, family, bold, lines, used, height)) in \
                enumerate(zip(entries, measured)):
            path = path_of(p)
            align = chain.align(p)
            unit = {
                'id': self.unit_id(part, path),
                'page': page,
                'n': 0,
                'text': text,
                'tags': {name: {'open': '', 'close': ''} for name in tags},
                'chars': len(visible(text)),
                'size': round(size, 2),
                'lines': lines,
                'align': align,
                'listed': chain.listed(p),
                'deck': {
                    'kind': kind, 'part': part, 'path': path, 'tags': tags, 'base': base,
                    'font': family, 'bold': bold,
                    'copies': copies.get(tuple(path), []) if copies else [],
                },
            }
            color = chain.color(p, base_rpr)
            if color:
                unit['color'] = color
            if inner is not None:
                x0, x1 = pt(inner[0]), pt(inner[0] + inner[2])
                if align == 'center':
                    left = (x0 + x1 - used) / 2
                elif align == 'right':
                    left = x1 - used
                else:
                    left = x0
                y = tops[index]
                room_bottom = tops[index + 1] if index + 1 < len(tops) else bottom
                room_height = max(height, room_bottom - y)
                unit['bbox'] = [round(left, 2), round(y, 2), round(left + used, 2), round(y + height, 2)]
                unit['room'] = [round(x0, 2), round(y, 2), round(x1, 2), round(y + room_height, 2)]
                unit['panel'] = [pt(box[0]), pt(box[1]), pt(box[0] + box[2]), pt(box[1] + box[3])]
                area = max(1.0, used * height)
                unit['roomFactor'] = round(((x1 - x0) * room_height) / area, 3)
                if props['anchor'] == 'ctr':
                    unit['valign'] = 'middle'
                if props['vert'] in ('vert', 'eaVert'):
                    unit['rotate'] = 270
                elif props['vert'] == 'vert270':
                    unit['rotate'] = 90
                unit['deck']['box'] = [pt(inner[0]), pt(inner[1]), pt(inner[2]), pt(inner[3])]
                unit['deck']['autofit'] = props['autofit']
            else:
                unit['bbox'] = [0, 0, 0, 0]
                unit['room'] = [0, 0, 0, 0]
                unit['roomFactor'] = 2
                unit['deck']['notes'] = True
            if shape is not None:
                unit['peer'] = shape['key']
                unit['deck']['shape'] = shape
            if extra:
                unit['deck'].update(extra)
            self.units.append(unit)

    # Shapes ---------------------------------------------------------------

    def walk(self, page, part, container, transform, chain_for, kind, copies=None):
        for child in container:
            name = local(child)
            if name == 'sp':
                self.shape(page, part, child, transform, chain_for, kind, copies)
            elif name == 'grpSp':
                self.walk(page, part, child, transform.child(child), chain_for, kind, copies)
            elif name == 'graphicFrame':
                self.frame(page, part, child, transform, chain_for, kind)
            elif name == 'AlternateContent' and child.tag == MC + 'AlternateContent':
                self.alternate(page, part, child, transform, chain_for, kind)

    def alternate(self, page, part, block, transform, chain_for, kind):
        choice = block.find(MC + 'Choice')
        fallback = block.find(MC + 'Fallback')
        if choice is None:
            if fallback is not None:
                self.walk(page, part, fallback, transform, chain_for, kind)
            return
        # The fallback copy shows the same text to older readers: its
        # paragraphs, in order, get the same translations as the choice's.
        copies = dict(copies_map(choice, fallback)) if fallback is not None else {}
        self.walk(page, part, choice, transform, chain_for, kind, copies)

    def shape(self, page, part, sp, transform, chain_for, kind, copies=None):
        body = sp.find(P + 'txBody')
        if body is None:
            return
        ph = placeholder(sp)
        if kind in ('layout', 'master') and ph is not None:
            return  # placeholder prompts are never seen in a finished deck
        chain, layout_sp, master_sp = chain_for(sp, ph)
        geometry = shape_xfrm(sp) or (layout_sp is not None and shape_xfrm(layout_sp)) or \
            (master_sp is not None and shape_xfrm(master_sp)) or None
        box = None
        if geometry:
            box = transform.apply(*geometry[:4])
        bodies = [body.find(A + 'bodyPr')]
        for inherited in (layout_sp, master_sp):
            if inherited is not None and inherited.find(P + 'txBody') is not None:
                bodies.append(inherited.find(P + 'txBody').find(A + 'bodyPr'))
        shape = {'key': '%s:%s' % (part, '.'.join(map(str, path_of(sp)))),
                 'part': part, 'path': path_of(sp), 'sx': transform.sx, 'sy': transform.sy,
                 'inherit': list(geometry[:4]) if geometry and not shape_xfrm(sp) else None}
        self.add_paragraphs(page, part, body.findall(A + 'p'), box, chain, bodies, kind,
                            shape=shape, copies=copies)

    def frame(self, page, part, frame, transform, chain_for, kind):
        xfrm = frame.find(P + 'xfrm')
        box = None
        if xfrm is not None and xfrm.find(A + 'off') is not None and xfrm.find(A + 'ext') is not None:
            off, ext = xfrm.find(A + 'off'), xfrm.find(A + 'ext')
            box = transform.apply(emu(off.get('x')), emu(off.get('y')), emu(ext.get('cx')), emu(ext.get('cy')))
        data = frame.find(A + 'graphic/' + A + 'graphicData')
        if data is None or box is None:
            return
        uri = data.get('uri') or ''
        chain, _, _ = chain_for(frame, None)
        if uri.endswith('/table'):
            table = data.find(A + 'tbl')
            if table is not None:
                self.table(page, part, table, box, chain, kind)
        elif uri.endswith('/chart'):
            ref = data.find(C + 'chart')
            target = self.deck.pkg.rels(part).get(ref.get(R + 'id')) if ref is not None else None
            if target and self.deck.pkg.has(target[1]):
                self.chart(page, target[1], box, chain)
        elif uri.endswith('/diagram'):
            ids = data.find(DGM + 'relIds')
            if ids is not None:
                self.diagram(page, part, ids, box, chain)

    def table(self, page, part, table, box, chain, kind):
        grid = [emu(col.get('w')) for col in table.findall(A + 'tblGrid/' + A + 'gridCol')]
        y = box[1]
        sx = box[2] / max(1, sum(grid)) if grid else 1
        for row in table.findall(A + 'tr'):
            height = emu(row.get('h'))
            x = box[0]
            for col, cell in enumerate(row.findall(A + 'tc')):
                width = sum(grid[col:col + emu(cell.get('gridSpan'), 1)]) * sx
                if cell.get('hMerge') in ('1', 'true') or cell.get('vMerge') in ('1', 'true'):
                    x += grid[col] * sx if col < len(grid) else 0
                    continue
                span = emu(cell.get('rowSpan'), 1)
                body = cell.find(A + 'txBody')
                if body is not None:
                    tcpr = cell.find(A + 'tcPr')
                    margins = list(DEFAULT_CELL_MARGINS)
                    for i, attr in enumerate(('marL', 'marT', 'marR', 'marB')):
                        if tcpr is not None and tcpr.get(attr) is not None:
                            margins[i] = emu(tcpr.get(attr))
                    fake = etree.Element(A + 'bodyPr', lIns=str(margins[0]), tIns=str(margins[1]),
                                         rIns=str(margins[2]), bIns=str(margins[3]),
                                         anchor={'ctr': 'ctr', 'b': 'b'}.get(
                                             tcpr.get('anchor') if tcpr is not None else 't', 't'))
                    cell_box = (x, y, width, height * span)
                    shape = {'key': '%s:%s' % (part, '.'.join(map(str, path_of(cell)))),
                             'part': part, 'path': path_of(cell), 'cell': True}
                    self.add_paragraphs(page, part, body.findall(A + 'p'), cell_box, chain, [fake],
                                        'table', shape=shape, extra={'table': path_of(table)})
                x += width
            y += height

    def chart(self, page, part, box, chain):
        if part in self.seen_parts:
            return
        self.seen_parts.add(part)
        tree = self.deck.pkg.xml(part)
        for rich in tree.iter(C + 'rich'):
            self.add_paragraphs(page, part, rich.findall(A + 'p'), None, chain, None, 'chart',
                                extra={'notes': False, 'chart': True})
        # Series names and category labels: their cached strings.
        seen_values = {}
        for cache in tree.iter(C + 'strCache'):
            for v in cache.iter(C + 'v'):
                text = v.text or ''
                if not text.strip():
                    continue
                path = path_of(v)
                same = seen_values.get(text)
                if same is not None:
                    same['deck']['copies'].append({'part': part, 'path': path})
                    continue
                unit = {
                    'id': self.unit_id(part, path), 'page': page, 'n': 0,
                    'text': html.escape(text, quote=False), 'tags': {}, 'chars': len(text),
                    'size': 10.0, 'lines': 1, 'bbox': [0, 0, 0, 0], 'room': [0, 0, 0, 0],
                    'roomFactor': 2,
                    'deck': {'kind': 'value', 'part': part, 'path': path, 'tags': {}, 'copies': [],
                             'chart': True},
                }
                seen_values[text] = unit
                self.units.append(unit)
        for unit in self.units:
            if unit['deck'].get('chart') and unit['deck']['part'] == part:
                unit['bbox'] = [pt(box[0]), pt(box[1]), pt(box[0] + box[2]), pt(box[1] + box[3])]
                unit['room'] = list(unit['bbox'])
                unit['deck']['fixed'] = True

    def diagram(self, page, part, ids, box, chain):
        rels = self.deck.pkg.rels(part)
        data = rels.get(ids.get(R + 'dm'))
        if not data or not self.deck.pkg.has(data[1]) or data[1] in self.seen_parts:
            return
        self.seen_parts.add(data[1])
        tree = self.deck.pkg.xml(data[1])
        # The cached drawing (what PowerPoint shows until it lays the diagram
        # out again) holds the same text, shape by shape: found by model id.
        drawing = None
        for ext in tree.iter():
            if local(ext) == 'dataModelExt' and ext.get('relId'):
                target = rels.get(ext.get('relId'))
                if target and self.deck.pkg.has(target[1]):
                    drawing = target[1]
        drawn = {}
        if drawing:
            for sp in self.deck.pkg.xml(drawing).iter(DSP + 'sp'):
                if sp.get('modelId'):
                    drawn[sp.get('modelId')] = sp
        for pt_el in tree.iter(DGM + 'pt'):
            body = pt_el.find(DGM + 't')
            if body is None:
                continue
            copies = {}
            geometry = box
            sp = drawn.get(pt_el.get('modelId'))
            if sp is not None:
                drawn_body = sp.find(DSP + 'txBody')
                if drawn_body is not None:
                    mine = body.findall(A + 'p')
                    theirs = drawn_body.findall(A + 'p')
                    if len(mine) == len(theirs):
                        for a_p, b_p in zip(mine, theirs):
                            copies[tuple(path_of(a_p))] = [{'part': drawing, 'path': path_of(b_p)}]
                xfrm = sp.find(DSP + 'spPr/' + A + 'xfrm')
                if xfrm is not None and xfrm.find(A + 'off') is not None:
                    off, ext = xfrm.find(A + 'off'), xfrm.find(A + 'ext')
                    geometry = (box[0] + emu(off.get('x')), box[1] + emu(off.get('y')),
                                emu(ext.get('cx')), emu(ext.get('cy')))
            self.add_paragraphs(page, data[1], body.findall(A + 'p'), geometry, chain,
                                [body.find(A + 'bodyPr')], 'diagram', copies=copies,
                                extra={'fixed': True})

    # Slides ---------------------------------------------------------------

    def slide(self, page, part, first_layout, first_master):
        deck = self.deck
        layout = deck.layout(part)
        master = deck.master(layout)
        layout_tree = deck.pkg.xml(layout) if layout else None
        master_tree = deck.pkg.xml(master) if master else None
        fonts = deck.theme_fonts(master)
        tx = master_tree.find(P + 'txStyles') if master_tree is not None else None
        theme = deck.theme(master)
        object_defaults = theme.find('.//' + A + 'objectDefaults/' + A + 'txDef/' + A + 'lstStyle') \
            if theme is not None else None

        def chain_for(sp, ph):
            body = sp.find(P + 'txBody')
            styles = [body.find(A + 'lstStyle')] if body is not None else []
            layout_sp = find_placeholder(layout_tree, ph) if ph else None
            master_sp = find_placeholder(master_tree, ph) if ph else None
            for inherited in (layout_sp, master_sp):
                if inherited is not None and inherited.find(P + 'txBody') is not None:
                    styles.append(inherited.find(P + 'txBody').find(A + 'lstStyle'))
            if ph and tx is not None:
                styles.append(tx.find(P + ('titleStyle' if ph['type'] in ('title', 'ctrTitle') else 'bodyStyle')))
            elif tx is not None:
                styles.append(object_defaults)
                styles.append(tx.find(P + 'otherStyle'))
            styles.append(deck.default_style)
            return StyleChain(deck, master, [s for s in styles if s is not None], fonts), layout_sp, master_sp

        tree = deck.pkg.xml(part)
        tree_root = tree.find(P + 'cSld/' + P + 'spTree')
        if tree_root is not None:
            self.walk(page, part, tree_root, Transform(), chain_for, 'slide')
        # Master and layout text a person sees on every slide using them:
        # read once, with the first slide of the deck that shows it.
        for owner, owner_tree, first in ((layout, layout_tree, first_layout), (master, master_tree, first_master)):
            if owner and owner_tree is not None and first.get(owner) == page:
                root = owner_tree.find(P + 'cSld/' + P + 'spTree')
                if root is not None:
                    self.walk(page, owner, root, Transform(), chain_for,
                              'layout' if owner == layout else 'master')
        if self.notes:
            notes = deck.pkg.related(part, 'notesSlide')
            if notes:
                notes_tree = deck.pkg.xml(notes[0])
                for sp in notes_tree.iter(P + 'sp'):
                    ph = placeholder(sp)
                    if ph is None or ph['type'] != 'body' or sp.find(P + 'txBody') is None:
                        continue
                    chain = StyleChain(deck, master, [deck.default_style] if deck.default_style is not None else [], fonts)
                    self.add_paragraphs(page, notes[0], sp.find(P + 'txBody').findall(A + 'p'), None,
                                        chain, None, 'notes')


def copies_map(choice, fallback):
    """Choice paragraph (by path) to the matching fallback paragraphs, by shape id and order."""
    def shapes(root):
        found = {}
        for el in root.iter():
            if local(el) == 'cNvPr' and el.get('id'):
                holder = el.getparent().getparent()
                found[el.get('id')] = holder
        return found
    theirs = shapes(fallback)
    for shape_id, holder in shapes(choice).items():
        other = theirs.get(shape_id)
        if other is None:
            continue
        mine = holder.findall('.//' + A + 'p')
        their = other.findall('.//' + A + 'p')
        if len(mine) != len(their):
            continue
        for a_p, b_p in zip(mine, their):
            yield tuple(path_of(a_p)), [{'part': None, 'path': path_of(b_p)}]


def first_slides(deck):
    """Layout and master parts to the first page that uses them."""
    layouts, masters = {}, {}
    for page, part in enumerate(deck.slides, start=1):
        layout = deck.layout(part)
        master = deck.master(layout)
        if layout and layout not in layouts:
            layouts[layout] = page
        if master and master not in masters:
            masters[master] = page
    return layouts, masters


def extract(job, work):
    package = Package(os.path.join(work, job['source']))
    deck = Deck(package)
    wanted = sorted(set(int(p) for p in job.get('pages', [])
                        if 1 <= int(p) <= len(deck.slides))) or list(range(1, len(deck.slides) + 1))
    extractor = Extractor(deck, bool(job.get('notes', True)))
    first_layout, first_master = first_slides(deck)
    for page in wanted:
        extractor.slide(page, deck.slides[page - 1], first_layout, first_master)
    # Fallback copies were recorded without their part: it is the unit's own.
    for unit in extractor.units:
        for copy_ref in unit['deck']['copies']:
            if copy_ref['part'] is None:
                copy_ref['part'] = unit['deck']['part']
    # n labels the units drawn on a page; notes and chart strings come after.
    by_page = {}
    for unit in extractor.units:
        by_page.setdefault(unit['page'], []).append(unit)
    for page, units in by_page.items():
        drawn = [u for u in units if not u['deck'].get('notes') and u['deck']['kind'] != 'value']
        rest = [u for u in units if u not in drawn]
        for n, unit in enumerate(drawn + rest, start=1):
            unit['n'] = n
    pages = []
    for page in wanted:
        units = by_page.get(page, [])
        sld = deck.pkg.xml(deck.slides[page - 1])
        pages.append({
            'page': page, 'width': deck.width, 'height': deck.height,
            'units': len(units), 'textChars': sum(u['chars'] for u in units),
            'scanned': False, 'hidden': sld.get('show') in ('0', 'false'),
        })
    return {'pageCount': len(deck.slides), 'pages': pages,
            'units': [u for page in wanted for u in by_page.get(page, [])]}


# ── rebuilding ─────────────────────────────────────────────────────────

def insert_ordered(parent, child, order):
    """Inserts 'child' into 'parent' where 'order' says it belongs."""
    name = local(child)
    rank = order.index(name) if name in order else len(order)
    for index, existing in enumerate(parent):
        other = local(existing)
        if other in order and order.index(other) > rank:
            parent.insert(index, child)
            return child
    parent.append(child)
    return child


def parse_tagged(text):
    """A translation's pieces: (tag or None, plain text). Unknown and nested tags flatten."""
    pieces, stack, pos = [], [], 0
    for match in TAG.finditer(text):
        if match.start() > pos:
            pieces.append((stack[-1] if stack else None, html.unescape(text[pos:match.start()])))
        closing, name = match.group(1) == '/', match.group(2)
        if name.startswith('g'):
            if closing:
                if name in stack:
                    stack.remove(name)
            else:
                stack.append(name)
        pos = match.end()
    if pos < len(text):
        pieces.append((stack[-1] if stack else None, html.unescape(text[pos:])))
    return pieces


class Rebuilder:
    def __init__(self, package, units, job):
        self.pkg = package
        self.units = units
        self.translations = job.get('translations') or {}
        self.styles = job.get('styles') or {}
        language = (job.get('language') or '').strip()
        self.language = language
        primary = language.split('-')[0].lower()
        self.rtl = bool(job.get('rtl', primary in RTL_LANGUAGES))
        self.script_font = SCRIPT_FONTS.get(primary)
        self.min_scale = float(job.get('minScale', MIN_SCALE))
        self.fits = []
        self.kept = []
        self.workbook_strings = {}   # chart part -> {source: translation}

    def element(self, ref):
        return at_path(self.pkg.xml(ref['part']), ref['path'])

    def mark(self, part):
        self.pkg.dirty.add(part)

    def run(self):
        by_part = {}
        for unit in self.units:
            text = self.translations.get(unit['id'])
            style = self.styles.get(unit['id'])
            if (text is None or text == unit['text']) and not style:
                continue
            by_part.setdefault(unit['deck']['part'], []).append(unit)
        written = {}
        for part, units in by_part.items():
            # A part that cannot be written safely stays as it was and its
            # units are reported as kept (not translated).
            snapshot = {name: copy.deepcopy(tree) for name, tree in self.pkg.trees.items()
                        if name == part or any(c['part'] == name for u in units for c in u['deck']['copies'])}
            try:
                for unit in units:
                    self.write_unit(unit)
                written[part] = units
            except Exception as error:  # noqa: BLE001 - reported per unit
                for name, tree in snapshot.items():
                    self.pkg.trees[name] = tree
                    self.pkg.dirty.discard(name)
                for unit in units:
                    self.kept.append({'id': unit['id'], 'reason': str(error)[:200]})
        self.update_workbooks()
        self.fit_and_style()
        self.right_to_left_tables()
        return written

    # Text -----------------------------------------------------------------

    def write_unit(self, unit):
        text = self.translations.get(unit['id'])
        if text is None or text == unit['text']:
            return
        deck = unit['deck']
        if deck['kind'] == 'value':
            for ref in [{'part': deck['part'], 'path': deck['path']}] + deck['copies']:
                v = self.element(ref)
                if local(v) != 'v':
                    raise ValueError('a chart string moved')
                source = v.text or ''
                v.text = visible(text)
                self.mark(ref['part'])
                self.workbook_strings.setdefault(deck['part'], {})[source] = v.text
            return
        for ref in [{'part': deck['part'], 'path': deck['path']}] + deck['copies']:
            p = self.element(ref)
            if local(p) != 'p':
                raise ValueError('a paragraph moved')
            self.write_paragraph(p, deck, text)
            self.mark(ref['part'])

    def write_paragraph(self, p, deck, text):
        original = list(p)
        children = {index: child for index, child in enumerate(original)}

        def rpr_from(index):
            child = children.get(index) if index is not None else None
            rpr = child.find(A + 'rPr') if child is not None else None
            if rpr is None:
                end = p.find(A + 'endParaRPr')
                rpr = etree.Element(A + 'rPr', attrib=dict(end.attrib)) if end is not None else etree.Element(A + 'rPr')
                if end is not None:
                    for sub in end:
                        rpr.append(copy.deepcopy(sub))
            return copy.deepcopy(rpr)

        base = rpr_from(deck.get('base'))
        new = []
        placed = set()
        for tag, piece in parse_tagged(text):
            info = deck['tags'].get(tag) if tag else None
            if info and info['kind'] == 'keep':
                if tag not in placed:
                    placed.add(tag)
                    new.append(copy.deepcopy(children[info['child']]))
                continue
            rpr = rpr_from(info['child']) if info else copy.deepcopy(base)
            for i, line in enumerate(piece.split('\n')):
                if i > 0:
                    br = etree.Element(A + 'br')
                    br.append(copy.deepcopy(rpr))
                    new.append(br)
                if line:
                    r = etree.Element(A + 'r')
                    r.append(copy.deepcopy(rpr))
                    t = etree.SubElement(r, A + 't')
                    t.text = line
                    new.append(r)
        # Kept elements the translation dropped are put back at the end:
        # a field or an equation is never lost.
        for name, info in deck['tags'].items():
            if info['kind'] == 'keep' and name not in placed:
                new.append(copy.deepcopy(children[info['child']]))
        ppr = p.find(A + 'pPr')
        end = p.find(A + 'endParaRPr')
        for child in original:
            if child is not ppr and child is not end:
                p.remove(child)
        position = 1 if ppr is not None else 0
        for offset, child in enumerate(new):
            p.insert(position + offset, child)
        for rpr in [c.find(A + 'rPr') for c in new if local(c) in ('r', 'br')] + ([end] if end is not None else []):
            if rpr is None:
                continue
            self.mark_language(rpr)
        if self.rtl:
            if ppr is None:
                ppr = etree.Element(A + 'pPr')
                p.insert(0, ppr)
            ppr.set('rtl', '1')
            if ppr.get('algn') in (None, 'l'):
                ppr.set('algn', 'r')

    def mark_language(self, rpr):
        if self.language:
            rpr.set('lang', self.language)
        for attr in ('err', 'dirty', 'smtClean'):
            rpr.attrib.pop(attr, None)
        if self.script_font:
            slot, face = self.script_font
            if rpr.find(A + slot) is None:
                insert_ordered(rpr, etree.Element(A + slot, typeface=face), RPR_ORDER)

    def update_workbooks(self):
        """Chart strings changed in a chart's embedded workbook too."""
        for part, strings in self.workbook_strings.items():
            for rtype, target, external in self.pkg.rels(part).values():
                if external or not rtype.endswith('/package') or not self.pkg.has(target):
                    continue
                try:
                    self.pkg.replaced[target] = rewrite_workbook(self.pkg.raw(target), strings)
                except Refusal:
                    raise
                except Exception:
                    continue  # the chart shows its cached strings; the workbook stays

    # Fit and the person's styles ----------------------------------------------------------------

    def fit_and_style(self):
        bodies = {}
        for unit in self.units:
            if unit['deck'].get('box') and not unit['deck'].get('fixed'):
                bodies.setdefault(unit['deck']['shape']['key'] if unit['deck'].get('shape') else unit['id'],
                                  []).append(unit)
        reported = set()
        for key, units in bodies.items():
            self.fit_body(units)
            reported.update(u['id'] for u in units)
        for unit in self.units:
            if unit['id'] not in reported:
                self.fits.append({'id': unit['id'], 'page': unit['page'], 'n': unit['n'],
                                  'scale': 1, 'fits': True})
        moved = set()
        for unit in self.units:
            style = self.styles.get(unit['id']) or {}
            if style.get('color'):
                self.recolor(unit, style['color'])
            if (style.get('dx') or style.get('dy')) and unit['deck'].get('shape'):
                shape = unit['deck']['shape']
                if shape['key'] not in moved and not shape.get('cell'):
                    moved.add(shape['key'])
                    self.move(shape, float(style.get('dx') or 0), float(style.get('dy') or 0))

    def unit_height(self, unit, size):
        text = visible(self.translations.get(unit['id']) or unit['text'])
        deck = unit['deck']
        lines, used = wrap(text, deck['box'][2], size, deck.get('font'), deck.get('bold'))
        return lines * size * LINE_HEIGHT, used

    def fit_body(self, units):
        kept_ids = {k['id'] for k in self.kept}
        box = units[0]['deck']['box']
        sizes = {}
        for unit in units:
            style = self.styles.get(unit['id']) or {}
            sizes[unit['id']] = float(style['size']) if style.get('size') else unit['size']
        translated = any(self.translations.get(u['id']) not in (None, u['text']) and u['id'] not in kept_ids
                         for u in units)

        def total(scale):
            return sum(self.unit_height(u, sizes[u['id']] * scale)[0] for u in units)

        scale, fits = 1.0, True
        autofit = units[0]['deck'].get('autofit')
        if translated and autofit != 'spAutoFit' and total(1.0) > box[3] + FIT_EPSILON:
            scale = 1.0
            while scale - SCALE_STEP >= self.min_scale - 1e-9 and total(scale) > box[3] + FIT_EPSILON:
                scale = round(scale - SCALE_STEP, 4)
            fits = total(scale) <= box[3] + FIT_EPSILON
        for unit in units:
            factor = (sizes[unit['id']] / unit['size']) * scale if unit['size'] else scale
            if abs(factor - 1) > 1e-6 and unit['id'] not in kept_ids:
                self.resize(unit, factor)
            height, used = self.unit_height(unit, sizes[unit['id']] * scale)
            left, top = unit['room'][0], unit['room'][1]
            self.fits.append({'id': unit['id'], 'page': unit['page'], 'n': unit['n'],
                              'scale': round(scale, 3), 'fits': fits,
                              'used': [round(left, 2), round(top, 2), round(left + used, 2), round(top + height, 2)]})
        if not fits:
            self.shrink_on_overflow(units[0])

    def paragraphs_of(self, unit):
        deck = unit['deck']
        return [self.element(ref) for ref in [{'part': deck['part'], 'path': deck['path']}] + deck['copies']]

    def resize(self, unit, factor):
        for p in self.paragraphs_of(unit):
            for child in p:
                if local(child) not in ('r', 'br', 'fld', 'endParaRPr'):
                    continue
                rpr = child if local(child) == 'endParaRPr' else child.find(A + 'rPr')
                if rpr is None:
                    rpr = etree.Element(A + 'rPr')
                    child.insert(0, rpr)
                current = emu(rpr.get('sz'), 0) / 100.0 or unit['size']
                rpr.set('sz', str(max(100, int(round(current * factor * 100)))))
        self.mark(unit['deck']['part'])
        for ref in unit['deck']['copies']:
            self.mark(ref['part'])

    def recolor(self, unit, color):
        value = color.lstrip('#').upper()
        if not re.fullmatch(r'[0-9A-F]{6}', value):
            return
        for p in self.paragraphs_of(unit):
            for child in p:
                if local(child) not in ('r', 'br', 'fld'):
                    continue
                rpr = child.find(A + 'rPr')
                if rpr is None:
                    rpr = etree.Element(A + 'rPr')
                    child.insert(0, rpr)
                for existing in list(rpr):
                    if local(existing) in FILLS:
                        rpr.remove(existing)
                fill = etree.Element(A + 'solidFill')
                etree.SubElement(fill, A + 'srgbClr', val=value)
                insert_ordered(rpr, fill, RPR_ORDER)
        self.mark(unit['deck']['part'])

    def move(self, shape, dx, dy):
        """Moves a whole shape by (dx, dy) points (a move is never for one paragraph)."""
        sp = at_path(self.pkg.xml(shape['part']), shape['path'])
        sppr = sp.find(P + 'spPr')
        if sppr is None:
            return
        xfrm = sppr.find(A + 'xfrm')
        if xfrm is None:
            if not shape.get('inherit'):
                return
            x, y, cx, cy = shape['inherit']
            xfrm = etree.Element(A + 'xfrm')
            etree.SubElement(xfrm, A + 'off', x=str(int(x)), y=str(int(y)))
            etree.SubElement(xfrm, A + 'ext', cx=str(int(cx)), cy=str(int(cy)))
            sppr.insert(0, xfrm)
        off = xfrm.find(A + 'off')
        off.set('x', str(int(emu(off.get('x')) + dx * EMU_PER_PT / max(1e-9, shape.get('sx', 1)))))
        off.set('y', str(int(emu(off.get('y')) + dy * EMU_PER_PT / max(1e-9, shape.get('sy', 1)))))
        self.mark(shape['part'])

    def shrink_on_overflow(self, unit):
        p = self.element({'part': unit['deck']['part'], 'path': unit['deck']['path']})
        body = p.getparent()
        body_pr = body.find(A + 'bodyPr') if body is not None else None
        if body_pr is None:
            return
        for child in list(body_pr):
            if local(child) in ('spAutoFit', 'normAutofit', 'noAutofit'):
                body_pr.remove(child)
        # After prstTxWarp / before scene3d: autofit sits right after any text warp.
        warp = body_pr.find(A + 'prstTxWarp')
        position = (body_pr.index(warp) + 1) if warp is not None else 0
        body_pr.insert(position, etree.Element(A + 'normAutofit'))
        self.mark(unit['deck']['part'])

    def right_to_left_tables(self):
        if not self.rtl:
            return
        tables = set()
        for unit in self.units:
            if unit['deck'].get('table') and self.translations.get(unit['id']) not in (None, unit['text']):
                tables.add((unit['deck']['part'], tuple(unit['deck']['table'])))
        for part, path in tables:
            table = at_path(self.pkg.xml(part), list(path))
            props = table.find(A + 'tblPr')
            if props is None:
                props = etree.Element(A + 'tblPr')
                table.insert(0, props)
            props.set('rtl', '1')
            self.mark(part)


def rewrite_workbook(data, strings):
    """An embedded workbook with its shared and inline strings translated."""
    source = zipfile.ZipFile(io.BytesIO(data))
    check_archive(source, 'An embedded workbook')
    out_buffer = io.BytesIO()
    with zipfile.ZipFile(out_buffer, 'w', zipfile.ZIP_DEFLATED) as out:
        for info in source.infolist():
            content = source.read(info.filename)
            if info.filename == 'xl/sharedStrings.xml' or (
                    info.filename.startswith('xl/worksheets/') and info.filename.endswith('.xml')):
                tree = parse_xml(content, info.filename)
                changed = False
                holders = tree.iter(X + 'si') if info.filename.endswith('sharedStrings.xml') else tree.iter(X + 'is')
                for holder in list(holders):
                    text = ''.join(t.text or '' for t in holder.iter(X + 't'))
                    if text in strings:
                        for child in list(holder):
                            holder.remove(child)
                        t = etree.SubElement(holder, X + 't')
                        t.text = strings[text]
                        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                        changed = True
                if changed:
                    content = etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True)
            entry = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            out.writestr(entry, content, zipfile.ZIP_DEFLATED)
    return out_buffer.getvalue()


def rebuild(job, work):
    package = Package(os.path.join(work, job['source']))
    with open(os.path.join(work, job['units']), encoding='utf-8') as handle:
        extraction = json.load(handle)
    units = [u for u in extraction.get('units', []) if isinstance(u, dict) and u.get('deck')]
    builder = Rebuilder(package, units, job)
    builder.run()
    deck = Deck(package)
    fonts = deck.theme_fonts(deck.master(deck.layout(deck.slides[0]))) if deck.slides else \
        {'minor': 'Calibri', 'major': 'Calibri Light'}
    out_path = os.path.join(work, 'translated.pptx')
    package.save(out_path)
    return out_path, {
        'fonts': {'sans': fonts['minor'], 'serif': fonts['major']},
        'units': [dict(fit, **({'kept': True} if fit['id'] in {k['id'] for k in builder.kept} else {}))
                  for fit in builder.fits],
        'kept': builder.kept,
        'written': sorted(package.dirty | set(package.replaced)),
    }


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    work = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 2:
        work = os.path.abspath(sys.argv[2])
    if command not in OUTPUT_ARCHIVE:
        print('usage: pptx_native.py extract|rebuild [work dir]')
        sys.exit(2)
    archive = os.path.join(work, OUTPUT_ARCHIVE[command])
    with open(os.path.join(work, 'job.json'), encoding='utf-8') as handle:
        job = json.load(handle)
    try:
        if command == 'extract':
            payload = extract(job, work)
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
                out.writestr('units.json', json.dumps(payload, ensure_ascii=False))
            print('extracted %d units on %d pages' % (len(payload['units']), len(payload['pages'])))
        else:
            out_path, report = rebuild(job, work)
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
                out.write(out_path, 'translated.pptx')
                out.writestr('report.json', json.dumps(report, ensure_ascii=False))
            print('rebuilt: %d parts written, %d units kept' % (len(report['written']), len(report['kept'])))
    except Refusal as refusal:
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
            out.writestr('refused.json', json.dumps({'code': refusal.code, 'message': refusal.message}))
        print('refused: %s: %s' % (refusal.code, refusal.message))


if __name__ == '__main__':
    main()
`;

/** The deck script as the sandbox runner takes it. */
export const DECK_SANDBOX_SCRIPT: SandboxScript = {
  filename: PPTX_NATIVE_SCRIPT_FILENAME,
  source: PPTX_NATIVE_SCRIPT,
  archives: PPTX_NATIVE_OUTPUT_ARCHIVE,
};
