import type { OutlineTopic } from "./aiOutput";
import { TEST_TYPES } from "./xmindCases";

const SECTION = /^\s*(pc|tx|返回数据)\s*([:：])/;

function sectionOf(node: OutlineTopic): { name: string; colon: string } | null {
  const match = node.title.match(SECTION);
  return match ? { name: match[1], colon: match[2] } : null;
}

function namedChildren(node: OutlineTopic, name: string): OutlineTopic[] {
  return node.children.filter((child) => sectionOf(child)?.name === name);
}

function sectionErrors(node: OutlineTopic, label: string): string[] {
  const section = sectionOf(node);
  if (!section) return [`${label}下不能有「${node.title}」节点，只能包含 pc、tx，返回数据挂在 tx 下`];
  const errors: string[] = [];
  if (section.colon === "：") errors.push(`${label}的「${section.name}」请使用半角冒号（pc: 、tx: 、返回数据: ）`);
  if (!node.title.replace(SECTION, "").trim()) errors.push(`${label}的「${section.name}」内容不能为空`);
  if (section.name !== "tx" && node.children.length) errors.push(`${label}的「${section.name}」下不能再有子节点`);
  return errors;
}

function caseErrors(node: OutlineTopic): string[] {
  const label = `用例「${node.title}」`;
  const errors: string[] = [];
  const head = node.title.match(/^tc-p([012])-(.+?): (.+)$/);
  if (!head) errors.push(`${label}的标题不符合模板：应写成 tc-p{0|1|2}-{测试类型}: {场景标题}（半角冒号后接一个空格）`);
  else if (!TEST_TYPES.includes(head[2])) errors.push(`${label}的测试类型「${head[2]}」不在允许列表中`);
  const pcs = namedChildren(node, "pc");
  const txs = namedChildren(node, "tx");
  const direct = namedChildren(node, "返回数据");
  if (pcs.length !== 1) errors.push(`${label}需要且只能有 1 个 pc（前置条件），当前 ${pcs.length} 个`);
  if (txs.length !== 1) errors.push(`${label}需要且只能有 1 个 tx（操作步骤），当前 ${txs.length} 个`);
  if (direct.length) errors.push(`${label}的返回数据必须挂在 tx 下面，不能与 tx 同级`);
  for (const child of node.children) errors.push(...sectionErrors(child, label));
  for (const tx of txs) {
    for (const child of tx.children) {
      if (sectionOf(child)?.name === "返回数据") errors.push(...sectionErrors(child, label));
      else errors.push(`${label}的 tx 下只能有返回数据，不能有「${child.title}」`);
    }
  }
  const expected = txs.flatMap((tx) => namedChildren(tx, "返回数据"));
  if (expected.length !== 1) errors.push(`${label}需要且只能有 1 个返回数据（期望结果，挂在 tx 下），当前 ${expected.length} 个`);
  return errors;
}

export function validateCaseTemplate(nodes: OutlineTopic[]): string[] {
  const errors: string[] = [];
  const visit = (list: OutlineTopic[]) => {
    for (const node of list) {
      if (/^tc\b/i.test(node.title)) errors.push(...caseErrors(node));
      else if (sectionOf(node)) errors.push(`「${node.title}」只能写在用例下面`);
      else visit(node.children);
    }
  };
  visit(nodes);
  return errors;
}
