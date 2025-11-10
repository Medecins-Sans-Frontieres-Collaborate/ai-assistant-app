export const isChangeEvent = (
  eventOrFiles: any,
): eventOrFiles is React.ChangeEvent<HTMLInputElement> => {
  return (
    eventOrFiles &&
    typeof eventOrFiles.preventDefault === 'function' &&
    eventOrFiles.target &&
    eventOrFiles.target.files instanceof FileList
  );
};
