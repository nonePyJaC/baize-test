export interface MarkdownEdit {
  from: number;
  to: number;
  replacement: string;
  selectionStart: number;
  selectionEnd: number;
}

interface ListItem {
  contentCol: number;
  parent: number;
  seq: number;
  number: number;
}

interface ListSequence {
  parent: number;
  start: number;
  members: number[];
}

interface ParsedLines {
  fence: boolean[];
  items: (ListItem | undefined)[];
  seqs: ListSequence[];
}

const PLAIN_INDENT = 2;
const SEARCH_LIMIT = 500;
const LIST_ITEM = /^([ \t]*)([-*+]|(\d{1,9})[.)])(?=[ \t]|$)[ \t]*/;
const NUMBER = /^([ \t]*)\d{1,9}(?=[.)])/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

const leadingWhitespace = (line: string) => line.match(/^[ \t]*/)?.[0] ?? "";
const columnsOf = (whitespace: string) => whitespace.replace(/\t/g, "    ").length;
const contentColumn = (match: RegExpExecArray) => columnsOf(match[1]) + match[0].length - match[1].length;
const withNumber = (line: string, value: number) => line.replace(NUMBER, (_match: string, whitespace: string) => `${whitespace}${value}`);

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function lineAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

function fenceFlags(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let opener: string | null = null;
  for (const line of lines) {
    if (opener === null) {
      const open = FENCE_OPEN.exec(line);
      opener = open ? open[1] : null;
      flags.push(open !== null);
      continue;
    }
    flags.push(true);
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1][0] === opener[0] && close[1].length >= opener.length) opener = null;
  }
  return flags;
}

function parseLists(lines: string[]): ParsedLines {
  const fence = fenceFlags(lines);
  const items: (ListItem | undefined)[] = [];
  const seqs: ListSequence[] = [];
  const stack: { index: number; contentCol: number }[] = [];
  let open = new Map<number, number>();
  const reset = () => {
    stack.length = 0;
    open = new Map();
  };
  lines.forEach((line, index) => {
    if (fence[index]) {
      if (columnsOf(leadingWhitespace(line)) === 0) reset();
      return;
    }
    if (!line.trim()) return;
    const match = LIST_ITEM.exec(line);
    if (!match) {
      if (columnsOf(leadingWhitespace(line)) === 0) reset();
      return;
    }
    const indent = columnsOf(match[1]);
    while (stack.length && stack[stack.length - 1].contentCol > indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].index : -1;
    const contentCol = contentColumn(match);
    let seq = -1;
    if (match[3] !== undefined) {
      let id = open.get(parent);
      if (id === undefined) {
        id = seqs.push({ parent, start: Number(match[3]), members: [] }) - 1;
        open.set(parent, id);
      }
      seq = id;
      seqs[id].members.push(index);
    } else {
      open.delete(parent);
    }
    items[index] = { contentCol, parent, seq, number: Number(match[3]) };
    stack.push({ index, contentCol });
  });
  return { fence, items, seqs };
}

function subtreeEnd(lines: string[], index: number, contentCol: number): number {
  let end = index;
  for (let next = index + 1; next < lines.length; next += 1) {
    if (!lines[next].trim()) continue;
    if (columnsOf(leadingWhitespace(lines[next])) < contentCol) break;
    end = next;
  }
  return end;
}

function indentTarget(lines: string[], fence: boolean[], from: number, limit: number): number {
  for (let index = from - 1, seen = 0; index >= 0 && seen < SEARCH_LIMIT; index -= 1, seen += 1) {
    const line = lines[index];
    if (fence[index] || !line.trim()) continue;
    const width = columnsOf(leadingWhitespace(line));
    if (width > limit) continue;
    const match = LIST_ITEM.exec(line);
    if (match) return contentColumn(match);
    return width || PLAIN_INDENT;
  }
  return PLAIN_INDENT;
}

function outdentTarget(lines: string[], fence: boolean[], from: number, indent: number): number {
  for (let index = from - 1, seen = 0; index >= 0 && seen < SEARCH_LIMIT; index -= 1, seen += 1) {
    const line = lines[index];
    if (fence[index] || !line.trim()) continue;
    const width = columnsOf(leadingWhitespace(line));
    if (width < indent) return width;
  }
  return 0;
}

