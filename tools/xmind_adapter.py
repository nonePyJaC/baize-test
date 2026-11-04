#!/usr/bin/env python3
"""
黑盒测试箱 XMind 适配器
复用现有 XMind 生成/解析逻辑，提供统一命令行接口供客户端调用。

用法:
  python xmind_adapter.py import --input <用例.xmind> --output <cases.json>
  python xmind_adapter.py export --input <cases.json> --template <模板.xmind> --output <结果.xmind>
  python xmind_adapter.py validate --input <结果.xmind>
"""

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TEST_TYPES = [
    "功能测试",
    "性能测试",
    "兼容性测试",
    "易用性测试",
    "安全性测试",
    "稳定性测试",
    "接口测试",
    "自动化测试",
    "安装部署测试",
    "冒烟测试",
    "回归测试",
    "其他",
]


def generate_id() -> str:
    return uuid.uuid4().hex


def numbered(items: list[str]) -> str:
    return "\n".join(f"{i + 1}、{item}" for i, item in enumerate(items))


def imported_at() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def topic_children(topic: dict) -> list[dict]:
    children = topic.get("children") or {}
    if not isinstance(children, dict):
        return []
    result = []
    for key in ("attached", "detached"):
        values = children.get(key) or []
        if isinstance(values, list):
            result.extend(item for item in values if isinstance(item, dict))
    return result


def topic_id(topic: dict, fallback: str) -> str:
    value = topic.get("id")
    return str(value).strip() if value else fallback


def is_case_title(title: str) -> bool:
    return bool(re.match(r"^\s*tc-p\d+\b", title, re.IGNORECASE))


def split_items(value: str) -> list[str]:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    result = []
    for line in normalized.split("\n"):
        for part in re.split(r"(?=\d+\s*[、.)．:：])", line):
            item = re.sub(r"^\s*(?:\d+\s*[、.)．:：]\s*|[-*•]\s*)", "", part).strip()
            if item:
                result.append(item)
    return result


