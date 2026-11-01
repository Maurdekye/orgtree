// canvas/languages.ts — the languages a person can read in, and a hub can
// take for senders who set none (Mail hub 2.4.0 translation). BCP 47 tags,
// each named in its own language. Hubchat's language list is the same.

export const LANGUAGES: readonly (readonly [tag: string, name: string])[] = [
  ['ar', 'العربية'], ['bn', 'বাংলা'], ['cs', 'Čeština'], ['da', 'Dansk'], ['de', 'Deutsch'],
  ['el', 'Ελληνικά'], ['en', 'English'], ['es', 'Español'], ['fa', 'فارسی'], ['fi', 'Suomi'],
  ['fr', 'Français'], ['he', 'עברית'], ['hi', 'हिन्दी'], ['hu', 'Magyar'], ['id', 'Bahasa Indonesia'],
  ['it', 'Italiano'], ['ja', '日本語'], ['ko', '한국어'], ['nl', 'Nederlands'], ['no', 'Norsk'],
  ['pl', 'Polski'], ['pt', 'Português'], ['pt-BR', 'Português (Brasil)'], ['ro', 'Română'], ['ru', 'Русский'],
  ['sv', 'Svenska'], ['th', 'ไทย'], ['tr', 'Türkçe'], ['uk', 'Українська'], ['vi', 'Tiếng Việt'],
  ['zh-Hans', '中文（简体）'], ['zh-Hant', '中文（繁體）'],
]

/** A BCP 47-shaped tag, as the hub and the engine take it: a 2-3 letter
 *  language, then subtags of 2-8 letters or digits, at most 35 characters.
 *  A roster can come from someone else's hub; anything else is no language. */
export const isLanguageTag = (tag: unknown): tag is string =>
  typeof tag === 'string' && tag.length <= 35 && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)

/** A tag's own name, or the tag itself when it is not in the list. */
export const languageName = (tag: string): string => LANGUAGES.find(([t]) => t === tag)?.[1] ?? tag