function listBlock(lines: string[], changed: number[]): [number, number] {
  const listish = (line: string) => !line.trim() || columnsOf(leadingWhitespace(line)) > 0 || LIST_ITEM.test(line);
  let low = Math.min(...changed);
  let high = Math.max(...changed);
  while (low > 0 && listish(lines[low - 1])) low -= 1;
  while (high < lines.length - 1 && listish(lines[high + 1])) high += 1;
  return [low, high];
}

function renumberLists(before: string[], after: string[], changed: number[], newToOld: (index: number) => number): string[] {
  const old = parseLists(before);
  const parsed = parseLists(after);
  const [low, high] = listBlock(after, changed);
  const sameParent = (item: ListItem, sequence: ListSequence) => (sequence.parent < 0 ? item.parent < 0 : item.parent >= 0 && newToOld(sequence.parent) === item.parent);
  const kept = new Set<number>();
  for (const sequence of parsed.seqs) {
    for (const index of sequence.members) {
      const previous = newToOld(index);
      const item = previous >= 0 ? old.items[previous] : undefined;
      if (item && sameParent(item, sequence)) kept.add(previous);
    }
  }
  const result = after.slice();
  for (const sequence of parsed.seqs) {
    const head = sequence.members[0];
    if (head < low || head > high) continue;
    const previous = newToOld(head);
    const item = previous >= 0 ? old.items[previous] : undefined;
    let start = parsed.items[head]?.number ?? 1;
    if (previous >= 0) {
      start = 1;
      if (item && item.seq >= 0 && sameParent(item, sequence)) {
        const origin = old.seqs[item.seq];
        start = previous === origin.members[0] || !kept.has(origin.members[0]) ? origin.start : item.number;
      }
    }
    sequence.members.forEach((index, offset) => {
      result[index] = withNumber(after[index], start + offset);
    });
  }
  return result;
}

