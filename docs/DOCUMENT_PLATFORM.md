# Document platform: plan and acceptance criteria

The format-level machinery built for document translation (rendering,
reading a file's structure, rewriting it, background jobs, the page viewer)
is moved into a documents layer that knows nothing about translation, so
other features can use it. Translation becomes its first consumer and keeps
everything that is about translating.

Three features use it, in this order, each one moving only what it needs:

1. **Preview**: any document the app holds (an upload, a translation
   service's output) can be opened as pages.
2. **Brand review**: a PDF, Word document or presentation is checked
   against a brand book: language, fonts, colors, logos.
3. **Deck builder**: a presentation is generated from a brief and sources,
   on a brand book's template.

## Layers

```
lib/services/documents/
  render/        LibreOffice and pdftoppm behind one queue (was presentationRender)
  sandbox/       the code-interpreter script runner
  model/         per-format adapters: inspect, apply edits, compose
  review/        a model looks at a page and reports findings by unit
lib/services/backgroundJobs/   stored, resumable, stoppable jobs
lib/services/brand/            brand books: storage, access, derivation
components/Documents/          page viewer, rail, overlays, compare
```

Rules:

- `lib/services/documents`, `lib/services/backgroundJobs` and
  `components/Documents` never import from translation, brand review or the
  deck builder. A test checks the import graph.
- A piece moves when its second consumer arrives; until then it stays with
  its only user.
- Translation's tests are the safety net for every move: they pass with
  only their imports changed.

## Phase A: foundations (no behaviour change)

- [ ] `presentationRender` is `lib/services/documents/render`; the render
      lanes are `interactive` and `background` (was `translation`),
      including the queue snapshot, the HTTP contract and its docs.
- [ ] The sandbox script runner is `lib/services/documents/sandbox`.
- [ ] The page-picture cache is part of `documents/render`.
- [ ] An import-boundary test fails if the documents layer imports a
      feature.
- [ ] Every translation and render test passes with only imports changed.

## Phase B: preview

- [ ] A document source is one type naming where a file lives (an upload,
      a document translation output), resolved on the server with the
      owner's access checked; a source of someone else's resolves to
      nothing.
- [ ] `GET /api/documents/pdf?source=...` returns the source as a PDF
      (converted on the interactive lane, a PDF passed through); it
      replaces `/api/file/[id]/slides`. Size limit, unsupported type,
      encrypted file and busy queue each have their own answer and test.
- [ ] `components/Documents` has a viewer (page, rail, zoom, keyboard,
      an overlay layer of labelled boxes) with no translation knowledge;
      unit words (page or slide) come from a `documents` message group.
- [ ] The formatted translation review uses the viewer; its tests pass.
- [ ] A Text only translation's output (Word, PowerPoint, PDF) can be
      previewed from the chat message that holds it.
- [ ] Checked in the browser harness.

## Phase C: document model

- [ ] `inspect` returns a `DocumentModel` for `.pptx` (and its kinds),
      `.pdf` and `.docx`: pages, text units with box, kind and runs (font,
      size, color, weight, language), images with box and a hash, and the
      declared theme (colors, fonts) where the format has one.
- [ ] Unit ids carry a scheme version; ids are stable for an unchanged
      file across runs (tested).
- [ ] Translation's extract is built on `inspect` for decks; its tests pass.
- [ ] `apply(file, edits)` applies generic edits (text, style, color,
      font) to a deck; translation's rebuild uses it.

## Phase D: background jobs

- [ ] THE JOB CONVENTION lives in `lib/services/backgroundJobs`: a job
      kind declares its request, state and steps; the runner stores
      state, beats, resumes a stalled job, stops on request, and limits
      active jobs per person and kind.
- [ ] The deck translation job is a job kind; its tests pass.
- [ ] One client hook starts, follows, reattaches to and stops any kind.

## Phase E: brand books

- [ ] A brand book holds: palette (named colors, roles, a tolerance),
      fonts by role with allowed substitutes, logos (files, minimum size,
      allowed colors), language (locales, preferred and banned terms,
      tone), templates (`.potx`, `.pptx`, `.dotx`), and its source
      document.
- [ ] Admins manage brand books in Agent access, with per-book access
      rules like form templates; people list only the books they may use.
- [ ] A draft brand book can be derived from an uploaded brand-guide PDF
      and edited before saving.

## Phase F: brand review

- [ ] Deterministic checks over the document model: fonts outside the
      book, colors outside the palette (by perceptual distance, with the
      book's tolerance, tested on both sides), text below a minimum size,
      banned terms, language other than the book's.
- [ ] Logo checks: each image is matched against the book's logos;
      a match is checked for distortion (aspect ratio), size and color;
      a model looks at pages with a logo-like image the matcher could not
      place.
- [ ] A model review of each page against the book's tone and visual
      rules, findings tied to units or boxes.
- [ ] Runs as a background job; results show in the viewer as overlays and
      in a findings list, and download as a report.
- [ ] A "Brand review" workflow: pick a book, add a file, run, review.
- [ ] Checked in the browser harness.

## Phase G: deck builder

- [ ] `compose(template, plan)` builds a deck from a template's layouts:
      slides by layout, placeholders filled (title, text, bullets,
      images), the template's sample slides removed, masters kept.
- [ ] A plan is generated by a model from a brief, sources and the
      template's layouts, validated against them; invalid plans are
      repaired or refused with the reason.
- [ ] The built deck is rendered, overflow is fitted, and a brand review
      runs on it before it is offered.
- [ ] A "Deck builder" workflow: brief and sources, brand book or template,
      an editable outline, build, view, download.
- [ ] Checked in the browser harness.
