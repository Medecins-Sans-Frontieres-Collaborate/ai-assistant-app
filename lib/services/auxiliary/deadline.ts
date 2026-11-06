/** Whole-dependency deadlines, including credential acquisition before an SDK sends HTTP. */

/** Bound an asynchronous dependency without allowing late rejection to become unhandled. */
export async function withAuxiliaryDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Auxiliary dependency timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
