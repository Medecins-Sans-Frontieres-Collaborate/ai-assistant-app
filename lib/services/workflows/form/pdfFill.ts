import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFFont,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
} from 'pdf-lib';

/**
 * PDF AcroForm detection and in-place filling
 * (docs/DOCUMENT_FILL_ASSESSMENT.md §7a, `pdf-acroform` mode) via pdf-lib.
 * Writes go through the form API only — no content-stream surgery.
 *
 * Limitation, reported per field rather than hidden: pdf-lib's standard
 * fonts are WinAnsi, so a text value with characters outside Latin-1 fails
 * to render an appearance and is left unfilled with a `reason`.
 */

export type PdfFieldKind =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'other';

export interface PdfFieldInfo {
  name: string;
  kind: PdfFieldKind;
  options?: string[];
  multiline?: boolean;
  /** Current value when the form ships pre-filled. */
  value?: string;
}

export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

export async function detectPdfFields(
  bytes: Uint8Array,
): Promise<PdfFieldInfo[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  return form.getFields().map((field) => {
    const name = field.getName();
    if (field instanceof PDFTextField) {
      return {
        name,
        kind: 'text',
        multiline: field.isMultiline(),
        value: field.getText() ?? undefined,
      };
    }
    if (field instanceof PDFCheckBox) {
      return {
        name,
        kind: 'checkbox',
        value: field.isChecked() ? 'true' : undefined,
      };
    }
    if (field instanceof PDFRadioGroup) {
      return {
        name,
        kind: 'radio',
        options: field.getOptions(),
        value: field.getSelected() ?? undefined,
      };
    }
    if (field instanceof PDFDropdown) {
      return {
        name,
        kind: 'dropdown',
        options: field.getOptions(),
        value: field.getSelected()[0],
      };
    }
    if (field instanceof PDFOptionList) {
      return {
        name,
        kind: 'optionlist',
        options: field.getOptions(),
        value: field.getSelected()[0],
      };
    }
    return { name, kind: 'other' };
  });
}

export type PdfFillValue = string | boolean;

export interface PdfFillResult {
  bytes: Uint8Array;
  filled: string[];
  failed: Array<{ name: string; reason: string }>;
  missing: string[];
}

function truthy(value: PdfFillValue): boolean {
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', '1', 'y', 'checked', 'x'].includes(
    value.trim().toLowerCase(),
  );
}

function pickOption(options: string[], value: string): string | undefined {
  const wanted = value.trim().toLowerCase();
  return options.find((o) => o.toLowerCase() === wanted);
}

export async function fillPdfFields(
  bytes: Uint8Array,
  values: Record<string, PdfFillValue>,
  options: { flatten?: boolean } = {},
): Promise<PdfFillResult> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const filled: string[] = [];
  const failed: PdfFillResult['failed'] = [];
  const present = new Set(form.getFields().map((f) => f.getName()));
  const missing = Object.keys(values).filter((name) => !present.has(name));
  let font: PDFFont | undefined;
  const appearanceFont = async () => {
    if (!font) font = await doc.embedFont(StandardFonts.Helvetica);
    return font;
  };

  for (const [name, value] of Object.entries(values)) {
    if (!present.has(name)) continue;
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) {
        const previous = field.getText();
        field.setText(
          typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value,
        );
        // Force the appearance now so an unrenderable glyph fails HERE,
        // attributable to this field, not at save time for the whole form.
        try {
          field.updateAppearances(await appearanceFont());
        } catch (error) {
          // Roll the value back. The previous value may be unrenderable
          // too (a form pre-filled in a non-Latin script keeps its own
          // appearance stream), so the re-render is best-effort — and the
          // save below never re-renders, so a stale appearance cannot take
          // the whole export down.
          field.setText(previous);
          try {
            field.updateAppearances(await appearanceFont());
          } catch {
            // keep the existing appearance stream
          }
          throw error;
        }
      } else if (field instanceof PDFCheckBox) {
        if (truthy(value)) field.check();
        else field.uncheck();
        field.updateAppearances();
      } else if (field instanceof PDFRadioGroup) {
        const option = pickOption(field.getOptions(), String(value));
        if (!option) throw new Error('No matching option');
        field.select(option);
        field.updateAppearances();
      } else if (field instanceof PDFDropdown) {
        const option = pickOption(field.getOptions(), String(value));
        if (option) field.select(option);
        else if (field.isEditable()) field.select(String(value));
        else throw new Error('No matching option');
        field.updateAppearances(await appearanceFont());
      } else if (field instanceof PDFOptionList) {
        const option = pickOption(field.getOptions(), String(value));
        if (!option) throw new Error('No matching option');
        field.select(option);
        field.updateAppearances(await appearanceFont());
      } else {
        throw new Error('Unsupported field type');
      }
      filled.push(name);
    } catch (error) {
      failed.push({
        name,
        reason: error instanceof Error ? error.message : 'Could not fill',
      });
    }
  }
  if (options.flatten) {
    try {
      form.flatten();
    } catch {
      // Flattening is cosmetic; a failure must not lose the filled values.
    }
  }
  // Appearances were rendered per field above (and failures attributed);
  // never let save() re-render the whole form.
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, filled, failed, missing };
}
