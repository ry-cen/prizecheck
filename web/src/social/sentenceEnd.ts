/** A name ending a sentence: no second period after a name that already ends in one ("Misty W."). */
export const endSentence = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;
