/**
 * Saves a rendered chart as SVG or PNG.
 *
 * The charts are styled with utility classes, which live in a stylesheet and
 * do not travel with a serialized SVG. Each element's COMPUTED presentation
 * is therefore written onto a copy as attributes first, so the saved file
 * looks like what is on screen — in the theme it was saved from, on that
 * theme's background.
 */

const PRESENTATION: [css: string, attribute: string][] = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['stroke-width', 'stroke-width'],
  ['stroke-dasharray', 'stroke-dasharray'],
  ['opacity', 'opacity'],
  ['font-size', 'font-size'],
  ['font-family', 'font-family'],
  ['font-weight', 'font-weight'],
  ['text-anchor', 'text-anchor'],
];

const LIGHT_BACKGROUND = '#ffffff';
const DARK_BACKGROUND = '#212121';

function viewBoxSize(svg: SVGSVGElement): { width: number; height: number } {
  const box = svg.viewBox.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    return { width: box.width, height: box.height };
  }
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 640, height: rect.height || 240 };
}

/** A standalone SVG document of the chart as currently rendered. */
export function serializeChart(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...svg.querySelectorAll('*')];
  const targets = [copy, ...copy.querySelectorAll('*')];
  sources.forEach((source, index) => {
    const target = targets[index];
    if (!target) return;
    const computed = window.getComputedStyle(source);
    for (const [css, attribute] of PRESENTATION) {
      const value = computed.getPropertyValue(css);
      if (value) target.setAttribute(attribute, value);
    }
    target.removeAttribute('class');
  });

  const { width, height } = viewBoxSize(svg);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));

  const background = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'rect',
  );
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute(
    'fill',
    document.documentElement.classList.contains('dark')
      ? DARK_BACKGROUND
      : LIGHT_BACKGROUND,
  );
  copy.insertBefore(background, copy.firstChild);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}`;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a later tick: some browsers start the download asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Twice the chart's size, so it stays sharp when pasted into a document. */
const PNG_SCALE = 2;

async function toPng(markup: string, svg: SVGSVGElement): Promise<Blob> {
  const { width, height } = viewBoxSize(svg);
  const url = URL.createObjectURL(
    new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not render the chart'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * PNG_SCALE;
    canvas.height = height * PNG_SCALE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not render the chart');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('Could not render the chart')),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveChart(
  svg: SVGSVGElement,
  baseName: string,
  format: 'svg' | 'png',
): Promise<void> {
  const markup = serializeChart(svg);
  const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80);
  if (format === 'svg') {
    saveBlob(
      new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
      `${safeName}.svg`,
    );
    return;
  }
  saveBlob(await toPng(markup, svg), `${safeName}.png`);
}
