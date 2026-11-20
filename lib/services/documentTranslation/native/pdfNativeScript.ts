/**
 * The Python program the native PDF translation pipeline runs inside the code
 * interpreter sandbox. It is uploaded and executed AS IS on every run: the
 * sandbox model is told to start it, never to write or change PDF code, so
 * two runs on the same input take the same path.
 *
 * It is Python kept in a TypeScript string (not a .py file read from disk) so
 * it ships inside the server bundle with no file-tracing configuration. The
 * raw template keeps its backslashes; the text must therefore never contain
 * a backtick or a dollar-brace sequence.
 *
 * Its conventions (coordinates, page numbering, what a unit is, measured box
 * versus layout room, inline tags) are stated once, in its own docstring.
 */

/** Filename the script is uploaded under; the launch snippet looks for it. */
export const PDF_NATIVE_SCRIPT_FILENAME = 'pdf_native.py';

/** Archive each command leaves beside the script, by command. */
export const PDF_NATIVE_OUTPUT_ARCHIVE = {
  extract: 'native_extract.zip',
  rebuild: 'native_rebuild.zip',
} as const;

export type PdfNativeCommand = keyof typeof PDF_NATIVE_OUTPUT_ARCHIVE;

export const PDF_NATIVE_SCRIPT = String.raw`"""Native PDF translation, sandbox side. Two fixed commands, no model-written code.

  python pdf_native.py extract   job.json + source.pdf            -> native_extract.zip
  python pdf_native.py rebuild   job.json + source.pdf + units    -> native_rebuild.zip
                                 (with 'slides' in the job, the zip also holds translated.pptx)

CONVENTIONS (stated once; everything below cites these)
  - Coordinates are PDF points, origin top-left, as PyMuPDF reports them.
  - Page numbers are 1-based everywhere a human or the pipeline sees them.
  - A unit is the smallest thing translated and refitted as one piece: a
    paragraph, or a single line when lines do not stack into a paragraph.
  - WHERE WE MEASURE vs WHERE WE ACT: a unit's 'bbox' is where its source ink
    was measured; 'room' is the larger box its translation may be laid out in.
    They are derived separately and never used for each other's purpose.
  - Inline formatting travels as numbered tags (<g1>..</g1>); bold and italic
    stay literal (<b>, <i>). 'tags' maps each numbered tag back to its HTML.
  - STYLE OVERRIDES: a rebuild job may carry 'styles', unit id -> any of 'size' (points),
    'color' ('#rrggbb'), 'dx' and 'dy' (points; +x is right, +y is down, as the coordinates
    above). They change how and where the TRANSLATION is laid out (see styled_room); the
    source text is still removed from where it was measured. A size applies to the whole
    unit: parts set in another size keep their proportion to it. A colour applies to the
    unit's main text: links and parts set in their own colour keep it.
  - PANELS: a filled or outlined shape that a unit sits inside (a card, a table cell, a
    coloured box) is the unit's 'panel'. A room never reaches outside its unit's panel
    (see assign_room): free space beyond a panel's edge belongs to something else.
  - CLEAR SPACE: a room grows only across space that looks empty. The page is drawn without
    its text and scanned outward from the unit, a whole line of pixels at a time; growth
    stops at the first line that differs from the one before it (a rule, a box's edge, a
    picture). See clear_extent. This holds for shapes that are pictures, which PANELS cannot see.
  - PEERS: units of one page set in the same font size, weight, slant and colour (the items
    of a list, the headings of a row of cards) are peers ('peer' names the group). When the
    layout has to shrink some of them, all are set at the smallest of those sizes, so a list
    never mixes sizes; a unit that would need to go below PEER_MIN_SCALE is left to itself
    and reported, so the pipeline rewords it instead. A unit given its own size by a style
    is no longer anyone's peer.
  - READING DIRECTION: a translation most of whose letters are of a right-to-left script
    (Arabic, Hebrew) is set right to left, so its numbers, brackets and full stops fall
    where they should. The page itself is not mirrored: a unit keeps the left edge the
    source had, beside whatever it belongs to (its bullet, its box), and is made as wide as
    its longest line needs, within its room; its lines are flush right inside that. A
    paragraph that fills its column is therefore set from the column's right edge. See
    reads_right_to_left.
  - FONTS: text is set in the first preferred family that has every character of the
    translation; when none has, in the first one installed, with the layout engine's own
    fonts standing in for the characters that family lacks (Chinese, Devanagari, Thai and
    so on). A rebuild fails only when a character can be drawn by neither. See
    choose_fonts.
  - HYPHENATION: a word is only ever divided as a last resort. A unit whose translation
    would be set below HYPHENATE_BELOW of its size, and that comes out larger with its
    words divided, is set hyphenated by the rules of the job's 'language' (an IETF tag).
    Without a language, or with one the layout engine has no rules for, nothing is
    divided. See command_rebuild.
  - ALIGNMENT: 'align' is 'left', 'center' or 'right', read from the source: stacked lines
    that share a centre or a right edge instead of a left one, or a single line sitting in
    the middle of its panel, or the single lines of a table column's cells (see CELLS) that
    share a centre with each other or with the column's heading but not a left edge. A
    centred unit's room is centred on the same axis, so the translation stays in the middle
    however long it is. See line_alignment, align_columns and assign_room.
    Text extraction puts each line of a centred stack (a two-line heading in a box) in a
    block of its own; such lines, set in one style, are one unit. See join_centred_stacks.
  - CELLS: a unit with something drawn the same distance above and below it (the rules of a
    table row, the edges of a box) sits in the middle of a cell. Its 'valign' is 'middle',
    its room is the cell's whole height, kept centred on the source text, and as wide as
    the space beside it allows (a cell is a column, whatever its text filled), and its
    translation is centred in that room, so a shorter translation does not rise to the top
    and a longer one may use the space above as well as below. See cell_span.
  - DIRECTION: 'rotate' is how far a unit's text is turned, counter-clockwise, in degrees:
    absent for text running left to right, 90 for text running up the page, 180 for text
    upside down, 270 for text running down the page. A turned unit is one line; its room
    runs along its direction, inside its panel when it has one, and its translation is
    set turned the same way. Text at any other angle is left in place. See quarter_turn
    and assign_turned_room.
  - BREAKS: a line break inside a unit's text ('\n') is one the author made: a line left
    short on purpose, as between the facts of a stacked list, not a line that only
    wrapped. Writers that keep the space or hyphen a line wrapped at tell the two apart:
    there, a line that ends in neither was broken on purpose. A document is read that
    way only while more than MARKED_WRAPS of its line ends carry one; in any other
    document every line end is a wrap. A translation keeps its breaks, and is set with
    them. A unit at least STACK_SHARE of whose line ends are breaks is a stack: its
    other line ends are breaks too (a space typed before a break looks like a wrap),
    and a line below it at the same edge, size and pitch is part of it. See build_unit,
    join_wrapped_lines and settle_breaks.
  - LEFT IN PLACE: text that is not a unit is never touched and a room never runs over it:
    amounts and page numbers, text at an angle that is not a quarter turn (see
    DIRECTION), and the bullet a list item starts with. A bullet also starts a new unit, so the
    lines of one item, which share a left edge once the bullet is set aside, are one
    paragraph. See upright and list_items.
  - SLIDES: a rebuild job with 'slides' set also writes the result as a presentation, for
    refining by hand: one slide for each page of the PDF, the page without the text that
    was translated as the slide's background, and each translated unit as a text box of
    its own, in the place, size, colour, alignment and direction the layout gave it. So
    the text can be edited and nothing else can: shapes, pictures and the text LEFT IN
    PLACE are the background. A page with no translation is its own picture. The notes
    of a slide hold the source text of its units. Fonts are named, not embedded: the
    families every office program has (SLIDE_SANS, SLIDE_SERIF), which have the widths of
    the fonts the PDF is set in. See write_slides.
  - Nothing is ever painted over the page: source text is removed from the
    content stream, so there is no cover-up rectangle to show through.
  - GLYPH PICTURES: some exporters (PowerPoint, when it may not embed a font) draw a run of
    text as a picture instead: a few pixels of one flat colour shown through a mask in the
    shape of the letters, with the real text laid over it fully transparent in a stand-in
    font. What a reader sees is then the picture, so for such a run the picture is the
    source: its colour is the text's colour, the mask's ink is where the text is (a span's
    'bbox'), and removing the run means removing the picture too (a unit's 'pictures').
    The transparent text only says what the letters are, and where the text layer to remove
    is (a unit's 'spanRects'). Its line and block structure follows the stand-in font's
    widths, not the page, so lines are put together again from the ink, and a line that
    only wrapped is put back with the paragraph it continues. See glyph_pictures,
    read_pictured_text, join_wrapped_lines and remove_pictures.
"""
import collections, html, io, json, os, re, subprocess, sys, unicodedata, zipfile
from html.parser import HTMLParser

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
LINE_BREAK = '\x00'       # stands for a line break while a unit's text is put together
LINE_WRAP = '\x01'        # stands for a line end that carries a space, until the unit is known to be a stack or not
ICON_FONT = re.compile(r'fontawesome|symbol|dingbat|wingding|icon|glyph|material', re.I)
BULLET = re.compile(r'^[\u2022\u2023\u25e6\u25aa\u25ab\u25cf\u25cb\u25a0\u25a1\u2219\u00b7\u27a2\u2043]$')
SERIF_FONT = re.compile(r'times|serif|roman|georgia|garamond|minion|cambria|palatino|nimbusrom|cmr', re.I)
PREVIEW_DPI = 100
PAGE_IMAGE_DPI = 144      # the page image a person looks at, and zooms into
GAP = 2.0                 # points kept clear between a unit's room and its neighbour
MIN_SCALE = 0.5           # the layout engine will not shrink text below this
SAME_LEFT_EDGE = 3.0      # lines within this many points share a paragraph's left edge
UNDERLINE_MAX_HEIGHT = 1.5
MAX_GROWTH = 0.35         # share of its own height a unit's room may extend downward
PANEL_MAX_SHARE = 0.9     # a filled shape covering more of the page than this is its background
PANEL_MAX_INSET = 8.0     # most that a room is kept clear of its panel's edge, in points
PANEL_TOLERANCE = 1.0     # a unit this far outside a shape's side edge still counts as inside it
PANEL_LINE_SLACK = 0.25   # share of its font size a unit's box may stick out above or below its panel
EDGE_CONTRAST = 18        # channel difference (0-255) between neighbouring pixels that makes an edge
EDGE_SHARE = 0.08         # share of a scanned line that must change for it to count as an edge
CENTRED_SHARE = 0.06      # a line's two insets in its panel may differ by this share of the panel's width
PEER_SIZE_TOLERANCE = 0.3 # font sizes this close, in points, are the same size
HYPHENATE_BELOW = 0.85    # a unit shrunk past this share of its size is tried with its words hyphenated
HYPHENATE_GAIN = 0.02     # and is set that way when its scale improves by at least this much
PEER_MIN_SCALE = 0.85     # peers are set at one size only while that keeps each at this share of its own
FLAT_PICTURE_PIXELS = 4   # an image no larger than this on each side can only be a flat colour
PICTURE_MATCH = 0.5       # points within which two boxes are the same picture placement
RUN_ORIGIN_SLACK = 1.5    # points a transparent run may start outside the picture that draws it
BASELINE_BAND = (0.6, 1.0)  # shares of a glyph picture's height between which its text's baseline lies
WRAP_MAX_PITCH = 1.35     # a line further below the last than this many font sizes starts a new paragraph
STACK_MAX_PITCH = 1.5     # centred lines further apart than this many font sizes are not one heading
WORD_GAP = 0.2            # ink of two runs closer than this share of the font size has no space between
RAISED = 0.2              # smaller text whose baseline is this share of the line's size above it is superscript
CELL_REACH = 8.0          # font sizes above and below a unit within which a cell's edges are looked for
CELL_BALANCE = 0.35       # share of the font size by which the space above and below a centred unit may differ
HEADING_MARGIN = 1.0      # points by which a heading's centre must match its column's better than its left edge does
TURNED_LINE = 1.3         # font sizes of room a turned line gets across its direction
BULLET_REACH = 4.0        # a bullet this many font sizes left of a line, on that line, is the line's own
SAME_LINE_OVERLAP = 0.5   # share of the shorter of two runs that must overlap vertically to share a line
STACK_SHARE = 0.5         # share of a unit's line ends that must be breaks for all of them to be
MARKED_WRAPS = 0.5        # share of line ends that must carry a space or hyphen for one without to be a break
EMU_PER_POINT = 12700     # a presentation's unit of length
SLIDE_DPI = 150           # resolution of the page picture behind a slide
SLIDE_PNG_MAX_BYTES = 400_000  # a page picture larger than this as PNG is stored as JPEG if that is smaller
SLIDE_JPEG_QUALITY = 88
SLIDE_SANS, SLIDE_SERIF = 'Arial', 'Times New Roman'
# The proofing language of a presentation's text is a language WITH a region ('fr-FR');
# office programs do not all accept a bare 'fr'. The usual region of each language we
# may be given; a language not listed here is left unmarked, which is always accepted.
SLIDE_LANGUAGES = {
    'af': 'af-ZA', 'am': 'am-ET', 'ar': 'ar-SA', 'bg': 'bg-BG', 'bn': 'bn-IN', 'ca': 'ca-ES', 'cs': 'cs-CZ',
    'da': 'da-DK', 'de': 'de-DE', 'el': 'el-GR', 'en': 'en-US', 'es': 'es-ES', 'et': 'et-EE', 'fa': 'fa-IR',
    'fi': 'fi-FI', 'fr': 'fr-FR', 'he': 'he-IL', 'hi': 'hi-IN', 'hr': 'hr-HR', 'hu': 'hu-HU', 'id': 'id-ID',
    'it': 'it-IT', 'ja': 'ja-JP', 'ko': 'ko-KR', 'lt': 'lt-LT', 'lv': 'lv-LV', 'ms': 'ms-MY', 'nb': 'nb-NO',
    'nl': 'nl-NL', 'pl': 'pl-PL', 'pt': 'pt-PT', 'ro': 'ro-RO', 'ru': 'ru-RU', 'sk': 'sk-SK', 'sl': 'sl-SI',
    'sr': 'sr-Latn-RS', 'sv': 'sv-SE', 'sw': 'sw-KE', 'ta': 'ta-IN', 'te': 'te-IN', 'th': 'th-TH', 'tr': 'tr-TR',
    'uk': 'uk-UA', 'ur': 'ur-PK', 'vi': 'vi-VN', 'zh': 'zh-CN',
}
NORMAL_LEADING = 1.2      # line pitch, in font sizes, that a presentation calls 100% line spacing
SAME_LINE_GAP = 0.6       # runs closer than this share of their font size, side by side, are one line


def load_job():
    with open(os.path.join(HERE, 'job.json'), encoding='utf-8') as handle:
        return json.load(handle)


def span_style(span):
    name = span['font'].lower()
    return {
        'bold': any(k in name for k in ('bold', 'semibold', 'black', 'heavy')) or bool(span['flags'] & 16),
        'italic': 'italic' in name or 'oblique' in name or bool(span['flags'] & 2),
        'color': '#%06x' % span['color'],
    }


CONTENT_TOKEN = re.compile(
    rb'%[^\r\n]*|<<|>>|<[0-9A-Fa-f\s]*>|[\[\]{}]|/[^\s()<>\[\]{}/%]*|[^\s()<>\[\]{}/%]+')


def drawn_images(page):
    """Every image a page's own content draws: {'name', 'matrix' (PDF space, six numbers),
    'xref' (the content stream), 'start', 'end' (the bytes of the instruction drawing it)}.

    Read from the content itself, tracking the saved and changed coordinate systems: asking
    the library which image sits where pairs images by what they look like, and glyph
    pictures of one colour all look the same until masked.
    """
    doc, found = page.parent, []
    ctm, saved = fitz.Matrix(1, 1), []
    for xref in page.get_contents():
        data = doc.xref_stream(xref) or b''
        operands, at, size = [], 0, len(data)
        while at < size:
            if data[at:at + 1] == b'(':
                # A text string: runs to its matching bracket, escapes aside.
                depth, at = 1, at + 1
                while at < size and depth:
                    ch = data[at:at + 1]
                    at += 2 if ch == b'\\' else 1
                    depth += 1 if ch == b'(' else -1 if ch == b')' else 0
                operands.append((None, at, at))
                continue
            match = CONTENT_TOKEN.match(data, at)
            if not match:
                at += 1
                continue
            token, start, at = match.group(), match.start(), match.end()
            first = token[:1]
            if first == b'%':
                continue
            if first in b'/<[]{}>+-.0123456789' and token not in (b'[', b']'):
                operands.append((token, start, at))
                continue
            if token in (b'[', b']'):
                continue
            if token == b'q':
                saved.append(fitz.Matrix(ctm))
            elif token == b'Q' and saved:
                ctm = saved.pop()
            elif token == b'cm' and len(operands) >= 6:
                try:
                    ctm = fitz.Matrix(*[float(value) for value, _, _ in operands[-6:]]) * ctm
                except (TypeError, ValueError):
                    pass
            elif token == b'Do' and operands and (operands[-1][0] or b'')[:1] == b'/':
                found.append({'name': operands[-1][0][1:].decode('latin-1'), 'matrix': tuple(ctm),
                              'xref': xref, 'start': operands[-1][1], 'end': at})
            elif token == b'BI':
                # An inline image: its data is not instructions.
                closing = re.compile(rb'\sEI(?=\s|$)').search(data, at)
                at = closing.end() if closing else size
            operands = []
    return found


def glyph_pictures(page):
    """The pictures on a page that draw text (see GLYPH PICTURES), one per placement.

    Each is {'rect': the placement, 'ink': the part of it the mask actually paints,
    'color': '#rrggbb', 'turned': it is placed on its side (see DIRECTION), 'drawn': its
    entry from drawn_images}. Only images the page draws itself, upright or at a quarter
    turn, are returned: those are the ones remove_pictures can take out.
    """
    doc, flat, masks = page.parent, {}, {}
    for item in page.get_images(full=True):
        xref, mask, width, height, name, referencer = item[0], item[1], item[2], item[3], item[7], item[9]
        if mask and not referencer and max(width, height) <= FLAT_PICTURE_PIXELS:
            flat[name] = {'xref': xref, 'mask': mask}
    found = []
    to_page = page.transformation_matrix * page.rotation_matrix
    for drawn in drawn_images(page) if flat else []:
        entry = flat.get(drawn['name'])
        a, b, c, d, e, f = drawn['matrix']
        upright_image = abs(b) < 1e-3 and abs(c) < 1e-3
        if entry is None or not (upright_image or (abs(a) < 1e-3 and abs(d) < 1e-3)):
            continue
        if 'color' not in entry:
            entry['color'] = flat_colour(doc, entry['xref'])
        if entry['color'] is None:
            continue
        if entry['mask'] not in masks:
            masks[entry['mask']] = mask_ink(doc, entry['mask'])
        ink = masks[entry['mask']]
        if ink is None:
            continue
        placed = fitz.Matrix(a, b, c, d, e, f) * to_page
        def on_page(left, top, right, bottom):
            # An image fills the unit square, its top row along y = 1.
            p, q = fitz.Point(left, 1 - top) * placed, fitz.Point(right, 1 - bottom) * placed
            return fitz.Rect(min(p.x, q.x), min(p.y, q.y), max(p.x, q.x), max(p.y, q.y))
        found.append({'rect': on_page(0, 0, 1, 1), 'ink': on_page(*ink), 'color': entry['color'],
                      'turned': not upright_image, 'drawn': drawn})
    return found


def flat_colour(doc, xref):
    """'#rrggbb' of an image that is one colour throughout, else None."""
    try:
        pix = fitz.Pixmap(doc, xref)
        if pix.colorspace is None or pix.colorspace.n != 3 or pix.alpha:
            pix = fitz.Pixmap(fitz.csRGB, fitz.Pixmap(pix, 0) if pix.alpha else pix)
    except Exception:
        return None
    pixels = {pix.pixel(x, y)[:3] for x in range(pix.width) for y in range(pix.height)}
    return '#%02x%02x%02x' % next(iter(pixels)) if len(pixels) == 1 else None


def mask_ink(doc, xref):
    """The part of a mask that paints anything, as shares of its width and height
    (left, top, right, bottom), or None for a mask that paints nothing."""
    try:
        pix = fitz.Pixmap(doc, xref)
    except Exception:
        return None
    width, height, step, data = pix.width, pix.height, pix.n, pix.samples
    left, right, top, bottom = width, 0, None, None
    for y in range(height):
        row = data[y * pix.stride:y * pix.stride + width * step:step]
        inked = len(row.lstrip(b'\x00'))
        if not inked:
            continue
        top = y if top is None else top
        bottom = y + 1
        left = min(left, width - inked)
        right = max(right, len(row.rstrip(b'\x00')))
    if top is None:
        return None
    return (left / width, top / height, right / width, bottom / height)


def settle_spaces(blocks, pictures):
    """Gives every span of character-level text blocks its 'text', with the spaces the ink shows.

    Where a new picture starts inside a line, the transparent text cannot be trusted about a
    space: its reader guesses one from any gap, and a gap there is only the stand-in font
    being narrower than the real one (or wider, and then a real gap goes unnoticed). So the
    ink decides: a guessed space goes when the two runs' ink is closer than WORD_GAP, and a
    space is added when it is further apart and none is written. A space that is written
    in the text is always kept.

    A span is also cut where the ink changes colour, and starts at its first letter: readers
    differ in whether a guessed space is a span of its own or the start of the next one.
    """
    def starts_at(picture, origin):
        rect = picture['rect']
        return abs(rect.x0 - origin[0]) <= PICTURE_MATCH \
            and rect.y0 + BASELINE_BAND[0] * rect.height <= origin[1] <= rect.y0 + BASELINE_BAND[1] * rect.height
    def beside(picture, other):
        a, b = picture['rect'], other['rect']
        return min(a.y1, b.y1) - max(a.y0, b.y0) >= SAME_LINE_OVERLAP * min(a.height, b.height)
    for block in blocks:
        for line in block.get('lines', []):
            kept, previous, parts = [], None, []
            for span in line['spans']:
                part, shade = dict(span, chars=None), None
                parts.append(part)
                for char in span['chars']:
                    letter, origin = char['c'], char['origin']
                    # A run starts where the text jumps: nowhere else can a picture start.
                    jumped = previous is None or not previous['c'].strip() \
                        or abs(origin[0] - previous['bbox'][2]) > PICTURE_MATCH / 2
                    previous = char
                    starting = [p for p in pictures if starts_at(p, origin)] if letter.strip() and jumped else []
                    if starting and shade not in (None, starting[0]['color']):
                        # One span of the stand-in text, two colours of ink: two spans.
                        part = dict(span, chars=None)
                        parts.append(part)
                        # The space between the two goes with neither colour's tag.
                        for entry in reversed(kept):
                            if entry['letter'].strip():
                                break
                            entry['part'] = part
                    shade = starting[0]['color'] if starting else shade
                    if starting and any(k['letter'].strip() for k in kept):
                        before = [p for p in pictures if beside(p, starting[0])
                                  and p['rect'].x0 < starting[0]['rect'].x0 - PICTURE_MATCH
                                  and p['rect'].x1 > starting[0]['rect'].x0 - span['size']]
                        if before:
                            apart = starting[0]['ink'].x0 - max(p['ink'].x1 for p in before) >= WORD_GAP * span['size']
                            while kept and not kept[-1]['letter'].strip() and kept[-1]['guessed'] and not apart:
                                kept.pop()
                            if apart and kept[-1]['letter'].strip():
                                kept.append({'part': part, 'letter': ' ', 'guessed': True, 'char': None})
                    kept.append({'part': part, 'letter': letter, 'guessed': bool(char.get('synthetic')), 'char': char})
            for part in parts:
                mine = [k for k in kept if k['part'] is part]
                part['text'] = ''.join(k['letter'] for k in mine)
                del part['chars']
                inked = [k['char'] for k in mine if k['char'] is not None and k['letter'].strip()]
                if inked:
                    # Measured from its first letter: a space before it is no part of the run.
                    part['origin'] = inked[0]['origin']
                    box = fitz.Rect()
                    for char in inked:
                        box |= fitz.Rect(char['bbox'])
                    part['bbox'] = tuple(box)
            line['spans'] = [part for part in parts if part['text']]
        if 'lines' in block:
            block['lines'] = [line for line in block['lines'] if line['spans']]
    return blocks


def pair_pictures(spans, pictures):
    """Which pictures draw which transparent span: [(span, [pictures, left to right])].

    The transparent text is cut into spans by the stand-in font's widths, the pictures by
    the real one's, so one span may be drawn by several pictures. A picture belongs to the
    span on its baseline that starts at or before it, up to where the next span on that
    line starts. A span that starts inside a picture another span was given shares it.
    """
    hidden = [s for s in spans if s.get('alpha', 0) == 0 and s['text'].strip()]
    hidden.sort(key=lambda s: s['origin'][0])
    def on_baseline(picture, span):
        # Against the picture's own box, not its ink: a hyphen's ink is nowhere near the baseline.
        rect = picture['rect']
        return rect.y0 + BASELINE_BAND[0] * rect.height <= span['origin'][1] <= rect.y0 + BASELINE_BAND[1] * rect.height
    def same_line(a, b):
        overlap = min(a['bbox'][3], b['bbox'][3]) - max(a['bbox'][1], b['bbox'][1])
        return overlap >= SAME_LINE_OVERLAP * min(a['bbox'][3] - a['bbox'][1], b['bbox'][3] - b['bbox'][1])
    taken, pairs = set(), []
    for index, span in enumerate(hidden):
        start = span['origin'][0] - RUN_ORIGIN_SLACK
        following = [o['origin'][0] for o in hidden[index + 1:]
                     if o['origin'][0] > span['origin'][0] + RUN_ORIGIN_SLACK and same_line(span, o)]
        stop = min(following) - RUN_ORIGIN_SLACK if following else float('inf')
        mine = [p for p in pictures
                if id(p) not in taken and on_baseline(p, span) and start <= p['rect'].x0 < stop]
        mine.sort(key=lambda p: p['rect'].x0)
        # Only as far as the pictures carry on without a gap: the next cell is someone else's.
        for count in range(1, len(mine)):
            if mine[count]['rect'].x0 - mine[count - 1]['ink'].x1 > SAME_LINE_GAP * span['size']:
                mine = mine[:count]
                break
        if mine and mine[0]['rect'].x0 > span['origin'][0] + SAME_LINE_GAP * span['size']:
            mine = []
        taken.update(id(p) for p in mine)
        pairs.append((span, mine))
    for span, mine in pairs:
        if not mine:
            x, y = span['origin']
            shared = [p for other, theirs in pairs for p in theirs
                      if p['rect'].x0 <= x <= p['rect'].x1 and on_baseline(p, span)]
            if shared:
                span['color'] = int(shared[0]['color'][1:], 16)
    return [(span, mine) for span, mine in pairs if mine]


def read_pictured_text(blocks, pictures):
    """Text blocks of a page whose text is drawn by pictures, read from the pictures.

    Spans a picture draws take its colour and its ink's width (see GLYPH PICTURES) and keep
    the transparent text's own box as 'layer'. Lines are then put together from where the
    ink is: runs side by side on one line become one line again, and with it one block.
    """
    lines, home = [], []
    for index, block in enumerate(b for b in blocks if b['type'] == 0):
        for line in block['lines']:
            lines.append(dict(line, spans=[dict(s) for s in line['spans']]))
            home.append(index)
    for span, drawn in pair_pictures([s for line in lines for s in line['spans']], pictures):
        box = span['bbox']
        span['layer'] = tuple(box)
        span['bbox'] = (min(p['ink'].x0 for p in drawn), box[1], max(p['ink'].x1 for p in drawn), box[3])
        span['color'] = int(drawn[0]['color'][1:], 16)
        span['pictures'] = [[round(v, 2) for v in p['rect']] for p in drawn]
    for line in lines:
        box = fitz.Rect()
        for span in line['spans']:
            if span['text'].strip():
                box |= fitz.Rect(span['bbox'])
        line['bbox'] = tuple(box) if not box.is_empty else line['bbox']

    # Lines that sit side by side belong together, and so do the blocks they came from.
    group = list(range(len(lines)))
    def root(i):
        while group[i] != i:
            group[i] = group[group[i]]
            i = group[i]
        return i
    block_root = {}
    for i, block in enumerate(home):
        block_root.setdefault(block, i)
    joined = list(range(len(lines)))
    def line_root(i):
        while joined[i] != i:
            joined[i] = joined[joined[i]]
            i = joined[i]
        return i
    order = sorted(range(len(lines)), key=lambda i: lines[i]['bbox'][0])
    for position, i in enumerate(order):
        a = lines[i]['bbox']
        for j in order[position + 1:]:
            b = lines[j]['bbox']
            sizes = [max((s['size'] for s in lines[k]['spans']), default=0) for k in (i, j)]
            size = max(sizes)
            if b[0] - a[2] > SAME_LINE_GAP * size:
                continue
            # Text of one size shares a line only on one baseline: a page number beside a
            # paragraph's last line overlaps it without being part of it. Smaller text may
            # sit raised (a superscript).
            base = [max(lines[k]['spans'], key=lambda s: s['size'])['origin'][1] for k in (i, j)]
            rise = abs(base[0] - base[1])
            if abs(sizes[0] - sizes[1]) <= PEER_SIZE_TOLERANCE and rise > RAISED * size:
                continue
            overlap = min(a[3], b[3]) - max(a[1], b[1])
            if overlap >= SAME_LINE_OVERLAP * min(a[3] - a[1], b[3] - b[1]) and b[0] >= a[0]:
                joined[line_root(j)] = line_root(i)
                group[root(block_root[home[j]])] = root(block_root[home[i]])
    merged = collections.defaultdict(lambda: collections.defaultdict(list))
    for i in range(len(lines)):
        merged[root(block_root[home[i]])][line_root(i)].append(lines[i])
    rebuilt = []
    for members in merged.values():
        block_lines = []
        for parts in members.values():
            parts.sort(key=lambda line: line['bbox'][0])
            for left, right in zip(parts, parts[1:]):
                # Two runs the reader kept apart: the ink says whether a space lies between.
                last, first = left['spans'][-1], right['spans'][0]
                if last['text'][-1:].strip() and first['text'][:1].strip() \
                        and right['bbox'][0] - left['bbox'][2] >= WORD_GAP * last['size']:
                    last['text'] += ' '
            spans = [s for part in parts for s in part['spans']]
            box = fitz.Rect()
            for part in parts:
                box |= fitz.Rect(part['bbox'])
            # The line's baseline is that of its largest text: a superscript sits above it.
            lead = max(spans, key=lambda s: s['size'])
            block_lines.append(dict(parts[0], spans=spans, bbox=tuple(box), baseline=lead['origin'][1]))
        block_lines.sort(key=lambda line: (line['bbox'][1], line['bbox'][0]))
        box = fitz.Rect()
        for line in block_lines:
            box |= fitz.Rect(line['bbox'])
        rebuilt.append({'type': 0, 'bbox': tuple(box), 'lines': block_lines})
    rebuilt.sort(key=lambda block: (block['bbox'][1], block['bbox'][0]))
    return rebuilt


def remove_pictures(page, rects=None):
    """Stops a page drawing its glyph pictures at 'rects' (all of them when None).

    The instruction that draws each one is cut out of the page's content, and an image no
    instruction draws any more is dropped from the page: it is a copy of the source text.
    Returns how many pictures were removed.
    """
    pictures = glyph_pictures(page)
    wanted = None if rects is None else [fitz.Rect(r) for r in rects]
    def asked(picture):
        return wanted is None or any(
            max(abs(a - b) for a, b in zip(picture['rect'], rect)) <= PICTURE_MATCH for rect in wanted)
    going = [p for p in pictures if asked(p)]
    if not going:
        return 0
    doc, cuts = page.parent, collections.defaultdict(list)
    for picture in going:
        cuts[picture['drawn']['xref']].append((picture['drawn']['start'], picture['drawn']['end']))
    for xref, spans in cuts.items():
        stream = bytearray(doc.xref_stream(xref))
        for start, end in sorted(spans, reverse=True):
            stream[start:end] = b''
        doc.update_stream(xref, bytes(stream))
    still_drawn = {drawn['name'] for drawn in drawn_images(page)}
    for name in {p['drawn']['name'] for p in going} - still_drawn:
        key = 'Resources/XObject/' + name
        if doc.xref_get_key(page.xref, key)[0] == 'xref':
            doc.xref_set_key(page.xref, key, 'null')
    return len(going)


def join_centred_stacks(blocks):
    """Puts the lines of a centred stack back in one block (see ALIGNMENT).

    Two blocks are joined when the lower starts one line below the upper, they share a
    centre but not a left edge, and their text is set in one size, face and colour.
    """
    def look(block):
        spans = [s for line in block['lines'] for s in line['spans'] if s['text'].strip()]
        if not spans:
            return None
        looks = {(round(s['size'], 1), s['font'], s['color']) for s in spans}
        return next(iter(looks)) if len(looks) == 1 else None
    def baseline(line):
        return line.get('baseline', line['spans'][0]['origin'][1])
    # A block whose lines are not a paragraph is so many separate lines (see extract_units).
    text = [part for b in blocks if b['type'] == 0 and b['lines']
            for part in ([b] if len(b['lines']) == 1 or is_paragraph(b['lines'])
                         else [dict(b, lines=[line], bbox=line['bbox']) for line in b['lines']])]
    # Looked at from the top down, handed back in the order they came in.
    place = {id(b): index for index, b in enumerate(text)}
    text.sort(key=lambda b: b['lines'][0]['bbox'][1])
    others = [b for b in blocks if b['type'] != 0 or not b['lines']]
    joined = []
    for block in text:
        style = look(block)
        first = block['lines'][0]
        for upper in joined if style else []:
            last = upper['lines'][-1]
            pitch = baseline(first) - baseline(last)
            a, b = last['bbox'], first['bbox']
            if look(upper) == style and 0.5 * style[0] < pitch <= STACK_MAX_PITCH * style[0] \
                    and abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) < SAME_LEFT_EDGE \
                    and abs(a[0] - b[0]) >= SAME_LEFT_EDGE \
                    and is_paragraph(upper['lines'] + block['lines']):
                upper['lines'] = upper['lines'] + block['lines']
                upper['bbox'] = tuple(fitz.Rect(upper['bbox']) | fitz.Rect(block['bbox']))
                break
        else:
            joined.append(dict(block, lines=list(block['lines']), place=place[id(block)]))
    return sorted(joined, key=lambda b: b['place']) + others


def quarter_turn(line):
    """How far a line is turned (see DIRECTION): 0, 90, 180 or 270, or None at any other angle."""
    across, down = line.get('dir', (1.0, 0.0))
    for turn, (x, y) in ((0, (1, 0)), (90, (0, -1)), (180, (-1, 0)), (270, (0, 1))):
        if abs(across - x) < 0.01 and abs(down - y) < 0.01:
            return turn
    return None


def upright(line):
    """Whether a line runs left to right (see DIRECTION)."""
    return quarter_turn(line) == 0


def turned_unit(uid, page_no, line, turn, pictures, links):
    """The unit of one turned line (see DIRECTION), read from its pictures when it is drawn
    by them (see GLYPH PICTURES); None when the line has nothing to translate."""
    line = dict(line, spans=[dict(s) for s in line['spans'] if not ICON_FONT.search(s['font'])])
    box = fitz.Rect(line['bbox'])
    drawn = [p for p in pictures if p['turned'] and (p['rect'] & box).get_area() > 0.3 * p['rect'].get_area()]
    for span in line['spans'] if drawn else []:
        if span.get('alpha', 0) != 0 or not span['text'].strip():
            continue
        ink = fitz.Rect()
        for picture in drawn:
            ink |= picture['ink']
        span['layer'] = tuple(span['bbox'])
        span['bbox'] = tuple(ink)
        span['color'] = int(drawn[0]['color'][1:], 16)
        span['pictures'] = [[round(v, 2) for v in p['rect']] for p in drawn]
    unit = build_unit(uid, page_no, [line], links) if line['spans'] else None
    if unit:
        unit['rotate'] = turn
    return unit


def assign_turned_room(unit, panels, page_rect):
    """The room of a turned unit (see DIRECTION): its own length along its direction, or its
    panel's when it sits in one, and one line across."""
    box = fitz.Rect(unit['bbox'])
    upward = unit['rotate'] in (90, 270)
    # Along the direction of the text, then across it.
    start, end = (box.y0, box.y1) if upward else (box.x0, box.x1)
    low, high = (box.x0, box.x1) if upward else (box.y0, box.y1)
    panel = panel_of(box, panels, unit['size'])
    if panel is not None:
        unit['panel'] = [round(v, 2) for v in panel]
        first, last = (panel.y0, panel.y1) if upward else (panel.x0, panel.x1)
        before, after = start - first, last - end
        inset = min(max(min(before, after), 0.0), PANEL_MAX_INSET)
        if abs(before - after) <= max(SAME_LEFT_EDGE, CENTRED_SHARE * (last - first)):
            unit['align'] = 'center'
        start, end = min(start, first + inset), max(end, last - inset)
        across = (panel.x0, panel.x1) if upward else (panel.y0, panel.y1)
    else:
        across = (page_rect.x0, page_rect.x1) if upward else (page_rect.y0, page_rect.y1)
    middle, half = (low + high) / 2, max(TURNED_LINE * unit['size'], high - low) / 2
    half = max(min(half, middle - across[0], across[1] - middle), (high - low) / 2)
    low, high = middle - half, middle + half
    room = fitz.Rect(low, start, high, end) if upward else fitz.Rect(start, low, end, high)
    unit['room'] = [round(v, 2) for v in room]
    unit['roomFactor'] = round(room.get_area() / max(box.get_area(), 1.0), 2)


def list_items(lines):
    """Splits a block's lines at each bullet (see LEFT IN PLACE).

    Returns ([{'lines', 'listed': it began with a bullet}], [bullet spans]). The bullet
    itself is taken off its line, whose box is then that of the text after it.
    """
    groups, bullets, opening, listed = [[]], [], False, [False]
    for line in lines:
        inked = [s for s in line['spans'] if s['text'].strip()]
        if inked and BULLET.match(inked[0]['text'].strip()):
            bullets.append(inked[0])
            opening = True
            rest = line['spans'][line['spans'].index(inked[0]) + 1:]
            if len(inked) == 1:
                continue
            box = fitz.Rect()
            for s in rest:
                if s['text'].strip():
                    box |= fitz.Rect(s['bbox'])
            line = dict(line, spans=rest, bbox=tuple(box))
        if opening and groups[-1]:
            groups.append([])
            listed.append(False)
        listed[-1] = listed[-1] or opening
        opening = False
        groups[-1].append(line)
    return [{'lines': group, 'listed': flag} for group, flag in zip(groups, listed) if group], bullets


def join_wrapped_lines(pieces):
    """Puts a line that only wrapped back with the paragraph it continues (see GLYPH PICTURES).

    A piece continues the one above when it has no bullet of its own, starts at the same
    left edge one line below in the same size, and either its first word would not have
    fitted on the line above, or the line above was broken on purpose (see BREAKS) and
    this is the next line of its stack.
    """
    def baseline(line):
        return line.get('baseline', line['spans'][0]['origin'][1])
    def size(line):
        return max(s['size'] for s in line['spans'])
    def words(line):
        return ''.join(s['text'] for s in line['spans']).split()
    joined = []
    for piece in sorted(pieces, key=lambda p: p['lines'][0]['bbox'][1]):
        first = piece['lines'][0]
        for upper in [] if piece['listed'] else joined:
            last = upper['lines'][-1]
            pitch, height = baseline(first) - baseline(last), size(last)
            text = words(first)
            if not text or abs(size(first) - height) > 0.6 or abs(first['bbox'][0] - last['bbox'][0]) >= SAME_LEFT_EDGE \
                    or not 0.5 * height < pitch <= WRAP_MAX_PITCH * height:
                continue
            if len(upper['lines']) > 1 and abs(pitch - (baseline(last) - baseline(upper['lines'][-2]))) > 1.0:
                continue
            width = first['bbox'][2] - first['bbox'][0]
            first_word = width * (len(text[0]) + 1) / max(sum(len(w) + 1 for w in text), 1)
            column = max(line['bbox'][2] for line in upper['lines'] + piece['lines'])
            above = ''.join(s['text'] for s in last['spans'])
            # BREAKS: a line broken on purpose is followed by the next line of its stack.
            broken = above == above.rstrip() and not re.search(r'\w-$', above)
            if last['bbox'][2] + first_word > column or broken:
                upper['lines'] = upper['lines'] + piece['lines']
                break
        else:
            joined.append(dict(piece, lines=list(piece['lines'])))
    return joined


def is_paragraph(lines):
    """Stacked lines sharing a left edge, a centre or a right edge (see ALIGNMENT); anything
    else (a table row) is split per line."""
    if len(lines) < 2:
        return False
    tops = [line['bbox'][1] for line in lines]
    stacked = all(b > a + 1 for a, b in zip(tops, tops[1:]))
    spread = lambda values: max(values) - min(values)
    boxes = [line['bbox'] for line in lines]
    return stacked and min(spread([b[0] for b in boxes]), spread([(b[0] + b[2]) / 2 for b in boxes]),
                           spread([b[2] for b in boxes])) < SAME_LEFT_EDGE


def link_for(rect, links):
    for link in links:
        if link.get('uri') and (fitz.Rect(link['from']) & rect).get_area() > 0.5 * rect.get_area():
            return link['uri']
    return None


class TagBook:
    """Hands out numbered inline tags and remembers the HTML each stands for."""

    def __init__(self):
        self.tags = {}

    def wrap(self, text, open_html, close_html):
        name = 'g%d' % (len(self.tags) + 1)
        self.tags[name] = {'open': open_html, 'close': close_html}
        return '<%s>%s</%s>' % (name, text, name)


def page_underlines(page):
    """Thin horizontal strokes on a page: where they run under text, that text is underlined."""
    return [fitz.Rect(d['rect']) for d in page.get_drawings()
            if d['rect'].height <= UNDERLINE_MAX_HEIGHT and d['rect'].width > 3]


def is_underlined(span, underlines):
    """Whether a stroke runs under most of a span, between its middle and just below it."""
    x0, y0, x1, y1 = span['bbox']
    return any((y0 + y1) / 2 < r.y0 <= y1 + 2 and min(x1, r.x1) - max(x0, r.x0) > 0.6 * (x1 - x0)
               for r in underlines)


def build_unit(uid, page_no, lines, links, underlines=()):
    spans = [s for line in lines for s in line['spans'] if s['text'].strip()]
    if not spans or not any(ch.isalpha() for s in spans for ch in s['text']):
        return None
    weight = collections.Counter()
    for s in spans:
        st = span_style(s)
        weight[(st['bold'], st['italic'], st['color'], round(s['size'], 1), s['font'])] += len(s['text'])
    (dbold, ditalic, dcolor, dsize, dfont), _ = weight.most_common(1)[0]
    book, parts, line_ends = TagBook(), [], collections.Counter()
    for line in lines:
        line_baseline = line.get('baseline', max(line['spans'], key=lambda s: s['size'])['origin'][1])
        for s in line['spans']:
            if not s['text'].strip():
                parts.append(' ')
                continue
            # Control characters (a stray backspace is common in running headers) are not text.
            clean = ''.join(ch if ch.isprintable() else ' ' for ch in s['text'])
            text, st = html.escape(clean, quote=False), span_style(s)
            uri = link_for(fitz.Rect(s['bbox']), links)
            if uri:
                text = book.wrap(text, '<a href="%s" style="color:%s">' % (html.escape(uri), st['color']), '</a>')
            elif st['color'] != dcolor or is_underlined(s, underlines):
                look = ('color:%s;' % st['color'] if st['color'] != dcolor else '') \
                    + ('text-decoration:underline;' if is_underlined(s, underlines) else '')
                text = book.wrap(text, '<span style="%s">' % look.rstrip(';'), '</span>')
            if abs(s['size'] - dsize) > 0.6:
                raised = s['size'] < dsize and line_baseline - s['origin'][1] > RAISED * dsize
                text = book.wrap(text, '<span style="font-size:%.1fpt%s">' % (
                    s['size'], ';vertical-align:super' if raised else ''), '</span>')
            if st['bold'] and not dbold:
                text = '<b>%s</b>' % text
            elif dbold and not st['bold']:
                text = book.wrap(text, '<span style="font-weight:normal">', '</span>')
            if st['italic'] and not ditalic:
                text = '<i>%s</i>' % text
            elif ditalic and not st['italic']:
                text = book.wrap(text, '<span style="font-style:normal">', '</span>')
            parts.append(text)
        written = ''.join(s['text'] for s in line['spans'])
        # A line that ends in a hyphen carries its word on to the next: no space belongs there.
        hyphened = bool(re.search(r'\w-$', written.rstrip()))
        left_short = line is not lines[-1] and written == written.rstrip() and not hyphened
        if line is not lines[-1]:
            line_ends[left_short] += 1
        parts.append(LINE_BREAK if left_short else '' if hyphened else LINE_WRAP if line is not lines[-1] else ' ')
    # BREAKS: in a stack, a line that ends in a space was broken too; the space was typed.
    stack = line_ends[True] >= STACK_SHARE * max(len(lines) - 1, 1)
    text = ''.join(parts).replace(LINE_WRAP, LINE_BREAK if stack else ' ')
    # Kept for now wherever a line was broken; settle_breaks decides for the document.
    pieces = [re.sub(r'\s+', ' ', piece).strip() for piece in text.split(LINE_BREAK)]
    markup = '\n'.join(piece for piece in pieces if piece)
    markup = re.sub(r'</(b|i)> <\1>', ' ', markup)
    bbox = fitz.Rect()
    for s in spans:
        bbox |= fitz.Rect(s['bbox'])
    align = line_alignment(lines)
    baselines = [line.get('baseline', line['spans'][0]['origin'][1]) for line in lines if line['spans']]
    leading = 1.2
    if len(baselines) > 1 and baselines[-1] > baselines[0]:
        leading = (baselines[-1] - baselines[0]) / (len(baselines) - 1) / dsize
    pictures = []
    for s in spans:
        pictures.extend(rect for rect in s.get('pictures', []) if rect not in pictures)
    unit = {
        'id': uid, 'page': page_no, 'bbox': [round(v, 2) for v in bbox],
        'spanRects': [[round(v, 2) for v in s.get('layer', s['bbox'])] for s in spans],
        'lines': len(lines), 'align': align, 'size': dsize, 'bold': dbold, 'italic': ditalic, 'color': dcolor,
        'serif': bool(SERIF_FONT.search(dfont)), 'leading': round(min(max(leading, 0.8), 2.0), 3),
        'text': markup, 'tags': book.tags,
        'chars': len(re.sub(r'<[^>]+>', '', markup)),
        'lineEnds': {'marked': line_ends[False], 'bare': line_ends[True]},
    }
    if pictures:
        unit['pictures'] = pictures
    return unit


def settle_breaks(units):
    """Decides whether the document's bare line ends are breaks (see BREAKS), and makes
    them spaces again when they are not. Takes each unit's 'lineEnds' count away."""
    ends = [unit.pop('lineEnds', {'marked': 0, 'bare': 0}) for unit in units]
    marked, bare = sum(e['marked'] for e in ends), sum(e['bare'] for e in ends)
    if marked > MARKED_WRAPS * (marked + bare):
        return units
    for unit in units:
        unit['text'] = unit['text'].replace('\n', ' ')
    return units


def line_alignment(lines):
    """How stacked lines are aligned (see ALIGNMENT); one line alone reads as 'left'."""
    if len(lines) < 2:
        return 'left'
    boxes = [line['bbox'] for line in lines]
    spread = lambda values: max(values) - min(values)
    if spread([b[0] for b in boxes]) < SAME_LEFT_EDGE:
        return 'left'
    if spread([(b[0] + b[2]) / 2 for b in boxes]) < SAME_LEFT_EDGE:
        return 'center'
    if spread([b[2] for b in boxes]) < SAME_LEFT_EDGE:
        return 'right'
    return 'left'


def page_obstacles(page, blocks, pictures=()):
    """Things a translation must not run into besides other text: images and icon glyphs.
    Glyph pictures are text, not images."""
    rects = [fitz.Rect(info['bbox']) for info in page.get_image_info()]
    rects = [r for r in rects
             if not any(max(abs(a - b) for a, b in zip(r, p['rect'])) <= PICTURE_MATCH for p in pictures)]
    for block in blocks:
        if block['type'] != 0:
            continue
        for line in block['lines']:
            for s in line['spans']:
                if ICON_FONT.search(s['font']) and s['text'].strip():
                    rects.append(fitz.Rect(s['bbox']))
    page_area = page.rect.get_area()
    # Full-bleed backgrounds are not obstacles; text sits on top of them by design.
    return [r for r in rects if r.get_area() < 0.25 * page_area]


def page_panels(page):
    """Shapes that text sits inside: filled or outlined drawings smaller than the page (see PANELS)."""
    limit = PANEL_MAX_SHARE * page.rect.get_area()
    panels = []
    for drawing in page.get_drawings():
        rect = drawing['rect']
        if drawing.get('fill') is None and drawing.get('color') is None:
            continue
        if rect.width > UNDERLINE_MAX_HEIGHT * 4 and rect.height > UNDERLINE_MAX_HEIGHT * 4 \
                and rect.get_area() < limit:
            panels.append(fitz.Rect(rect))
    return panels


def panel_of(box, panels, size):
    """The smallest panel holding a unit's source text, or None.

    A text box is taller than its ink (it leaves room for accents and descenders), so it may
    poke out above or below the shape its letters sit in by a share of the font size.
    """
    slack = PANEL_LINE_SLACK * size
    grown = [p for p in panels
             if (p + (-PANEL_TOLERANCE, -slack, PANEL_TOLERANCE, slack)).contains(box)]
    return min(grown, key=lambda p: p.get_area()) if grown else None


def textless_pixels(page):
    """The page drawn without its text, one pixel per point: what a translation is laid over."""
    scratch = fitz.open()
    scratch.insert_pdf(page.parent, from_page=page.number, to_page=page.number)
    bare = scratch[0]
    remove_pictures(bare)
    bare.add_redact_annot(bare.rect, fill=False)
    bare.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    return bare.get_pixmap(colorspace=fitz.csRGB, alpha=False)


def clear_extent(pixels, box, limit, downward):
    """How far a unit's room may grow before it meets something drawn (see CLEAR SPACE).

    Scans from the unit's far edge toward 'limit': rows below it across its width when
    'downward', else columns to its right across its height. Each line of pixels is compared
    with the one before, so a gradient passes and a rule does not.

    Returns the coordinate, in points, of the last clear line (never less than the unit's edge).
    """
    width, height, data = pixels.width, pixels.height, pixels.samples
    x0, x1 = max(int(box.x0), 0), min(int(box.x1 + 0.999), width)
    y0, y1 = max(int(box.y0), 0), min(int(box.y1 + 0.999), height)

    def line(index):
        if downward:
            start = (index * width + x0) * 3
            return data[start:start + (x1 - x0) * 3]
        return b''.join(data[(y * width + index) * 3:(y * width + index) * 3 + 3] for y in range(y0, y1))

    edge = y1 if downward else x1
    stop = min(int(limit), height if downward else width)
    if (x1 <= x0) or (y1 <= y0) or edge < 1:
        return float(box.y1 if downward else box.x1)
    previous = line(edge - 1)
    for index in range(edge, stop):
        current = line(index)
        changed = sum(1 for k in range(0, len(current), 3)
                      if max(abs(current[k] - previous[k]), abs(current[k + 1] - previous[k + 1]),
                             abs(current[k + 2] - previous[k + 2])) > EDGE_CONTRAST)
        if changed > EDGE_SHARE * (len(current) / 3):
            return float(max(index - GAP, box.y1 if downward else box.x1))
        previous = current
    return float(limit)


def align_columns(units):
    """Marks the cells of a centred column as centred (see ALIGNMENT); True if any changed.

    Called once rooms are known, since that is what tells which units are cells and which
    are centred in a panel. A one-line cell is centred when another cell, or a unit already
    known to be centred, has its centre and not its left edge. So is a one-line heading
    that stands over a unit centred in a panel, within CELL_REACH of it and no wider than
    that panel, whose centre is nearer the unit's than its left edge is by HEADING_MARGIN:
    the heading of that column.
    """
    def centre(unit):
        return (unit['bbox'][0] + unit['bbox'][2]) / 2
    cells = [u for u in units if u['lines'] == 1 and u.get('valign') == 'middle' and u.get('align') == 'left']
    known = [u for u in units if u.get('align') == 'center']
    found = [u for u in cells
             if any(o is not u and abs(centre(o) - centre(u)) < SAME_LEFT_EDGE
                    and abs(o['bbox'][0] - u['bbox'][0]) >= SAME_LEFT_EDGE for o in cells + known)]
    def heads(unit, column):
        reach = CELL_REACH * unit['size']
        panel, off = column.get('panel'), abs(centre(column) - centre(unit))
        return panel is not None and 0 <= column['bbox'][1] - unit['bbox'][3] <= reach \
            and panel[0] <= unit['bbox'][0] and unit['bbox'][2] <= panel[2] \
            and off < SAME_LEFT_EDGE and abs(column['bbox'][0] - unit['bbox'][0]) - off >= HEADING_MARGIN
    centred = known + found
    found += [u for u in units if u['lines'] == 1 and u.get('align') == 'left' and not u.get('listed')
              and not any(u is f for f in found) and any(heads(u, o) for o in centred)]
    for unit in found:
        unit['align'] = 'center'
    return bool(found)


def cell_span(pixels, box, size):
    """The cell a unit sits in the middle of (see CELLS): (top, bottom) in points, or None.

    Looks up and down from the unit, across its width, for the first line of pixels that
    differs from the one before (as clear_extent does). The unit is in the middle when both
    are found and the space above and below differs by no more than CELL_BALANCE of its size.
    """
    width, height, data = pixels.width, pixels.height, pixels.samples
    x0, x1 = max(int(box.x0), 0), min(int(box.x1 + 0.999), width)
    if x1 <= x0:
        return None

    def row(y):
        return data[(y * width + x0) * 3:(y * width + x1) * 3]

    def distance(start, step):
        if not 0 <= start < height:
            return None
        previous = row(start)
        for count in range(1, int(CELL_REACH * size) + 1):
            y = start + step * count
            if not 0 <= y < height:
                return None
            current = row(y)
            changed = sum(1 for k in range(0, len(current), 3)
                          if max(abs(current[k] - previous[k]), abs(current[k + 1] - previous[k + 1]),
                                 abs(current[k + 2] - previous[k + 2])) > EDGE_CONTRAST)
            if changed > EDGE_SHARE * (len(current) / 3):
                return count
            previous = current
        return None

    above, below = distance(int(box.y0), -1), distance(int(box.y1 + 0.999) - 1, 1)
    if above is None or below is None or abs(above - below) > CELL_BALANCE * size:
        return None
    return (box.y0 - max(above - 1 - GAP, 0.0), box.y1 + max(below - 1 - GAP, 0.0))


def assign_room(units, obstacles, page_rect, panels=(), pixels=None):
    """Derives each unit's 'room' (where its translation may go) from the free space around it."""
    for unit in units:
        box = fitz.Rect(unit['bbox'])
        right_limit = page_rect.x1 - min(box.x0, page_rect.width * 0.08)
        left_limit = min(box.x0, page_rect.x0 + page_rect.width * 0.08)
        bottom_limit = page_rect.y1 - 18
        panel = panel_of(box, panels, unit['size'])
        if panel is not None:
            # Kept as clear of the panel's far edges as the source is of its near one.
            inset = min(max(box.x0 - panel.x0, 0.0), PANEL_MAX_INSET)
            right_limit = min(right_limit, max(panel.x1 - inset, box.x1))
            bottom_limit = min(bottom_limit, max(panel.y1 - inset, box.y1))
            unit['panel'] = [round(v, 2) for v in panel]
        neighbours = [(fitz.Rect(o['bbox']), o.get('align') == 'center') for o in units if o is not unit]
        others = [rect for rect, _ in neighbours]
        for o, spreads in neighbours + [(rect, False) for rect in obstacles]:
            same_row = o.y0 < box.y1 - 1 and o.y1 > box.y0 + 1
            if same_row and o.x0 >= box.x1 - 1:
                # A centred neighbour grows toward this unit too: each has half the gap.
                right_limit = min(right_limit, (box.x1 + o.x0) / 2 - GAP if spreads else o.x0 - GAP * 2)
            if same_row and o.x1 <= box.x0 + 1:
                # Only a centred unit grows leftward, and then into half the gap at most.
                left_limit = max(left_limit, min((o.x1 + box.x0) / 2 + GAP, box.x0))
        for o in others:
            same_column = o.x0 < box.x1 - 1 and o.x1 > box.x0 + 1
            # Adjacent lines' boxes overlap by their ascenders, so "below" means starting lower.
            if same_column and o.y0 > box.y0 + 1:
                bottom_limit = min(bottom_limit, o.y0 - GAP)
        if pixels is not None:
            right_limit = min(right_limit, clear_extent(pixels, box, right_limit, downward=False))
        cell = cell_span(pixels, box, unit['size']) if pixels is not None else None
        # Alone in its cell: nothing else between the cell's edges, above or below it.
        if cell is not None and any(
                o.x0 < box.x1 - 1 and o.x1 > box.x0 + 1 and o.y1 > cell[0] and o.y0 < cell[1]
                and not (o.y0 >= box.y0 - 1 and o.y1 <= box.y1 + 1) for o in others + obstacles):
            cell = None
        # Paragraphs keep their column width, unless a panel or a cell says how wide the
        # column really is; single lines may grow sideways into free space, and so may a
        # stack of lines that were each broken on purpose (see BREAKS).
        stacked = unit.get('text', '').count('\n') == unit['lines'] - 1
        wrapped = unit['lines'] > 1 and not stacked
        x1 = box.x1 if wrapped and panel is None and cell is None else max(box.x1, right_limit)
        if pixels is not None:
            # Scanned across the width the room will have, not only the source's.
            reach = fitz.Rect(box.x0, box.y0, max(x1, box.x1), box.y1)
            bottom_limit = min(bottom_limit, clear_extent(pixels, reach, bottom_limit, downward=True))
        first_line_bottom = box.y0 + unit['size'] * 1.3
        # Growth downward is capped: free space below a block is often a different background.
        y1 = min(bottom_limit, box.y1 + MAX_GROWTH * box.height + unit['size'])
        y1 = max(y1, min(box.y1, first_line_bottom))
        x0, x1 = box.x0, max(x1, box.x1)
        if panel is not None and unit['lines'] == 1 and not unit.get('listed'):
            left, right = box.x0 - panel.x0, panel.x1 - box.x1
            if left > PANEL_MAX_INSET and abs(left - right) <= max(SAME_LEFT_EDGE, CENTRED_SHARE * panel.width):
                unit['align'] = 'center'
        if unit['align'] == 'center':
            # The room keeps the unit's centre: as wide as the nearer limit allows on both sides.
            centre = (box.x0 + box.x1) / 2
            # Outside a panel, as far left as the row is free of other text.
            near = panel.x0 + min(max(box.x0 - panel.x0, 0.0), PANEL_MAX_INSET) if panel is not None else left_limit
            half = max(min(centre - near, x1 - centre), box.width / 2)
            x0, x1 = centre - half, centre + half
        y0 = box.y0
        unit.pop('valign', None)
        if cell is not None:
            # The room keeps the unit's centre, as high as the nearer edge allows both ways.
            centre = (box.y0 + box.y1) / 2
            half = max(min(centre - cell[0], cell[1] - centre), box.height / 2)
            y0, y1 = centre - half, centre + half
            unit['valign'] = 'middle'
        unit['room'] = [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)]
        source_area = max(box.get_area(), 1.0)
        unit['roomFactor'] = round(fitz.Rect(unit['room']).get_area() / source_area, 2)


def assign_peers(units):
    """Names each unit's peer group on its page (see PEERS).

    Sizes are grouped with a tolerance: the same text style often measures a tenth of a
    point apart from one line to the next.
    """
    anchor = None
    for unit in sorted(units, key=lambda u: u['size']):
        if anchor is None or unit['size'] - anchor > PEER_SIZE_TOLERANCE:
            anchor = unit['size']
        unit['peer'] = '%.1f|%d%d|%s' % (anchor, unit['bold'], unit['italic'], unit['color'])


def extract_units(doc, pages):
    found = []
    for page_no in pages:
        page = doc[page_no - 1]
        links = page.get_links()
        flags = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES
        pictures, underlines = glyph_pictures(page), page_underlines(page)
        if pictures:
            blocks = settle_spaces(page.get_text('rawdict', flags=flags)['blocks'],
                                   [p for p in pictures if not p['turned']])
        else:
            blocks = page.get_text('dict', flags=flags)['blocks']
        page_units, standing = [], []
        turned = []
        for bi, block in enumerate(blocks):
            if block['type'] != 0:
                continue
            for li, line in enumerate(block['lines']):
                turn = quarter_turn(line)
                made = turned_unit('p%d-b%d-t%d' % (page_no, bi, li), page_no, line, turn, pictures, links) \
                    if turn else None
                if made:
                    turned.append(made)
                elif turn != 0:
                    # Text at another angle stays where it is (see LEFT IN PLACE).
                    standing.extend(fitz.Rect(s['bbox']) for s in line['spans'] if s['text'].strip())
            block['lines'] = [line for line in block['lines'] if upright(line)]
        standing.extend(fitz.Rect(unit['bbox']) for unit in turned)
        level = [p for p in pictures if not p['turned']]
        if level:
            blocks = read_pictured_text(blocks, level)
        blocks = join_centred_stacks(blocks)
        pieces, bullet_boxes = [], []
        for bi, block in enumerate(blocks):
            if block['type'] != 0:
                continue
            lines = [dict(line, spans=[s for s in line['spans'] if not ICON_FONT.search(s['font'])])
                     for line in block['lines']]
            lines = [line for line in lines if line['spans']]
            items, bullets = list_items(lines)
            bullet_boxes.extend(fitz.Rect(s['bbox']) for s in bullets)
            pieces.extend(dict(item, block=bi) for item in items)
        for piece in pieces:
            # A bullet may also stand in a block of its own, left of the line it belongs to.
            first = piece['lines'][0]
            x0, y0, _, y1 = first['bbox']
            reach = BULLET_REACH * max(s['size'] for s in first['spans'])
            piece['listed'] = piece['listed'] or any(
                y0 < (r.y0 + r.y1) / 2 < y1 and x0 - reach <= r.x0 and r.x1 <= x0 + 1 for r in bullet_boxes)
        if level:
            pieces = join_wrapped_lines(pieces)
        standing.extend(bullet_boxes)
        counts = collections.Counter()
        for piece in pieces:
            item, bi = piece['lines'], piece['block']
            for group in ([item] if is_paragraph(item) else [[line] for line in item]):
                unit = build_unit('p%d-b%d-%d' % (page_no, bi, counts[bi]), page_no, group, links, underlines)
                counts[bi] += 1
                if unit:
                    # A list item is set from its left edge, however much of its box it fills.
                    unit['listed'] = piece['listed']
                    page_units.append(unit)
                else:
                    # Text that is not translated (an amount, a page number) stays where it is.
                    standing.extend(fitz.Rect(s['bbox']) for line in group for s in line['spans']
                                    if s['text'].strip())
        claimed = [rect for unit in page_units for rect in unit.get('pictures', [])]
        for picture in level:
            # A picture no span was paired with, lying in a unit's own text, is that unit's:
            # whatever a reader made of the transparent text, the unit must not leave it behind.
            rect, mark = [round(v, 2) for v in picture['rect']], (picture['ink'].tl + picture['ink'].br) / 2
            owner = None if rect in claimed else next(
                (u for u in page_units if any(fitz.Rect(r).contains(mark) for r in u['spanRects'])), None)
            if owner is not None:
                owner.setdefault('pictures', []).append(rect)
        found.append({'page': page, 'units': page_units, 'turned': turned,
                      'obstacles': page_obstacles(page, blocks, pictures) + standing})
    # BREAKS are settled for the document before rooms are given: a stack of lines the
    # author broke is given room as single lines are.
    settle_breaks([unit for each in found for unit in each['units']])
    units = []
    for each in found:
        page, page_units, panels = each['page'], each['units'], page_panels(each['page'])
        bare = textless_pixels(page)
        assign_room(page_units, each['obstacles'], page.rect, panels, bare)
        if align_columns(page_units):
            # Centred cells get rooms about their centres.
            assign_room(page_units, each['obstacles'], page.rect, panels, bare)
        assign_peers(page_units)
        for unit in each['turned']:
            assign_turned_room(unit, panels, page.rect)
        page_units.extend(each['turned'])
        for number, unit in enumerate(page_units, start=1):
            unit['n'] = number
        units.extend(page_units)
    return units


def page_stats(doc, pages, units):
    stats = []
    for page_no in pages:
        page = doc[page_no - 1]
        text_chars = len(page.get_text().strip())
        image_area = sum(fitz.Rect(i['bbox']).get_area() for i in page.get_image_info())
        coverage = image_area / max(page.rect.get_area(), 1.0)
        stats.append({
            'page': page_no, 'width': round(page.rect.width, 1), 'height': round(page.rect.height, 1),
            'units': sum(1 for u in units if u['page'] == page_no), 'textChars': text_chars,
            # A page that is mostly image and carries no text layer is a scan: nothing to extract.
            'scanned': text_chars < 20 and coverage > 0.5,
        })
    return stats


def render(page, labelled_units=None, outline='bbox', dpi=PREVIEW_DPI):
    """PNG bytes of a page; with 'labelled_units', each unit is outlined and numbered.

    'outline' names which box is drawn: 'bbox' (where the source text was) when the picture is
    used to identify units, 'room' (where a translation may go) when it is used to judge fit.
    """
    zoom = dpi / 72.0
    if labelled_units:
        scratch = fitz.open()
        scratch.insert_pdf(page.parent, from_page=page.number, to_page=page.number)
        target = scratch[0]
        for unit in labelled_units:
            box = fitz.Rect(unit[outline])
            target.draw_rect(box, color=(1, 0, 0.6), width=0.4)
            label = str(unit['n'])
            width = 4 + 4 * len(label)
            tag = fitz.Rect(box.x0 - width - 1, box.y0, box.x0 - 1, box.y0 + 8.5)
            if tag.x0 < 0:
                tag = fitz.Rect(box.x0, box.y0 - 8.5, box.x0 + width, box.y0)
            target.draw_rect(tag, color=(1, 0, 0.6), fill=(1, 0, 0.6), width=0)
            target.insert_text((tag.x0 + 2, tag.y1 - 2), label, fontsize=7, color=(1, 1, 1))
        pix = target.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    else:
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    return pix.tobytes('png')


def side_by_side(left_png, right_png):
    left, right = fitz.Pixmap(left_png), fitz.Pixmap(right_png)
    sheet = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, left.width + right.width + 8, max(left.height, right.height)), False)
    sheet.set_rect(sheet.irect, (40, 40, 40))
    for pix, x in ((left, 0), (right, left.width + 8)):
        rgb = fitz.Pixmap(fitz.csRGB, pix) if pix.alpha or pix.colorspace != fitz.csRGB else pix
        rgb.set_origin(x, 0)
        sheet.copy(rgb, rgb.irect)
    return sheet.tobytes('png')


def write_zip(name, files):
    with zipfile.ZipFile(os.path.join(HERE, name), 'w', zipfile.ZIP_DEFLATED) as archive:
        for filename, data in files.items():
            archive.writestr(filename, data)


def command_extract(job):
    doc = fitz.open(os.path.join(HERE, job['source']))
    wanted = job.get('pages') or list(range(1, len(doc) + 1))
    pages = [p for p in wanted if 1 <= p <= len(doc)]
    units = extract_units(doc, pages)
    files = {'units.json': json.dumps({'pageCount': len(doc), 'pages': page_stats(doc, pages, units), 'units': units},
                                      ensure_ascii=False)}
    for page_no in pages:
        files['page_%d.png' % page_no] = render(doc[page_no - 1], [u for u in units if u['page'] == page_no])
    write_zip('native_extract.zip', files)
    print('NATIVE_EXTRACT_OK pages=%d units=%d' % (len(pages), len(units)))


# ── rebuild ───────────────────────────────────────────────────────────────────

PLAIN_STYLES = {
    'regular': (False, False), 'book': (False, False), 'roman': (False, False),
    'bold': (True, False), 'italic': (False, True), 'oblique': (False, True),
    'bold italic': (True, True), 'bold oblique': (True, True),
}


def installed_fonts():
    """family -> {(bold, italic): path} for every font fontconfig knows, plus any uploaded beside the script."""
    families = collections.defaultdict(dict)
    try:
        listing = subprocess.run(['fc-list', '--format', '%{file}|%{family[0]}|%{style[0]}\n'],
                                 capture_output=True, text=True, timeout=30).stdout
    except Exception:
        listing = ''
    for line in listing.splitlines():
        parts = line.split('|')
        if len(parts) != 3 or not parts[0].lower().endswith(('.ttf', '.otf')):
            continue
        key = PLAIN_STYLES.get(parts[2].strip().lower())
        # Only the four plain faces: "Medium" or "ExtraLight" must never stand in for regular.
        if key is not None:
            families[parts[1]].setdefault(key, parts[0])
    return families


def lacking(path, characters):
    """The characters, of those given, that the font at 'path' has no glyph for; all of them
    when the font cannot be read."""
    visible = {ch for ch in characters if ch.isprintable() and not ch.isspace()}
    try:
        from fontTools.ttLib import TTFont
        cmap = TTFont(path, lazy=True, fontNumber=0).getBestCmap() or {}
    except Exception:
        return visible
    return {ch for ch in visible if ord(ch) not in cmap}


def covers(path, characters):
    return not lacking(path, characters)


def stood_in_for(characters, faces):
    """The characters, of those given, that the layout engine draws in a font of its own
    when the family 'faces' is asked for (see FONTS).

    Found by setting them and reading back which font each was drawn in: the engine's
    stand-ins differ from one build of it to the next, so they are never assumed.
    """
    if not characters:
        return set()
    probe = fitz.open()
    page = probe.new_page(width=1000, height=1000)
    sample = ' '.join(html.escape(ch) for ch in sorted(characters))
    page.insert_htmlbox(page.rect, '<p>A %s</p>' % sample, archive=fitz.Archive('/'), scale_low=0,
                        css=font_css('probe', faces) + '* {font-family:probe;} p {margin:0;font-size:6pt;}')
    spans = [span for block in fitz.open('pdf', probe.tobytes())[0].get_text('rawdict')['blocks']
             for line in block.get('lines', []) for span in line['spans']]
    own = next((span['font'] for span in spans if any(c['c'] == 'A' for c in span['chars'])), None)
    return {c['c'] for span in spans if span['font'] != own for c in span['chars']} & set(characters)


def choose_fonts(families, preferred, characters):
    """The family a translation is set in (see FONTS): (name, faces, characters nothing draws).

    The first preferred family that has every character; failing that, the first one
    installed, which leaves the characters it lacks to the layout engine's own fonts.
    (None, None, characters) when no preferred family is installed at all.
    """
    name, faces = choose_family(families, preferred, characters)
    if faces:
        return name, faces, set()
    for name in preferred:
        faces = families.get(name)
        if faces and (False, False) in faces:
            missing = lacking(faces[(False, False)], characters)
            return name, faces, missing - stood_in_for(missing, faces)
    return None, None, set(characters)


def reads_right_to_left(text):
    """Whether most of a text's letters belong to a right-to-left script (see READING DIRECTION)."""
    kinds = collections.Counter(unicodedata.bidirectional(ch) for ch in text if ch.isalpha())
    return kinds['R'] + kinds['AL'] > kinds['L']


def lower_raised_marks(text, tags):
    """Takes a superscript tag off anything that is not a letter or digit: the 'th' of
    '28th' may come back as the full stop of '28.', which belongs on the line."""
    def lower(match):
        raised = 'vertical-align:super' in (tags.get(match.group(1)) or {}).get('open', '')
        return match.group(2) if raised and not any(ch.isalnum() for ch in match.group(2)) else match.group(0)
    return re.sub(r'<(g\d+)>([^<]*)</\1>', lower, text)


def choose_family(families, preferred, characters):
    """First family, in preference order, whose regular face has every character we must draw."""
    for name in preferred:
        faces = families.get(name)
        if faces and (False, False) in faces and covers(faces[(False, False)], characters):
            return name, faces
    return None, None


def font_css(alias, faces):
    regular = faces[(False, False)]
    rules = []
    for (bold, italic) in ((False, False), (True, False), (False, True), (True, True)):
        path = faces.get((bold, italic)) or faces.get((bold, False)) or regular
        rules.append('@font-face{font-family:%s;src:url(%s);font-weight:%s;font-style:%s;}' % (
            alias, path, 'bold' if bold else 'normal', 'italic' if italic else 'normal'))
    return ''.join(rules)


def restore_tags(text, tags):
    def swap(match):
        closing, name = match.group(1), match.group(2)
        pair = tags.get(name)
        if not pair:
            return ''
        return pair['close'] if closing else pair['open']
    return re.sub(r'<(/?)(g\d+)>', swap, text)


def link_underlines(page, unit):
    """Thin horizontal strokes under linked or underlined source text: part of the text, so
    removed with it."""
    box, found = fitz.Rect(unit['bbox']) + (-1, -1, 1, 2), []
    for drawing in page.get_drawings():
        r = drawing['rect']
        if r.height <= UNDERLINE_MAX_HEIGHT and r.width > 3 and box.contains(r):
            found.append(r + (-0.5, -0.8, 0.5, 0.8))
    return found


def resize_inline(markup, factor):
    """Scales the sizes that parts of a unit carry inline, so they keep their proportion to it."""
    return re.sub(r'font-size:([0-9.]+)pt',
                  lambda match: 'font-size:%.1fpt' % (float(match.group(1)) * factor), markup)


def styled_room(unit, style, bounds):
    """Where a unit's translation is laid out once the person's style is applied.

    The room moves by ('dx', 'dy') as far as the page allows. A font size larger than the
    source's needs more height than the room was measured for, so the room then reaches down
    to the page's lower edge: text is set from the top, and only the height it uses is drawn on.
    """
    room = fitz.Rect(unit['room'])
    dx = min(max(style.get('dx', 0), bounds.x0 - room.x0), bounds.x1 - room.x1)
    dy = min(max(style.get('dy', 0), bounds.y0 - room.y0), bounds.y1 - room.y1)
    room = room + (dx, dy, dx, dy)
    if style.get('size', 0) > unit['size']:
        room.y1 = bounds.y1
    return room


# ── slides ──────────────────────────────────────────────────────────────────────────────
# SLIDES (see the convention in the docstring). The file is written part by part: a
# presentation is a zip of XML, and the sandbox need not have a library for it.

NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
NS_ALL = 'xmlns:a="%s" xmlns:r="%s" xmlns:p="%s"' % (NS_A, NS_R, NS_P)
XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.'
EMPTY_TREE = ('<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>'
              '<a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>'
              '</a:xfrm></p:grpSpPr>')
COLOUR_MAP = ('bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
              'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"')


def emu(points):
    """Points as the whole English Metric Units a presentation measures in."""
    return int(round(points * EMU_PER_POINT))


def slide_language(tag):
    """The proofing language to mark a presentation's text with for a job's 'language', or ''
    when there is none to give (see SLIDE_LANGUAGES). A tag that names its region is kept."""
    tag = (tag or '').strip()
    if re.fullmatch(r'[A-Za-z]{2,3}(-[A-Za-z]{4})?-([A-Za-z]{2}|[0-9]{3})', tag):
        return tag
    return SLIDE_LANGUAGES.get(tag.split('-')[0].lower(), '')


def xml_text(text):
    return html.escape(text, quote=True)


class SlideRuns(HTMLParser):
    """Reads a unit's markup (the HTML that restore_tags gives) into lines of runs.

    'lines' is a list of lines; a line is a list of (text, look) and a look has any of
    'bold', 'italic', 'underline', 'raised' (booleans), 'color' ('#rrggbb'), 'size'
    (points, as written in the markup) and 'href'. A line break in the text or a <br>
    starts a new line.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines, self.looks = [[]], [{}]

    def handle_starttag(self, tag, attrs):
        attrs, look = dict(attrs), dict(self.looks[-1])
        if tag == 'br':
            self.lines.append([])
            return
        if tag == 'b':
            look['bold'] = True
        elif tag == 'i':
            look['italic'] = True
        elif tag == 'u':
            look['underline'] = True
        elif tag == 'sup':
            look['raised'] = True
        elif tag == 'a' and attrs.get('href'):
            look['href'], look['underline'] = attrs['href'], True
        for name, value in re.findall(r'([a-z-]+)\s*:\s*([^;]+)', attrs.get('style') or ''):
            value = value.strip()
            if name == 'color' and re.fullmatch(r'#[0-9a-fA-F]{6}', value):
                look['color'] = value
            elif name == 'font-size' and value.endswith('pt'):
                look['size'] = float(value[:-2])
            elif name == 'font-weight':
                look['bold'] = value == 'bold'
            elif name == 'font-style':
                look['italic'] = value == 'italic'
            elif name == 'text-decoration' and 'underline' in value:
                look['underline'] = True
            elif name == 'vertical-align' and value == 'super':
                look['raised'] = True
        self.looks.append(look)

    def handle_endtag(self, tag):
        if tag != 'br' and len(self.looks) > 1:
            self.looks.pop()

    def handle_data(self, data):
        for index, piece in enumerate(data.split('\n')):
            if index:
                self.lines.append([])
            if piece:
                self.lines[-1].append((piece, self.looks[-1]))


def slide_runs(markup):
    reader = SlideRuns()
    reader.feed(markup)
    reader.close()
    return reader.lines


def run_properties(look, box, links):
    """The <a:rPr> of one run: the box's own look with the run's laid over it."""
    # A raised run is made smaller by being raised; its own smaller size would shrink it twice.
    size = (box['baseSize'] if look.get('raised') else look.get('size', box['baseSize'])) * box['sizeFactor']
    attributes = ' lang="%s"' % xml_text(box['language']) if box['language'] else ''
    attributes += ' sz="%d" b="%d" i="%d"' % (max(int(round(size * 100)), 100),
                                               look.get('bold', box['bold']), look.get('italic', box['italic']))
    if look.get('underline'):
        attributes += ' u="sng"'
    if look.get('raised'):
        attributes += ' baseline="30000"'
    inner = '<a:solidFill><a:srgbClr val="%s"/></a:solidFill>' % look.get('color', box['color']).lstrip('#').upper()
    inner += '<a:latin typeface="%s"/><a:cs typeface="%s"/>' % (box['typeface'], box['typeface'])
    if look.get('href'):
        links.append(look['href'])
        inner += '<a:hlinkClick r:id="rIdLink%d"/>' % len(links)
    return '<a:rPr%s dirty="0">%s</a:rPr>' % (attributes, inner)


def slide_text_box(box, shape_id, links):
    """One unit as an editable text box, where and as the layout set it (see SLIDES)."""
    x0, y0, x1, y1 = box['rect']
    paragraph = '<a:pPr algn="%s"%s><a:lnSpc><a:spcPct val="%d"/></a:lnSpc></a:pPr>' % (
        {'left': 'l', 'center': 'ctr', 'right': 'r'}[box['align']], ' rtl="1"' if box['rtl'] else '',
        int(round(min(max(box['leading'] / NORMAL_LEADING, 0.7), 1.6) * 100000)))
    runs = []
    for index, line in enumerate(slide_runs(box['markup'])):
        if index:
            runs.append('<a:br>%s</a:br>' % run_properties({}, box, []))
        for text, look in line:
            runs.append('<a:r>%s<a:t>%s</a:t></a:r>' % (run_properties(look, box, links), xml_text(text)))
    # DIRECTION: text running up the page is 'vert270', down the page 'vert'; the box is
    # the room as it lies on the page, so nothing has to be turned around a centre.
    turned = {90: ' vert="vert270"', 270: ' vert="vert"'}.get(box['rotate'], '')
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="%d" name="Text %d"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="%s"%s>'
        '<a:normAutofit/></a:bodyPr><a:lstStyle/><a:p>%s%s</a:p></p:txBody></p:sp>' % (
            shape_id, shape_id - 1, emu(x0), emu(y0), max(emu(x1 - x0), 1), max(emu(y1 - y0), 1),
            'ctr' if box['middle'] else 't', turned, paragraph, ''.join(runs)))


def slide_picture(page):
    """A page as the picture behind a slide: (bytes, extension), the smaller of PNG and JPEG
    unless the PNG is small anyway (flat colour compresses well and stays exact)."""
    pixmap = page.get_pixmap(matrix=fitz.Matrix(SLIDE_DPI / 72.0, SLIDE_DPI / 72.0), alpha=False)
    png = pixmap.tobytes('png')
    if len(png) <= SLIDE_PNG_MAX_BYTES:
        return png, 'png'
    jpeg = pixmap.tobytes('jpg', jpg_quality=SLIDE_JPEG_QUALITY)
    return (jpeg, 'jpeg') if len(jpeg) < len(png) else (png, 'png')


def relationships(entries):
    """A .rels part from (id, type suffix, target, external) entries."""
    rows = ''.join('<Relationship Id="%s" Type="%s/%s" Target="%s"%s/>' % (
        rel_id, NS_R, kind, xml_text(target), ' TargetMode="External"' if external else '')
        for rel_id, kind, target, external in entries)
    return XML_HEAD + '<Relationships xmlns="%s">%s</Relationships>' % (NS_REL, rows)


def theme_part(name):
    fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    line = '<a:ln w="9525">%s</a:ln>' % fill
    effect = '<a:effectStyle><a:effectLst/></a:effectStyle>'
    colours = ''.join('<a:%s><a:srgbClr val="%s"/></a:%s>' % (tag, value, tag) for tag, value in (
        ('dk1', '000000'), ('lt1', 'FFFFFF'), ('dk2', '1F2937'), ('lt2', 'F3F4F6'), ('accent1', '2563EB'),
        ('accent2', 'DC2626'), ('accent3', '059669'), ('accent4', 'D97706'), ('accent5', '7C3AED'),
        ('accent6', '0891B2'), ('hlink', '1D4ED8'), ('folHlink', '6D28D9')))
    fonts = '<a:latin typeface="%s"/><a:ea typeface=""/><a:cs typeface=""/>' % SLIDE_SANS
    return XML_HEAD + (
        '<a:theme xmlns:a="%s" name="%s"><a:themeElements><a:clrScheme name="%s">%s</a:clrScheme>'
        '<a:fontScheme name="%s"><a:majorFont>%s</a:majorFont><a:minorFont>%s</a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="%s"><a:fillStyleLst>%s</a:fillStyleLst><a:lnStyleLst>%s</a:lnStyleLst>'
        '<a:effectStyleLst>%s</a:effectStyleLst><a:bgFillStyleLst>%s</a:bgFillStyleLst></a:fmtScheme>'
        '</a:themeElements></a:theme>' % (NS_A, name, name, colours, name, fonts, fonts, name,
                                          fill * 3, line * 3, effect * 3, fill * 3))


def notes_part(lines):
    """A slide's notes: the page's source text, a paragraph for each unit."""
    body = ''.join('<a:p><a:r><a:rPr dirty="0"/><a:t>%s</a:t></a:r></a:p>' % xml_text(line)
                   for line in lines) or '<a:p/>'
    return XML_HEAD + (
        '<p:notes %s><p:cSld><p:spTree>%s'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" '
        'noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>'
        '<p:txBody><a:bodyPr/><a:lstStyle/>%s</p:txBody></p:sp>'
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>' % (NS_ALL, EMPTY_TREE, body))


def notes_master_part():
    def holder(shape_id, name, kind, index, box, body):
        return ('<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
                '<p:nvPr><p:ph type="%s"%s/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="%d" y="%d"/>'
                '<a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>%s</p:sp>'
                % ((shape_id, name, kind, index) + box + (body,)))
    text = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody>'
    return XML_HEAD + (
        '<p:notesMaster %s><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
        '<p:spTree>%s%s%s</p:spTree></p:cSld><p:clrMap %s/></p:notesMaster>' % (
            NS_ALL, EMPTY_TREE,
            holder(2, 'Slide Image', 'sldImg', ' idx="2"', (685800, 685800, 5486400, 3086100), ''),
            holder(3, 'Notes', 'body', ' idx="1"', (685800, 4000500, 5486400, 4457700), text), COLOUR_MAP))


def write_slides(slides, language):
    """The bytes of a presentation of 'slides' (see SLIDES).

    Each slide is {'size': (width, height) in points, 'picture': (bytes, extension),
    'boxes': [what slide_text_box takes], 'notes': [lines of source text]}. The
    presentation takes the first slide's size; a page of another size is fitted inside it,
    centred, with its boxes scaled the same.
    """
    width, height = slides[0]['size']
    parts = {}
    slide_ids, slide_rels, overrides = [], [], []
    for number, slide in enumerate(slides, 1):
        page_width, page_height = slide['size']
        fit = min(width / page_width, height / page_height)
        left, top = (width - page_width * fit) / 2, (height - page_height * fit) / 2
        links, shapes = [], []
        for index, box in enumerate(slide['boxes']):
            x0, y0, x1, y1 = box['rect']
            placed = dict(box, language=slide_language(language), sizeFactor=box['sizeFactor'] * fit,
                          rect=(left + x0 * fit, top + y0 * fit, left + x1 * fit, top + y1 * fit))
            shapes.append(slide_text_box(placed, index + 2, links))
        data, extension = slide['picture']
        parts['ppt/media/page%d.%s' % (number, extension)] = data
        # The page is the slide's background, not a picture on it: a click never selects
        # it, so the text boxes are all there is to pick up. A page of another shape is
        # inset rather than stretched.
        inset = '<a:fillRect l="%d" t="%d" r="%d" b="%d"/>' % (
            round(left / width * 100000), round(top / height * 100000),
            round(left / width * 100000), round(top / height * 100000))
        parts['ppt/slides/slide%d.xml' % number] = XML_HEAD + (
            '<p:sld %s><p:cSld><p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rIdPage"/>'
            '<a:srcRect/><a:stretch>%s</a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>'
            '<p:spTree>%s%s</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
            % (NS_ALL, inset, EMPTY_TREE, ''.join(shapes)))
        parts['ppt/slides/_rels/slide%d.xml.rels' % number] = relationships(
            [('rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml', False),
             ('rIdPage', 'image', '../media/page%d.%s' % (number, extension), False),
             ('rIdNotes', 'notesSlide', '../notesSlides/notesSlide%d.xml' % number, False)]
            + [('rIdLink%d' % (index + 1), 'hyperlink', uri, True) for index, uri in enumerate(links)])
        parts['ppt/notesSlides/notesSlide%d.xml' % number] = notes_part(slide['notes'])
        parts['ppt/notesSlides/_rels/notesSlide%d.xml.rels' % number] = relationships(
            [('rId1', 'notesMaster', '../notesMasters/notesMaster1.xml', False),
             ('rId2', 'slide', '../slides/slide%d.xml' % number, False)])
        slide_ids.append('<p:sldId id="%d" r:id="rIdSlide%d"/>' % (255 + number, number))
        slide_rels.append(('rIdSlide%d' % number, 'slide', 'slides/slide%d.xml' % number, False))
        overrides += [('/ppt/slides/slide%d.xml' % number, PPTX_TYPE + 'slide+xml'),
                      ('/ppt/notesSlides/notesSlide%d.xml' % number, PPTX_TYPE + 'notesSlide+xml')]
    parts['ppt/presentation.xml'] = XML_HEAD + (
        '<p:presentation %s><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>'
        '<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster"/></p:notesMasterIdLst>'
        '<p:sldIdLst>%s</p:sldIdLst><p:sldSz cx="%d" cy="%d"/><p:notesSz cx="6858000" cy="9144000"/>'
        '</p:presentation>' % (NS_ALL, ''.join(slide_ids), emu(width), emu(height)))
    parts['ppt/_rels/presentation.xml.rels'] = relationships(
        [('rIdMaster', 'slideMaster', 'slideMasters/slideMaster1.xml', False),
         ('rIdNotesMaster', 'notesMaster', 'notesMasters/notesMaster1.xml', False),
         ('rIdTheme', 'theme', 'theme/theme1.xml', False)] + slide_rels)
    parts['ppt/slideMasters/slideMaster1.xml'] = XML_HEAD + (
        '<p:sldMaster %s><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
        '<p:spTree>%s</p:spTree></p:cSld><p:clrMap %s/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" '
        'r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>' % (NS_ALL, EMPTY_TREE, COLOUR_MAP))
    parts['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = relationships(
        [('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml', False),
         ('rId2', 'theme', '../theme/theme1.xml', False)])
    parts['ppt/slideLayouts/slideLayout1.xml'] = XML_HEAD + (
        '<p:sldLayout %s type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>%s</p:spTree></p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>' % (NS_ALL, EMPTY_TREE))
    parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = relationships(
        [('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml', False)])
    parts['ppt/notesMasters/notesMaster1.xml'] = notes_master_part()
    parts['ppt/notesMasters/_rels/notesMaster1.xml.rels'] = relationships(
        [('rId1', 'theme', '../theme/theme2.xml', False)])
    parts['ppt/theme/theme1.xml'] = theme_part('Translated document')
    parts['ppt/theme/theme2.xml'] = theme_part('Notes')
    parts['_rels/.rels'] = relationships([('rId1', 'officeDocument', 'ppt/presentation.xml', False)])
    overrides += [('/ppt/presentation.xml', PPTX_TYPE + 'presentation.main+xml'),
                  ('/ppt/slideMasters/slideMaster1.xml', PPTX_TYPE + 'slideMaster+xml'),
                  ('/ppt/slideLayouts/slideLayout1.xml', PPTX_TYPE + 'slideLayout+xml'),
                  ('/ppt/notesMasters/notesMaster1.xml', PPTX_TYPE + 'notesMaster+xml'),
                  ('/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'),
                  ('/ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml')]
    parts['[Content_Types].xml'] = XML_HEAD + (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        '%s</Types>' % ''.join('<Override PartName="%s" ContentType="%s"/>' % entry for entry in overrides))
    packed = io.BytesIO()
    with zipfile.ZipFile(packed, 'w', zipfile.ZIP_DEFLATED) as archive:
        # The content types come first: readers that stream the file expect them there.
        for name in ['[Content_Types].xml'] + sorted(part for part in parts if part != '[Content_Types].xml'):
            stored = name.startswith('ppt/media/')
            archive.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), parts[name],
                             zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)
    return packed.getvalue()


def command_rebuild(job):
    with open(os.path.join(HERE, job['units']), encoding='utf-8') as handle:
        extracted = json.load(handle)
    units, translations = extracted['units'], job['translations']
    styles = job.get('styles') or {}
    rooms = {}
    doc = fitz.open(os.path.join(HERE, job['source']))
    original = fitz.open(os.path.join(HERE, job['source']))
    families = installed_fonts()
    characters = set(re.sub(r'<[^>]+>', '', ''.join(translations.values())))
    sans_name, sans, undrawn = choose_fonts(
        families, job.get('sansFonts', []) + ['Liberation Sans', 'DejaVu Sans'], characters)
    serif_name, serif, _ = choose_fonts(
        families, job.get('serifFonts', []) + ['Liberation Serif', 'DejaVu Serif'], characters)
    if not sans:
        raise SystemExit('NATIVE_REBUILD_FAILED none of the fonts the translation may be set in is installed')
    if undrawn:
        sample = ' '.join('%s (U+%04X)' % (ch, ord(ch)) for ch in sorted(undrawn)[:8])
        raise SystemExit('NATIVE_REBUILD_FAILED no font can draw %d characters of the translation, such as %s; '
                         'set in %s' % (len(undrawn), sample, sans_name))
    css_fonts = font_css('sansbody', sans) + font_css('serifbody', serif or sans)
    archive = fitz.Archive('/')
    report, pages = [], sorted({u['page'] for u in units if u['id'] in translations})
    # SLIDES: page number -> the page without its translated text, and its text boxes.
    as_slides, backgrounds, boxes = bool(job.get('slides')), {}, collections.defaultdict(list)
    for page_no in pages:
        page = doc[page_no - 1]
        page_units = [u for u in units if u['page'] == page_no and u['id'] in translations]
        underlines = [r for u in page_units
                      if any('<a ' in t['open'] or 'underline' in t['open'] for t in u['tags'].values())
                      for r in link_underlines(page, u)]
        remove_pictures(page, [rect for unit in page_units for rect in unit.get('pictures', [])])
        for unit in page_units:
            for rect in unit['spanRects']:
                # A thin band through the middle of the line: redaction removes every glyph whose
                # box it touches, and a full-height box also touches the lines above and below.
                r = fitz.Rect(rect)
                if unit.get('rotate') in (90, 270):
                    # The same band, along a line that runs up or down the page (see DIRECTION).
                    mid = (r.x0 + r.x1) / 2
                    page.add_redact_annot(fitz.Rect(mid - 0.5, r.y0 + 0.5, mid + 0.5, r.y1 - 0.5), fill=False)
                    continue
                mid = (r.y0 + r.y1) / 2
                page.add_redact_annot(fitz.Rect(r.x0 + 0.5, mid - 0.5, r.x1 - 0.5, mid + 0.5), fill=False)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        if underlines:
            for rect in underlines:
                page.add_redact_annot(rect, fill=False)
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                                  graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                                  text=fitz.PDF_REDACT_TEXT_NONE)
            for link in page.get_links():
                if link.get('uri'):
                    page.delete_link(link)
        if as_slides:
            backgrounds[page_no] = slide_picture(page)
        language = job.get('language') or ''
        hyphenated = set()

        def right_to_left(unit):
            return reads_right_to_left(re.sub(r'<[^>]+>', '', translations[unit['id']]))

        def lay_out(target, unit, factor=1.0, place=None):
            """Sets a unit's translation on 'target' at 'factor' of its size, in its room or
            in 'place'; (spare, scale)."""
            # BREAKS: a line break in the translation is set as one.
            written = lower_raised_marks(translations[unit['id']], unit['tags'])
            markup = restore_tags(written, unit['tags']).replace('\n', '<br>')
            # READING DIRECTION: set right to left, from the right edge unless centred. The
            # layout engine reads 'left' as the side a paragraph starts from, which for
            # right-to-left text is the right; 'right' would put it at the left.
            rtl = right_to_left(unit)
            align = unit.get('align', 'left')
            if rtl and align != 'center':
                align = 'left'
            style = styles.get(unit['id']) or {}
            size = style.get('size', unit['size']) * factor
            if unit['size'] and abs(size - unit['size']) > 0.01:
                markup = resize_inline(markup, size / unit['size'])
            css = css_fonts + (
                '* {font-family:%s;} p {margin:0;font-size:%.2fpt;text-align:%s;line-height:%s;color:%s;'
                'font-weight:%s;font-style:%s;}'
                ' a {color:inherit;text-decoration:underline;}%s' % (
                    'serifbody' if unit['serif'] else 'sansbody', size, align,
                    unit['leading'], style.get('color', unit['color']),
                    'bold' if unit['bold'] else 'normal', 'italic' if unit['italic'] else 'normal',
                    ' p {hyphens:auto;}' if unit['id'] in hyphenated else ''))
            attributes = (' dir="rtl"' if rtl else '') + (
                ' lang="%s"' % html.escape(language) if unit['id'] in hyphenated else '')
            paragraph = '<p%s>%%s</p>' % attributes
            return target.insert_htmlbox(place or rooms[unit['id']], paragraph % markup, css=css,
                                         archive=archive, scale_low=MIN_SCALE, rotate=unit.get('rotate', 0))

        for unit in page_units:
            rooms[unit['id']] = styled_room(unit, styles.get(unit['id']) or {}, page.rect)
        if language:
            # HYPHENATION: tried on blank pages, kept only where it lets the text be larger.
            for unit in page_units:
                def trial(unit=unit):
                    blank = fitz.open().new_page(width=page.rect.width, height=page.rect.height)
                    return lay_out(blank, unit)[1]
                whole = trial()
                if whole >= HYPHENATE_BELOW:
                    continue
                hyphenated.add(unit['id'])
                if trial() < whole + HYPHENATE_GAIN:
                    hyphenated.discard(unit['id'])
        # PEERS: a trial on a blank page tells how far each unit would be shrunk on its own.
        trial_page = fitz.open().new_page(width=page.rect.width, height=page.rect.height)
        peer_scale, alone = {}, set()
        for unit in page_units:
            if 'size' in (styles.get(unit['id']) or {}) or not unit.get('peer'):
                continue
            scale = lay_out(trial_page, unit)[1]
            if scale >= PEER_MIN_SCALE:
                peer_scale[unit['peer']] = min(peer_scale.get(unit['peer'], 1.0), scale)
            else:
                alone.add(unit['id'])
        for unit in page_units:
            style = styles.get(unit['id']) or {}
            shared = 1.0
            if 'size' not in style and unit.get('peer') and unit['id'] not in alone:
                shared = peer_scale.get(unit['peer'], 1.0)
            place = fitz.Rect(rooms[unit['id']])
            if unit.get('valign') == 'middle' and not unit.get('rotate') and style.get('size', 0) <= unit['size']:
                # CELLS: set once on the blank page to learn its height, then moved down by
                # half of what it leaves unused, which puts it in the middle of its room.
                unused = lay_out(trial_page, unit, shared)[0]
                if unused > 0:
                    place.y0 += unused / 2
            if right_to_left(unit) and unit.get('align', 'left') != 'center' and not unit.get('rotate'):
                # READING DIRECTION: the unit keeps the source's left edge. Set once on a
                # blank page to learn how wide it is; its place is then no wider than that,
                # plus the least slack with which it is set exactly as it was in the wide one.
                def blank_page_like():
                    return fitz.open().new_page(width=page.rect.width, height=page.rect.height)
                blank = blank_page_like()
                wide = lay_out(blank, unit, shared, place)
                ink = fitz.Rect()
                for block in blank.get_text('dict')['blocks']:
                    if block['type'] == 0:
                        ink |= fitz.Rect(block['bbox'])
                for slack in (GAP, 0.25 * unit['size'], 0.5 * unit['size'], unit['size']):
                    narrow = fitz.Rect(place.x0, place.y0, place.x0 + ink.width + slack, place.y1)
                    if ink.is_empty or narrow.x1 >= place.x1:
                        break
                    spare, scale = lay_out(blank_page_like(), unit, shared, narrow)
                    if scale >= wide[1] - 0.001 and spare >= wide[0] - 0.5:
                        place = narrow
                        break
            spare, scale = lay_out(page, unit, shared, place)
            # Reported against the unit's own size, whoever caused the shrink.
            scale *= shared
            if spare > 0 and style.get('size', 0) > unit['size']:
                # A room stretched for larger text is reported as the height the text used.
                rooms[unit['id']].y1 = max(rooms[unit['id']].y1 - spare, rooms[unit['id']].y0)
                place.y1 = rooms[unit['id']].y1
            # Text is set from the top of where it was placed, so what it left unused is at the bottom.
            used = fitz.Rect(place)
            if not unit.get('rotate'):
                used.y1 = max(used.y1 - max(spare, 0), used.y0)
            if as_slides:
                written = lower_raised_marks(translations[unit['id']], unit['tags'])
                base = style.get('size', unit['size'])
                boxes[page_no].append({
                    # CELLS: a unit set in the middle of its room is anchored there, in the
                    # whole room, so that it stays in the middle when its text is edited.
                    'rect': (place.x0, rooms[unit['id']].y0, place.x1, rooms[unit['id']].y1)
                            if unit.get('valign') == 'middle' and not unit.get('rotate') else tuple(place),
                    'markup': restore_tags(written, unit['tags']),
                    'baseSize': unit['size'], 'sizeFactor': base * scale / unit['size'] if unit['size'] else 1.0,
                    'bold': unit['bold'], 'italic': unit['italic'],
                    'color': style.get('color', unit['color']), 'leading': unit['leading'],
                    'typeface': SLIDE_SERIF if unit['serif'] else SLIDE_SANS,
                    'rtl': right_to_left(unit), 'rotate': unit.get('rotate', 0),
                    'middle': unit.get('valign') == 'middle',
                    'align': 'right' if right_to_left(unit) and unit.get('align', 'left') != 'center'
                             else unit.get('align', 'left')})
            report.append({'id': unit['id'], 'page': page_no, 'n': unit['n'],
                           'scale': round(scale, 3), 'fits': spare >= 0,
                           'used': [round(v, 1) for v in used]})
    # Images are the slow, heavy part of the output: a caller that already holds a page's
    # images (it did not change) asks for the others only. Absent means every rebuilt page.
    image_pages = job.get('imagePages')
    files = {}
    for page_no in pages:
        if image_pages is not None and page_no not in image_pages:
            continue
        # Outlined where each translation was actually laid out.
        labelled = [dict(u, room=list(rooms[u['id']])) for u in units
                    if u['page'] == page_no and u['id'] in translations]
        files['check_%d.png' % page_no] = side_by_side(render(original[page_no - 1]),
                                                       render(doc[page_no - 1], labelled, outline='room'))
        files['preview_%d.png' % page_no] = render(doc[page_no - 1], dpi=PAGE_IMAGE_DPI)
    # Which pages the output holds. Page images above are made first and are named by the
    # page's number in the SOURCE, so leaving pages out never renumbers anything a caller
    # holds. 'omitPages' are source page numbers the person removed from the result.
    omitted = set(job.get('omitPages') or [])
    kept = [p for p in (pages if job.get('onlyTranslatedPages') else range(1, doc.page_count + 1))
            if p not in omitted]
    if not kept:
        raise SystemExit('NATIVE_REBUILD_FAILED every page of the document was left out')
    if as_slides:
        slides = []
        for page_no in kept:
            source_page = original[page_no - 1]
            slides.append({
                'size': (source_page.rect.width, source_page.rect.height),
                'picture': backgrounds.get(page_no) or slide_picture(source_page),
                'boxes': boxes.get(page_no, []),
                'notes': [html.unescape(re.sub(r'<[^>]+>', '', u['text'])).replace('\n', ' ')
                          for u in units if u['page'] == page_no and u['id'] in translations]})
        files['translated.pptx'] = write_slides(slides, job.get('language') or '')
    if len(kept) < doc.page_count:
        doc.select([p - 1 for p in kept])
    doc.subset_fonts()
    files['translated.pdf'] = doc.tobytes(garbage=3, deflate=True)
    files['report.json'] = json.dumps({'fonts': {'sans': sans_name, 'serif': serif_name or sans_name},
                                       'units': report}, ensure_ascii=False)
    write_zip('native_rebuild.zip', files)
    print('NATIVE_REBUILD_OK pages=%d units=%d' % (len(pages), len(report)))


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'extract':
        command_extract(load_job())
    elif command == 'rebuild':
        command_rebuild(load_job())
    else:
        raise SystemExit('usage: pdf_native.py extract|rebuild')
`;
