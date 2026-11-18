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
  - Nothing is ever painted over the page: source text is removed from the
    content stream, so there is no cover-up rectangle to show through.
"""
import collections, html, io, json, os, re, subprocess, sys, zipfile

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_FONT = re.compile(r'fontawesome|symbol|dingbat|wingding|icon|glyph|material', re.I)
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
PANEL_TOLERANCE = 1.0     # a unit this far outside a shape's edge still counts as inside it


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


def is_paragraph(lines):
    """Stacked lines sharing a left edge; anything else (a table row) is split per line."""
    if len(lines) < 2:
        return False
    tops = [line['bbox'][1] for line in lines]
    lefts = [line['bbox'][0] for line in lines]
    stacked = all(b > a + 1 for a, b in zip(tops, tops[1:]))
    return stacked and max(lefts) - min(lefts) < SAME_LEFT_EDGE


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


def build_unit(uid, page_no, lines, links):
    spans = [s for line in lines for s in line['spans'] if s['text'].strip()]
    if not spans or not any(ch.isalpha() for s in spans for ch in s['text']):
        return None
    weight = collections.Counter()
    for s in spans:
        st = span_style(s)
        weight[(st['bold'], st['italic'], st['color'], round(s['size'], 1), s['font'])] += len(s['text'])
    (dbold, ditalic, dcolor, dsize, dfont), _ = weight.most_common(1)[0]
    book, parts = TagBook(), []
    for line in lines:
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
            elif st['color'] != dcolor:
                text = book.wrap(text, '<span style="color:%s">' % st['color'], '</span>')
            if abs(s['size'] - dsize) > 0.6:
                text = book.wrap(text, '<span style="font-size:%.1fpt">' % s['size'], '</span>')
            if st['bold'] and not dbold:
                text = '<b>%s</b>' % text
            elif dbold and not st['bold']:
                text = book.wrap(text, '<span style="font-weight:normal">', '</span>')
            if st['italic'] and not ditalic:
                text = '<i>%s</i>' % text
            elif ditalic and not st['italic']:
                text = book.wrap(text, '<span style="font-style:normal">', '</span>')
            parts.append(text)
        parts.append(' ')
    markup = re.sub(r'\s+', ' ', ''.join(parts)).strip()
    markup = re.sub(r'</(b|i)> <\1>', ' ', markup)
    bbox = fitz.Rect()
    for s in spans:
        bbox |= fitz.Rect(s['bbox'])
    baselines = [line['spans'][0]['origin'][1] for line in lines if line['spans']]
    leading = 1.2
    if len(baselines) > 1 and baselines[-1] > baselines[0]:
        leading = (baselines[-1] - baselines[0]) / (len(baselines) - 1) / dsize
    return {
        'id': uid, 'page': page_no, 'bbox': [round(v, 2) for v in bbox],
        'spanRects': [[round(v, 2) for v in s['bbox']] for s in spans],
        'lines': len(lines), 'size': dsize, 'bold': dbold, 'italic': ditalic, 'color': dcolor,
        'serif': bool(SERIF_FONT.search(dfont)), 'leading': round(min(max(leading, 0.8), 2.0), 3),
        'text': markup, 'tags': book.tags,
        'chars': len(re.sub(r'<[^>]+>', '', markup)),
    }


def page_obstacles(page, blocks):
    """Things a translation must not run into besides other text: images and icon glyphs."""
    rects = [fitz.Rect(info['bbox']) for info in page.get_image_info()]
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


def panel_of(box, panels):
    """The smallest panel holding a unit's source text, or None."""
    grown = [p for p in panels
             if (p + (-PANEL_TOLERANCE, -PANEL_TOLERANCE, PANEL_TOLERANCE, PANEL_TOLERANCE)).contains(box)]
    return min(grown, key=lambda p: p.get_area()) if grown else None


