const controlCharacterPattern = /\p{Cc}/u;
const bidiOverridePattern = /[\u202A-\u202E\u2066-\u2069]/u;

export function isSafeSingleLineText(value: string): boolean {
  return !controlCharacterPattern.test(value) && !bidiOverridePattern.test(value);
}