function buildEdit(text: string, lines: string[], start: [number, number], end: [number, number]): MarkdownEdit | null {
  const next = lines.join("\n");
  if (next === text) return null;
  const starts = lineStarts(lines);
  const limit = Math.min(text.length, next.length);
  let prefix = 0;
  while (prefix < limit && text[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && text[text.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  return {
    from: prefix,
    to: text.length - suffix,
    replacement: next.slice(prefix, next.length - suffix),
    selectionStart: starts[start[0]] + start[1],
    selectionEnd: starts[end[0]] + end[1],
  };
}

export function indentMarkdownText(text: string, selectionStart: number, selectionEnd: number, outdent: boolean): MarkdownEdit | null {
  const lines = text.split("\n");
  const starts = lineStarts(lines);
  const collapsed = selectionStart === selectionEnd;
  const first = lineAt(starts, selectionStart);
  const selectedLast = Math.max(first, lineAt(starts, !collapsed && text[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd));
  const parsed = parseLists(lines);
  const literal = parsed.fence[first];
  let last = selectedLast;
  if (!literal) {
    for (let index = first; index <= selectedLast; index += 1) {
      const item = parsed.items[index];
      if (item) last = Math.max(last, subtreeEnd(lines, index, item.contentCol));
    }
  }
  const edited = lines.slice();
  const skipBlank = (index: number) => first !== last && !lines[index].trim();
  let result = edited;
  if (literal) {
    for (let index = first; index <= last; index += 1) {
      if (!skipBlank(index)) edited[index] = outdent ? lines[index].slice(Math.min(2, leadingWhitespace(lines[index]).length)) : `  ${lines[index]}`;
    }
  } else {
    const indent = columnsOf(leadingWhitespace(lines[first]));
    const target = outdent
      ? outdentTarget(lines, parsed.fence, first, indent)
      : indentTarget(lines, parsed.fence, first, parsed.items[first] ? indent : Infinity);
    const shift = outdent ? target - indent : Math.max(0, target - indent);
    if (shift === 0) return null;
    for (let index = first; index <= last; index += 1) {
      if (skipBlank(index)) continue;
      const whitespace = leadingWhitespace(lines[index]);
      edited[index] = " ".repeat(Math.max(0, columnsOf(whitespace) + shift)) + lines[index].slice(whitespace.length);
    }
    result = renumberLists(lines, edited, Array.from({ length: last - first + 1 }, (_, offset) => first + offset), (index) => index);
  }
  if (collapsed) {
    const newLine = result[first];
    const indentLength = leadingWhitespace(newLine).length;
    const oldColumn = selectionStart - starts[first];
    const column = oldColumn <= leadingWhitespace(lines[first]).length
      ? indentLength
      : Math.max(indentLength, newLine.length - (lines[first].length - oldColumn));
    return buildEdit(text, result, [first, column], [first, column]);
  }
  return buildEdit(text, result, [first, 0], [last, result[last].length]);
}

export function continueMarkdownList(text: string, selectionStart: number, selectionEnd: number): MarkdownEdit | null {
  if (selectionStart !== selectionEnd) return null;
  const lines = text.split("\n");
  const starts = lineStarts(lines);
  const index = lineAt(starts, selectionStart);
  const fence = fenceFlags(lines);
  if (fence[index]) return null;
  const line = lines[index];
  const column = selectionStart - starts[index];
  const whitespace = leadingWhitespace(line);
  const match = LIST_ITEM.exec(line);
  const next = lines.slice();
  if (!match) {
    if (!whitespace || !line.trim() || column < whitespace.length) return null;
    next[index] = line.slice(0, column);
    next.splice(index + 1, 0, whitespace + line.slice(column).replace(/^[ \t]+/, ""));
    return buildEdit(text, next, [index + 1, whitespace.length], [index + 1, whitespace.length]);
  }
  const contentStart = match[0].length;
  if (column < contentStart) return null;
  if (!line.slice(contentStart).trim()) {
    next[index] = whitespace
      ? " ".repeat(outdentTarget(lines, fence, index, columnsOf(whitespace))) + line.slice(whitespace.length)
      : "";
    const result = renumberLists(lines, next, [index], (position) => position);
    return buildEdit(text, result, [index, result[index].length], [index, result[index].length]);
  }
  const last = subtreeEnd(lines, index, contentColumn(match));
  const insertAt = last + 1;
  const spacing = match[0].slice(whitespace.length + match[2].length) || " ";
  const marker = match[3] === undefined ? match[2] : `${Number(match[3]) + 1}${match[2].slice(-1)}`;
  next[index] = line.slice(0, column);
  next.splice(insertAt, 0, `${whitespace}${marker}${spacing}${line.slice(column).replace(/^[ \t]+/, "")}`);
  const result = renumberLists(lines, next, [index, insertAt], (position) => (position < insertAt ? position : position === insertAt ? -1 : position - 1));
  const caret = LIST_ITEM.exec(result[insertAt])?.[0].length ?? result[insertAt].length;
  return buildEdit(text, result, [insertAt, caret], [insertAt, caret]);
}

export function renumberAfterChange(previous: string, current: string, caret: number): MarkdownEdit | null {
  const before = previous.split("\n");
  const lines = current.split("\n");
  if (before.length === lines.length) return null;
  const shared = Math.min(before.length, lines.length);
  let prefix = 0;
  while (prefix < shared && before[prefix] === lines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shared - prefix && before[before.length - 1 - suffix] === lines[lines.length - 1 - suffix]) suffix += 1;
  const shift = before.length - lines.length;
  const starts = lineStarts(lines);
  const line = lineAt(starts, caret);
  const changed = [line, ...Array.from({ length: lines.length - prefix - suffix }, (_, offset) => prefix + offset)];
  const result = renumberLists(before, lines, changed, (index) => (index < prefix ? index : index >= lines.length - suffix ? index + shift : -1));
  if (result.every((value, index) => value === lines[index])) return null;
  const column = Math.max(0, result[line].length - (lines[line].length - (caret - starts[line])));
  return buildEdit(current, result, [line, column], [line, column]);
}
