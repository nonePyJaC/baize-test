import { pinyin } from "pinyin-pro";

const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, "");
/** Build once per option: Chinese, full pinyin, initials, aliases and IDs. */
export function selectSearchIndex(values: string[]): string {
  return values.flatMap(value => [value,
    pinyin(value, { toneType: "none", type: "array", mode: "surname", surname: "head", v: true }).join(""),
    pinyin(value, { pattern: "first", toneType: "none", type: "array", mode: "surname", surname: "head", v: true }).join(""),
  ]).map(normalize).join("\n");
}
export function matchesSelectSearch(index: string, keyword: string): boolean {
  return index.includes(normalize(keyword.trim()));
}
