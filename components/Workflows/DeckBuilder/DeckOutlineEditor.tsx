'use client';

import {
  IconArrowDown,
  IconArrowUp,
  IconLoader,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useId, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import {
  CheckedDeckPlan,
  DeckFill,
  DeckLayout,
  DeckPlaceholder,
  DeckPlan,
  DeckSlidePlan,
  textFit,
} from '@/lib/utils/shared/documents/deckPlan';

import { bulletsToText, textToBullets } from './bulletsText';

/** A picture the outline may place (THE PICTURE KEYS, deckInputs.ts). */
export interface OutlinePicture {
  key: string;
  name: string;
}

const field =
  'block w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
const iconButton =
  'rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-30 dark:hover:bg-gray-800 dark:hover:text-gray-100';

/** A fresh fill for a placeholder: what it most likely holds. */
function emptyFill(place: DeckPlaceholder): DeckFill {
  if (place.role === 'picture') {
    return { placeholder: place.key, kind: 'image', image: '', alt: '' };
  }
  if (place.accepts.includes('bullets')) {
    return { placeholder: place.key, kind: 'bullets', bullets: [] };
  }
  return { placeholder: place.key, kind: 'text', text: '' };
}

/** How a text fill fits its placeholder, as the server will judge it. */
function fitOf(fill: DeckFill, place: DeckPlaceholder) {
  if (fill.kind === 'image') return 'fits';
  const paragraphs =
    fill.kind === 'bullets'
      ? fill.bullets
          .filter((bullet) => bullet.text.trim())
          .map((bullet) => ({ text: bullet.text.trim(), level: bullet.level }))
      : fill.text.split('\n').map((text) => ({ text, level: null }));
  return paragraphs.length ? textFit(paragraphs, place) : 'fits';
}

/** One placeholder of a slide, edited by its kind. */
function PlaceholderEditor({
  place,
  fill,
  pictures,
  onChange,
}: {
  place: DeckPlaceholder;
  fill: DeckFill;
  pictures: readonly OutlinePicture[];
  onChange: (fill: DeckFill) => void;
}) {
  const t = useTranslations('workflows.deckBuilder.outline');
  const id = useId();
  const fit = fitOf(fill, place);
  const canPicture = place.accepts.includes('image');
  const canText = place.accepts.includes('text');
  const label = t(`role.${place.role}`);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <label
          htmlFor={id}
          className="text-xs font-medium text-gray-700 dark:text-gray-300"
        >
          {label}
        </label>
        {canPicture && canText && (
          <select
            aria-label={t('holds', { place: label })}
            className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            value={fill.kind === 'image' ? 'image' : 'text'}
            onChange={(event) =>
              onChange(
                event.target.value === 'image'
                  ? {
                      placeholder: place.key,
                      kind: 'image',
                      image: '',
                      alt: '',
                    }
                  : { placeholder: place.key, kind: 'bullets', bullets: [] },
              )
            }
          >
            <option value="text">{t('kindText')}</option>
            <option value="image">{t('kindPicture')}</option>
          </select>
        )}
        {fill.kind !== 'image' && place.accepts.includes('bullets') && (
          <label className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={fill.kind === 'bullets'}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? {
                        placeholder: place.key,
                        kind: 'bullets',
                        bullets: textToBullets(
                          fill.kind === 'text' ? fill.text : '',
                        ),
                      }
                    : {
                        placeholder: place.key,
                        kind: 'text',
                        text:
                          fill.kind === 'bullets'
                            ? fill.bullets
                                .map((bullet) => bullet.text.trim())
                                .join('\n')
                            : '',
                      },
                )
              }
            />
            {t('bullets')}
          </label>
        )}
      </div>
      {fill.kind === 'image' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            id={id}
            className={field}
            value={fill.image}
            onChange={(event) =>
              onChange({ ...fill, image: event.target.value })
            }
          >
            <option value="">{t('noPicture')}</option>
            {pictures.map((picture) => (
              <option key={picture.key} value={picture.key}>
                {picture.name}
              </option>
            ))}
          </select>
          <input
            className={field}
            aria-label={t('alt')}
            placeholder={t('alt')}
            value={fill.alt}
            maxLength={300}
            onChange={(event) => onChange({ ...fill, alt: event.target.value })}
          />
        </div>
      ) : place.role === 'title' ? (
        <input
          id={id}
          className={`${field} font-medium`}
          value={fill.kind === 'text' ? fill.text : ''}
          maxLength={400}
          aria-describedby={fit === 'fits' ? undefined : `${id}-fit`}
          onChange={(event) =>
            onChange({
              placeholder: place.key,
              kind: 'text',
              text: event.target.value,
            })
          }
        />
      ) : (
        <textarea
          id={id}
          className={`${field} min-h-[72px] font-normal`}
          rows={Math.min(Math.max(place.lines, 2), 8)}
          value={
            fill.kind === 'bullets' ? bulletsToText(fill.bullets) : fill.text
          }
          aria-describedby={`${id}-hint`}
          onChange={(event) =>
            onChange(
              fill.kind === 'bullets'
                ? { ...fill, bullets: textToBullets(event.target.value) }
                : { ...fill, text: event.target.value },
            )
          }
        />
      )}
      <p
        id={place.role === 'title' ? `${id}-fit` : `${id}-hint`}
        className={`mt-1 text-xs ${
          fit === 'too-long'
            ? 'text-red-600 dark:text-red-400'
            : fit === 'shrinks'
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        {fit === 'too-long'
          ? t('tooLong', { lines: place.lines, chars: place.charsPerLine })
          : fit === 'shrinks'
            ? t('shrinks')
            : fill.kind === 'bullets'
              ? t('bulletsHint')
              : place.role === 'title' || fill.kind === 'image'
                ? null
                : t('room', { lines: place.lines, chars: place.charsPerLine })}
      </p>
    </div>
  );
}

/** One slide: its layout, its placeholders, its notes. */
function SlideEditor({
  number,
  count,
  slide,
  layouts,
  pictures,
  onChange,
  onMove,
  onRemove,
}: {
  number: number;
  count: number;
  slide: DeckSlidePlan;
  layouts: readonly DeckLayout[];
  pictures: readonly OutlinePicture[];
  onChange: (slide: DeckSlidePlan) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('workflows.deckBuilder.outline');
  const layout = layouts.find((item) => item.id === slide.layout);

  const setLayout = (id: string) => {
    const next = layouts.find((item) => item.id === id);
    if (!next) return;
    // Text carries over by role, so changing the layout keeps the title
    // and the main text.
    const fills = next.placeholders.flatMap((place) => {
      const same = slide.fills.find((fill) => fill.placeholder === place.key);
      const byRole = layout?.placeholders.find(
        (old) =>
          old.role === place.role &&
          slide.fills.some((fill) => fill.placeholder === old.key),
      );
      const carried =
        same ??
        (byRole && slide.fills.find((fill) => fill.placeholder === byRole.key));
      return carried && place.accepts.includes(carried.kind)
        ? [{ ...carried, placeholder: place.key }]
        : [];
    });
    onChange({ ...slide, layout: id, fills });
  };

  return (
    <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('slide', { number })}
        </h3>
        <select
          aria-label={t('layoutOf', { number })}
          className="ms-1 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 sm:flex-none"
          value={slide.layout}
          onChange={(event) => setLayout(event.target.value)}
        >
          {!layout && <option value={slide.layout}>{slide.layout}</option>}
          {layouts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <span className="ms-auto flex items-center">
          <button
            type="button"
            className={iconButton}
            aria-label={t('moveUp', { number })}
            disabled={number === 1}
            onClick={() => onMove(-1)}
          >
            <IconArrowUp size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label={t('moveDown', { number })}
            disabled={number === count}
            onClick={() => onMove(1)}
          >
            <IconArrowDown size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label={t('remove', { number })}
            onClick={onRemove}
          >
            <IconTrash size={16} aria-hidden />
          </button>
        </span>
      </div>
      <div className="space-y-3">
        {layout?.placeholders.map((place) => {
          const fill =
            slide.fills.find((item) => item.placeholder === place.key) ??
            emptyFill(place);
          return (
            <PlaceholderEditor
              key={place.key}
              place={place}
              fill={fill}
              pictures={pictures}
              onChange={(next) =>
                onChange({
                  ...slide,
                  fills: [
                    ...slide.fills.filter(
                      (item) => item.placeholder !== place.key,
                    ),
                    next,
                  ].sort(
                    (a, b) =>
                      layout.placeholders.findIndex(
                        (p) => p.key === a.placeholder,
                      ) -
                      layout.placeholders.findIndex(
                        (p) => p.key === b.placeholder,
                      ),
                  ),
                })
              }
            />
          );
        })}
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">
            {slide.notes.trim() ? t('notesSome') : t('notesNone')}
          </summary>
          <textarea
            aria-label={t('notesOf', { number })}
            className={`${field} mt-2 min-h-[56px]`}
            value={slide.notes}
            maxLength={4000}
            onChange={(event) =>
              onChange({ ...slide, notes: event.target.value })
            }
          />
        </details>
      </div>
    </li>
  );
}

/**
 * The outline of a deck, edited in place: slides in order, each with its
 * layout, its placeholders' content and its speaker notes. Every field
 * says how its text fits, by the same measure the server checks
 * (THE PLAN CAPACITY); the deck builds once nothing blocks it.
 */
export function DeckOutlineEditor({
  layouts,
  plan,
  checked,
  pictures,
  onChange,
  onBuild,
  building,
  error,
}: {
  layouts: readonly DeckLayout[];
  plan: DeckPlan;
  checked: CheckedDeckPlan;
  pictures: readonly OutlinePicture[];
  onChange: (plan: DeckPlan) => void;
  onBuild: () => void;
  building: boolean;
  error: string | null;
}) {
  const t = useTranslations('workflows.deckBuilder.outline');
  const contentLayout = useMemo(
    () =>
      layouts.find((layout) => layout.type === 'obj') ??
      layouts.find((layout) =>
        layout.placeholders.some((place) => place.accepts.includes('bullets')),
      ) ??
      layouts[0],
    [layouts],
  );
  const setSlide = (index: number, slide: DeckSlidePlan) =>
    onChange({
      slides: plan.slides.map((item, at) => (at === index ? slide : item)),
    });
  const move = (index: number, by: -1 | 1) => {
    const slides = [...plan.slides];
    const [taken] = slides.splice(index, 1);
    slides.splice(index + by, 0, taken);
    onChange({ slides });
  };
  const blocking = checked.blocking;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6">
      <ol className="space-y-3" aria-label={t('slides')}>
        {plan.slides.map((slide, index) => (
          <SlideEditor
            // Slides have no ids; order is their identity while editing.
            key={index}
            number={index + 1}
            count={plan.slides.length}
            slide={slide}
            layouts={layouts}
            pictures={pictures}
            onChange={(next) => setSlide(index, next)}
            onMove={(by) => move(index, by)}
            onRemove={() =>
              onChange({ slides: plan.slides.filter((_, at) => at !== index) })
            }
          />
        ))}
      </ol>
      {contentLayout && (
        <button
          type="button"
          onClick={() =>
            onChange({
              slides: [
                ...plan.slides,
                { layout: contentLayout.id, fills: [], notes: '' },
              ],
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <IconPlus size={16} aria-hidden />
          {t('addSlide')}
        </button>
      )}
      <div className="sticky bottom-0 -mx-4 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 sm:-mx-6 sm:px-6">
        {blocking.length > 0 && (
          <div
            role="alert"
            className="mb-2 text-sm text-red-700 dark:text-red-400"
          >
            <p className="font-medium">
              {t('blocked', { count: blocking.length })}
            </p>
            <ul className="mt-1 list-disc ps-5 text-xs">
              {blocking.slice(0, 5).map((problem) => (
                <li
                  key={`${problem.code}:${problem.slide}:${problem.placeholder}`}
                >
                  {problem.slide !== null
                    ? t(`problem.${problem.code}`, { slide: problem.slide })
                    : t(`problem.${problem.code}`, { slide: 0 })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="mb-2 text-sm text-red-700 dark:text-red-400"
          >
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBuild}
            disabled={
              building || blocking.length > 0 || plan.slides.length === 0
            }
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-40"
          >
            {building && (
              <IconLoader size={14} className="animate-spin" aria-hidden />
            )}
            {t('build', { count: checked.plan.slides.length })}
          </button>
          {checked.shrunk.length > 0 && blocking.length === 0 && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {t('willShrink', {
                count: new Set(checked.shrunk.map((s) => s.slide)).size,
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