def section_text(title: str) -> tuple[str, str] | None:
    match = re.match(r"^\s*(pc|tx|返回数据)\s*[:：]?\s*(.*)$", title, re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    return match.group(1).lower(), match.group(2)


def normalized_case_title(title: str) -> str:
    value = re.sub(r"^\s*tc-p\d+\s*[-—－]?[^:：]*[:：]?\s*", "", title, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", value).strip().casefold()


def duplicate_titles(cases: list[dict]) -> list[list[str]]:
    grouped: dict[str, list[str]] = {}
    for case in cases:
        key = normalized_case_title(str(case.get("title", "")))
        if key:
            grouped.setdefault(key, []).append(str(case.get("title", "")))
    return [titles for titles in grouped.values() if len(titles) > 1]


def count_directories(tree: dict) -> int:
    return 1 + sum(count_directories(child) for child in tree.get("children", []))


# ============================================================
# XMind 读取（import）
# ============================================================

def read_xmind(xmind_path: str) -> dict[str, Any]:
    """读取 .xmind 文件并解析为结构化用例 JSON。"""
    path = Path(xmind_path)
    if not path.exists():
        return {"success": False, "error": f"文件不存在: {xmind_path}"}

    try:
        with zipfile.ZipFile(path, "r") as zf:
            content_data = json.loads(zf.read("content.json").decode("utf-8"))
        if not isinstance(content_data, list):
            raise ValueError("content.json 顶层必须是数组")
        sheets = [
            (index, sheet.get("rootTopic"))
            for index, sheet in enumerate(content_data)
            if isinstance(sheet, dict) and isinstance(sheet.get("rootTopic"), dict)
        ]
        if not sheets:
            raise ValueError("content.json 中没有可用的根主题")
    except Exception as e:
        return {"success": False, "error": f"读取XMind失败: {e}"}

    cases: list[dict] = []
    trees = [
        _parse_topic(root, is_root=True, cases=cases, sheet_index=sheet_index)
        for sheet_index, root in sheets
    ]
    if len(trees) == 1:
        tree = trees[0]
    else:
        tree = {
            "id": "xmind-workbook-root",
            "title": path.stem or "XMind测试用例",
            "node_type": "workbook",
            "children": trees,
        }

    source_fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
    result = {
        "version": "1.0",
        "requirement_id": "",
        "platform": "",
        "tree": tree,
        "cases": cases,
        "metadata": {
            "total_count": len(cases),
            "directory_count": count_directories(tree),
            "sheet_count": len(trees),
            "source_file": str(path),
            "source_fingerprint": source_fingerprint,
            "imported_at": imported_at(),
            "created_by": "import",
            "missing": {
                "preconditions": sum(1 for case in cases if not case["preconditions"]),
                "steps": sum(1 for case in cases if not case["steps"]),
                "expected": sum(1 for case in cases if not any(step["expected"] for step in case["steps"])),
            },
            "duplicate_titles": duplicate_titles(cases),
        },
    }
    return {"success": True, "data": result}


def _parse_topic(
    topic: dict,
    is_root: bool = False,
    cases: list[dict] | None = None,
    sheet_index: int = 0,
    topic_path: tuple[int, ...] = (),
) -> dict:
    fallback_id = f"topic-{sheet_index}-{'-'.join(str(item) for item in topic_path) or 'root'}"
    node = {
        "id": topic_id(topic, fallback_id),
        "title": str(topic.get("title", "")),
        "node_type": "platform" if is_root else "module",
        "children": [],
    }
    for index, child in enumerate(topic_children(topic)):
        child_title = str(child.get("title", ""))
        child_path = (*topic_path, index)
        if is_case_title(child_title):
            if cases is not None:
                case = _parse_case_node(child, node["id"], f"case-{sheet_index}-{'-'.join(str(item) for item in child_path)}")
                if case:
                    cases.append(case)
            continue
        node["children"].append(_parse_topic(child, cases=cases, sheet_index=sheet_index, topic_path=child_path))
    return node


def _extract_cases(topic: dict, cases: list, directory_id: str | None = None, level: int = 0):
    current_id = topic_id(topic, directory_id or f"directory-{level}")
    for index, child in enumerate(topic_children(topic)):
        child_title = str(child.get("title", ""))
        if is_case_title(child_title):
            case = _parse_case_node(child, current_id, f"case-{level}-{index}")
            if case:
                cases.append(case)
            continue
        _extract_cases(child, cases, current_id, level + 1)


def _parse_case_node(topic: dict, directory_id: str, fallback_id: str | None = None) -> dict | None:
    title = str(topic.get("title", "")).strip()
    if not is_case_title(title):
        return None

    priority_match = re.match(r"^\s*tc-p(\d+)", title, re.IGNORECASE)
    priority_value = int(priority_match.group(1)) if priority_match else 2
    priority = priority_value if priority_value in (0, 1, 2) else 2
    test_type = "功能测试"
    prefix = title.split(":", 1)[0]
    if "：" in prefix:
        prefix = prefix.split("：", 1)[0]
    for candidate in TEST_TYPES:
        if candidate in prefix:
            test_type = candidate
            break

    preconditions: list[str] = []
    actions: list[str] = []
    expected: list[str] = []
    for child in topic_children(topic):
        parsed_section = section_text(str(child.get("title", "")))
        if not parsed_section:
            continue
        section, text = parsed_section
        if section == "pc":
            preconditions.extend(split_items(text))
        elif section == "tx":
            actions.extend(split_items(text))
            for nested in topic_children(child):
                nested_section = section_text(str(nested.get("title", "")))
                if nested_section and nested_section[0] == "返回数据":
                    expected.extend(split_items(nested_section[1]))
        elif section == "返回数据":
            expected.extend(split_items(text))

    steps = [
        {"order": index + 1, "action": action, "expected": expected if index == len(actions) - 1 else []}
        for index, action in enumerate(actions)
    ]
    return {
        "id": topic_id(topic, fallback_id or generate_id()),
        "title": title,
        "directory_id": directory_id,
        "priority": priority,
        "test_type": test_type,
        "preconditions": preconditions,
        "steps": steps,
        "tags": [],
        "platforms": [],
        "requirement_refs": [],
        "asset_refs": [],
        "requires_evidence": False,
        "automation_status": "none",
        "created_by": "import",
        "version": 1,
        "status": "draft",
    }


# ============================================================
# XMind 生成（export）
# ============================================================

def write_xmind(cases_data: dict, template_path: str | None, output_path: str, mapping: dict | None = None) -> dict:
    """从结构化用例 JSON 生成 .xmind 文件。"""
    tree = cases_data.get("tree", {})
    cases = cases_data.get("cases", [])
    mapping = _normalize_xmind_mapping(mapping or cases_data.get("template_mapping") or {})
    files: dict[str, bytes]

    try:
        if template_path:
            template = Path(template_path)
            if not template.exists():
                return {"success": False, "error": f"XMind模板不存在: {template_path}"}
            with zipfile.ZipFile(template, "r") as source:
                files = {name: source.read(name) for name in source.namelist()}
            if "content.json" not in files:
                return {"success": False, "error": "XMind模板中不存在content.json"}
            content = json.loads(files["content.json"].decode("utf-8"))
            content = _build_template_content(content, tree, cases, mapping)
        else:
            content = _build_xmind_content(tree, cases)
            files = {}

        files["content.json"] = json.dumps(content, ensure_ascii=False, indent=2).encode("utf-8")
        files.setdefault("metadata.json", json.dumps({"creator": {"name": "黑盒测试箱", "version": "1.0"}, "modifier": {"name": "黑盒测试箱", "version": "1.0"}}, ensure_ascii=False).encode("utf-8"))
        files.setdefault("manifest.json", json.dumps({"file_entries": []}, ensure_ascii=False).encode("utf-8"))
        files.setdefault("content.xml", b'<?xml version="1.0" encoding="UTF-8"?>\n<sheet></sheet>')
        files.setdefault("meta.xml", b'<?xml version="1.0" encoding="UTF-8"?>\n<meta></meta>')
        files.setdefault("styles.xml", b'<?xml version="1.0" encoding="UTF-8"?>\n<styles></styles>')

        out = Path(output_path)
        if out.exists():
            return {"success": False, "error": f"目标XMind已存在，禁止覆盖: {output_path}"}
        out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out, "x", zipfile.ZIP_DEFLATED) as zf:
            for name, data in files.items():
                zf.writestr(name, data)
    except Exception as e:
        try:
            if "out" in locals() and out.exists():
                out.unlink()
        except OSError:
            pass
        return {"success": False, "error": f"写入XMind失败: {e}"}

    validation = validate_xmind(str(out), expected_count=len(cases))
    if not validation["success"]:
        try:
            out.unlink()
        except OSError:
            pass
        return {"success": False, "error": "导出后的XMind校验失败", "validation": validation}
    return {
        "success": True,
        "output_path": str(out),
        "case_count": len(cases),
        "validation": validation,
    }


def _normalize_xmind_mapping(mapping: dict) -> dict:
    defaults = {
        "root_topic": "",
        "directory_placeholder": "{{目录}}",
        "case_placeholder": "{{用例}}",
        "pc_topic": "pc",
        "tx_topic": "tx",
        "expected_topic": "返回数据",
        "expected_as_child": True,
    }
    if isinstance(mapping, dict):
        defaults.update(mapping)
    return defaults


def _build_xmind_content(tree: dict, cases: list) -> list:
    cases_by_dir: dict[str, list] = {}
    for c in cases:
        dir_id = c.get("directory_id", "")
        cases_by_dir.setdefault(dir_id, []).append(c)

    root_topic = _build_topic_from_tree(tree, cases_by_dir)
    return [{"id": generate_id(), "rootTopic": root_topic, "title": tree.get("title", "测试用例")}]


def _build_template_content(content: list, tree: dict, cases: list, mapping: dict) -> list:
    if not isinstance(content, list):
        raise ValueError("content.json顶层必须是数组")
    sheets = [sheet for sheet in content if isinstance(sheet, dict) and isinstance(sheet.get("rootTopic"), dict)]
    if not sheets:
        raise ValueError("XMind模板中没有可用的根主题")
    selected = next((sheet for sheet in sheets if _matches_reference(sheet["rootTopic"], mapping.get("root_topic", ""))), sheets[0])
    root = selected["rootTopic"]
    directory_template = _find_topic(root, mapping.get("directory_placeholder", "")) or next((child for child in _attached_children(root) if not is_case_title(str(child.get("title", "")))), None)
    case_template = _find_topic(root, mapping.get("case_placeholder", "")) or _find_first_case_topic(root)
    cases_by_dir: dict[str, list] = {}
    for case in cases:
        cases_by_dir.setdefault(case.get("directory_id", ""), []).append(case)

    generated_directories = [
        _build_template_directory(child, directory_template, case_template, mapping, cases_by_dir)
        for child in tree.get("children", [])
        if isinstance(child, dict)
    ]
    generated_root_cases = [
        _build_template_case(case, case_template, mapping)
        for case in cases_by_dir.get(tree.get("id", ""), [])
    ]
    root["title"] = tree.get("title") or root.get("title", "测试用例")
    attached = _attached_children(root)
    direct_directory_index = next((index for index, child in enumerate(attached) if directory_template is not None and child is directory_template), -1)
    generated = generated_directories + generated_root_cases
    if direct_directory_index >= 0:
        attached[direct_directory_index:direct_directory_index + 1] = generated
    else:
        attached = [
            child for child in attached
            if not _matches_reference(child, mapping.get("directory_placeholder", ""))
            and not _matches_reference(child, mapping.get("case_placeholder", ""))
        ] + generated
    _set_attached_children(root, attached)
    return content


def _build_template_directory(node: dict, directory_template: dict | None, case_template: dict | None, mapping: dict, cases_by_dir: dict[str, list]) -> dict:
    topic = copy.deepcopy(directory_template) if directory_template else {"id": generate_id()}
    topic["id"] = node.get("id") or generate_id()
    topic["title"] = node.get("title", "")
    generated = [
        _build_template_directory(child, directory_template, case_template, mapping, cases_by_dir)
        for child in node.get("children", [])
        if isinstance(child, dict)
    ]
    generated.extend(_build_template_case(case, case_template, mapping) for case in cases_by_dir.get(node.get("id", ""), []))
    preserved = []
    if directory_template:
        preserved = [
            child for child in _attached_children(topic)
            if not _matches_reference(child, mapping.get("case_placeholder", ""))
            and not is_case_title(str(child.get("title", "")))
        ]
    _set_attached_children(topic, preserved + generated)
    return topic


def _build_template_case(case: dict, template: dict | None, mapping: dict) -> dict:
    topic = copy.deepcopy(template) if template else {"id": generate_id(), "children": {"attached": []}}
    case_id = case.get("id") or generate_id()
    topic["id"] = case_id
    topic["title"] = case.get("title", "")
    existing = _attached_children(topic)
    section_templates = {}
    for child in existing:
        section = _section_name(str(child.get("title", "")))
        if section:
            section_templates[section] = child
    pc = copy.deepcopy(section_templates.get("pc", {"id": generate_id()}))
    pc["title"] = f"pc: {numbered(case.get('preconditions', []))}"
    tx = copy.deepcopy(section_templates.get("tx", {"id": generate_id()}))
    steps = case.get("steps", [])
    tx["title"] = f"tx: {numbered([step.get('action', '') for step in steps])}"
    expected = copy.deepcopy(section_templates.get("返回数据", {"id": generate_id()}))
    expected_values = [value for step in steps for value in step.get("expected", [])]
    expected["title"] = f"返回数据: {numbered(expected_values)}"
    _set_attached_children(tx, [expected] if mapping.get("expected_as_child", True) else [])
    extras = [child for child in existing if _section_name(str(child.get("title", ""))) not in {"pc", "tx", "返回数据"}]
    sections = [pc, tx] if mapping.get("expected_as_child", True) else [pc, tx, expected]
    _set_attached_children(topic, extras + sections)
    return topic


def _build_topic_from_tree(node: dict, cases_by_dir: dict) -> dict:
    topic_node = {"id": node.get("id", generate_id()), "title": node.get("title", "")}
    children = []

    for child in node.get("children", []):
        children.append(_build_topic_from_tree(child, cases_by_dir))

    node_id = node.get("id", "")
    for case in cases_by_dir.get(node_id, []):
        children.append(_build_case_topic(case))

    if children:
        topic_node["children"] = {"attached": children}
    return topic_node


def _build_case_topic(case: dict) -> dict:
    case_children = [
        {"id": generate_id(), "title": f"pc: {numbered(case.get('preconditions', []))}"},
    ]
    step_lines = [s["action"] for s in case.get("steps", [])]
    expected_lines = []
    for s in case.get("steps", []):
        expected_lines.extend(s.get("expected", []))

    tx_node = {"id": generate_id(), "title": f"tx: {numbered(step_lines)}"}
    tx_node["children"] = {
        "attached": [{"id": generate_id(), "title": f"返回数据: {numbered(expected_lines)}"}]
    }
    case_children.append(tx_node)

    return {
        "id": case.get("id", generate_id()),
        "title": case.get("title", ""),
        "children": {"attached": case_children},
    }


def _attached_children(topic: dict) -> list[dict]:
    children = topic.get("children")
    if not isinstance(children, dict):
        return []
    values = children.get("attached") or []
    return [item for item in values if isinstance(item, dict)]


def _set_attached_children(topic: dict, children: list[dict]) -> None:
    existing = topic.get("children") if isinstance(topic.get("children"), dict) else {}
    topic["children"] = {**existing, "attached": children}


def _matches_reference(topic: dict, reference: str) -> bool:
    value = str(reference or "").strip()
    if not value:
        return False
    return str(topic.get("id", "")) == value or str(topic.get("title", "")).strip() == value or value in str(topic.get("title", ""))


def _find_topic(topic: dict, reference: str) -> dict | None:
    if _matches_reference(topic, reference):
        return topic
    for child in topic_children(topic):
        found = _find_topic(child, reference)
        if found:
            return found
    return None


def _find_first_case_topic(topic: dict) -> dict | None:
    if is_case_title(str(topic.get("title", ""))):
        return topic
    for child in topic_children(topic):
        found = _find_first_case_topic(child)
        if found:
            return found
    return None


def _section_name(title: str) -> str | None:
    parsed = section_text(title)
    if not parsed:
        return None
    return "返回数据" if parsed[0] == "返回数据" else parsed[0]


def _section_body(title: str) -> str:
    parsed = section_text(title)
    return parsed[1].strip() if parsed else ""


# ============================================================
# XMind 校验（validate）
# ============================================================

def validate_xmind(xmind_path: str, expected_count: int | None = None) -> dict:
    path = Path(xmind_path)
    if not path.exists():
        return {"success": False, "error": f"文件不存在: {xmind_path}"}

    required_files = ["content.json", "metadata.json", "content.xml", "meta.xml", "styles.xml", "manifest.json"]
    errors = []
    warnings = []
    case_topics: list[dict] = []

    try:
        with zipfile.ZipFile(path, "r") as zf:
            names = zf.namelist()
            for rf in required_files:
                if rf not in names:
                    errors.append(f"缺少必需文件: {rf}")
            if "content.json" in names:
                content_data = json.loads(zf.read("content.json").decode("utf-8"))
                if not isinstance(content_data, list):
                    errors.append("content.json顶层必须是数组")
                else:
                    roots = [sheet.get("rootTopic") for sheet in content_data if isinstance(sheet, dict) and isinstance(sheet.get("rootTopic"), dict)]
                    for root in roots:
                        _collect_case_topics(root, case_topics)
                    if not roots:
                        errors.append("XMind中没有可用的根主题")
                    for topic in case_topics:
                        sections = {"pc": None, "tx": None, "返回数据": None}
                        for child in _attached_children(topic):
                            section = _section_name(str(child.get("title", "")))
                            if section in sections:
                                sections[section] = _section_body(str(child.get("title", "")))
                            for nested in _attached_children(child):
                                nested_section = _section_name(str(nested.get("title", "")))
                                if nested_section == "返回数据":
                                    sections["返回数据"] = _section_body(str(nested.get("title", "")))
                        if not sections["pc"]:
                            errors.append(f"用例缺少pc前置条件: {topic.get('title', '')}")
                        if not sections["tx"]:
                            errors.append(f"用例缺少tx测试步骤: {topic.get('title', '')}")
                        if not sections["返回数据"]:
                            errors.append(f"用例缺少返回数据: {topic.get('title', '')}")
                    if expected_count is not None and len(case_topics) != expected_count:
                        errors.append(f"用例数量不一致：期望{expected_count}，实际{len(case_topics)}")
    except Exception as e:
        errors.append(f"校验异常: {e}")

    return {
        "success": len(errors) == 0,
        "case_count": len(case_topics),
        "errors": errors,
        "warnings": warnings,
    }


def _collect_case_topics(topic: dict, result: list[dict]) -> None:
    if is_case_title(str(topic.get("title", ""))):
        result.append(topic)
    for child in topic_children(topic):
        _collect_case_topics(child, result)


def _count_cases(topic: dict, count: list):
    title = topic.get("title", "")
    if is_case_title(title):
        count[0] += 1
    for child in topic_children(topic):
        _count_cases(child, count)


# ============================================================
# 命令行入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="黑盒测试箱 XMind 适配器")
    sub = parser.add_subparsers(dest="command")

    p_import = sub.add_parser("import", help="从XMind导入为结构化用例JSON")
    p_import.add_argument("--input", required=True, help="输入.xmind文件路径")
    p_import.add_argument("--output", required=True, help="输出cases.json路径")

    p_export = sub.add_parser("export", help="从结构化用例JSON导出XMind")
    p_export.add_argument("--input", required=True, help="输入cases.json路径")
    p_export.add_argument("--template", help="模板.xmind路径（可选）")
    p_export.add_argument("--mapping", help="模板映射JSON路径（可选）")
    p_export.add_argument("--output", required=True, help="输出.xmind文件路径")

    p_validate = sub.add_parser("validate", help="校验XMind文件完整性")
    p_validate.add_argument("--input", required=True, help="待校验.xmind文件路径")

    args = parser.parse_args()

    if args.command == "import":
        result = read_xmind(args.input)
        if result["success"]:
            out = Path(args.output)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(result["data"], ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({
                "success": True,
                "output_path": str(out),
                "case_count": result["data"]["metadata"]["total_count"],
            }, ensure_ascii=False))
        else:
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(1)

    elif args.command == "export":
        data = json.loads(Path(args.input).read_text(encoding="utf-8"))
        mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8")) if args.mapping else None
        result = write_xmind(data, args.template, args.output, mapping)
        print(json.dumps(result, ensure_ascii=False))
        if not result["success"]:
            sys.exit(1)

    elif args.command == "validate":
        result = validate_xmind(args.input)
        print(json.dumps(result, ensure_ascii=False))
        if not result["success"]:
            sys.exit(1)

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