def assign_room(units, obstacles, page_rect, panels=()):
    """Derives each unit's 'room' (where its translation may go) from the free space around it."""
    for unit in units:
        box = fitz.Rect(unit['bbox'])
        right_limit = page_rect.x1 - min(box.x0, page_rect.width * 0.08)
        bottom_limit = page_rect.y1 - 18
        panel = panel_of(box, panels)
        if panel is not None:
            # Kept as clear of the panel's far edges as the source is of its near one.
            inset = min(max(box.x0 - panel.x0, 0.0), PANEL_MAX_INSET)
            right_limit = min(right_limit, max(panel.x1 - inset, box.x1))
            bottom_limit = min(bottom_limit, max(panel.y1 - inset, box.y1))
            unit['panel'] = [round(v, 2) for v in panel]
        others = [fitz.Rect(o['bbox']) for o in units if o is not unit]
        for o in others + obstacles:
            same_row = o.y0 < box.y1 - 1 and o.y1 > box.y0 + 1
            same_column = o.x0 < box.x1 - 1 and o.x1 > box.x0 + 1
            if same_row and o.x0 >= box.x1 - 1:
                right_limit = min(right_limit, o.x0 - GAP * 2)
        for o in others:
            same_column = o.x0 < box.x1 - 1 and o.x1 > box.x0 + 1
            # Adjacent lines' boxes overlap by their ascenders, so "below" means starting lower.
            if same_column and o.y0 > box.y0 + 1:
                bottom_limit = min(bottom_limit, o.y0 - GAP)
        # Paragraphs keep their column width, unless a panel says how wide the column really
        # is; single lines may grow sideways into free space.
        x1 = box.x1 if unit['lines'] > 1 and panel is None else max(box.x1, right_limit)
        first_line_bottom = box.y0 + unit['size'] * 1.3
        # Growth downward is capped: free space below a block is often a different background.
        y1 = min(bottom_limit, box.y1 + MAX_GROWTH * box.height + unit['size'])
        y1 = max(y1, min(box.y1, first_line_bottom))
        unit['room'] = [round(box.x0, 2), round(box.y0, 2), round(max(x1, box.x1), 2), round(y1, 2)]
        source_area = max(box.get_area(), 1.0)
        unit['roomFactor'] = round(fitz.Rect(unit['room']).get_area() / source_area, 2)


def extract_units(doc, pages):
    units = []
    for page_no in pages:
        page = doc[page_no - 1]
        links = page.get_links()
        blocks = page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']
        page_units = []
        for bi, block in enumerate(blocks):
            if block['type'] != 0:
                continue
            lines = [dict(line, spans=[s for s in line['spans'] if not ICON_FONT.search(s['font'])])
                     for line in block['lines']]
            lines = [line for line in lines if line['spans']]
            groups = [lines] if is_paragraph(lines) else [[line] for line in lines]
            for gi, group in enumerate(groups):
                unit = build_unit('p%d-b%d-%d' % (page_no, bi, gi), page_no, group, links)
                if unit:
                    page_units.append(unit)
        assign_room(page_units, page_obstacles(page, blocks), page.rect, page_panels(page))
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


def covers(path, characters):
    try:
        from fontTools.ttLib import TTFont
        cmap = TTFont(path, lazy=True, fontNumber=0).getBestCmap() or {}
    except Exception:
        return False
    return all(ord(ch) in cmap or not ch.isprintable() or ch.isspace() for ch in characters)


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
    """Thin horizontal strokes under linked source text: part of the text, so removed with it."""
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
    sans_name, sans = choose_family(families, job.get('sansFonts', []) + ['Liberation Sans', 'DejaVu Sans'], characters)
    serif_name, serif = choose_family(families, job.get('serifFonts', []) + ['Liberation Serif', 'DejaVu Serif'], characters)
    if not sans:
        raise SystemExit('NATIVE_REBUILD_FAILED no installed font covers the target text')
    css_fonts = font_css('sansbody', sans) + font_css('serifbody', serif or sans)
    archive = fitz.Archive('/')
    report, pages = [], sorted({u['page'] for u in units if u['id'] in translations})
    for page_no in pages:
        page = doc[page_no - 1]
        page_units = [u for u in units if u['page'] == page_no and u['id'] in translations]
        underlines = [r for u in page_units if any('<a ' in t['open'] for t in u['tags'].values())
                      for r in link_underlines(page, u)]
        for unit in page_units:
            for rect in unit['spanRects']:
                # A thin band through the middle of the line: redaction removes every glyph whose
                # box it touches, and a full-height box also touches the lines above and below.
                r = fitz.Rect(rect)
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
        for unit in page_units:
            markup = restore_tags(translations[unit['id']], unit['tags'])
            style = styles.get(unit['id']) or {}
            rooms[unit['id']] = styled_room(unit, style, page.rect)
            if 'size' in style and unit['size']:
                markup = resize_inline(markup, style['size'] / unit['size'])
            css = css_fonts + (
                '* {font-family:%s;} p {margin:0;font-size:%spt;line-height:%s;color:%s;font-weight:%s;font-style:%s;}'
                ' a {color:inherit;text-decoration:underline;}' % (
                    'serifbody' if unit['serif'] else 'sansbody', style.get('size', unit['size']),
                    unit['leading'], style.get('color', unit['color']),
                    'bold' if unit['bold'] else 'normal', 'italic' if unit['italic'] else 'normal'))
            spare, scale = page.insert_htmlbox(rooms[unit['id']], '<p>%s</p>' % markup, css=css,
                                               archive=archive, scale_low=MIN_SCALE)
            if spare > 0 and style.get('size', 0) > unit['size']:
                # A room stretched for larger text is reported as the height the text used.
                rooms[unit['id']].y1 = max(rooms[unit['id']].y1 - spare, rooms[unit['id']].y0)
            # Text is set from the top of its room, so what it left unused is at the bottom.
            used = fitz.Rect(rooms[unit['id']])
            used.y1 = max(used.y1 - max(spare, 0), used.y0)
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
