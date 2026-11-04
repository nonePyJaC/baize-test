# 白泽工作区说明

> 本文件由白泽客户端生成，供客户端和外部AI（Codex、Devin、CLI、IDE、Harness）共同阅读。

## 工作区标识

- 工作区名称：（由用户填写）
- 协议版本：1.0
- 创建时间：（自动生成）
- 工作区根目录：（自动识别）

## 目录角色

| 目录 | 角色 | 说明 |
|---|---|---|
| `.blackbox/` | 客户端内部 | 索引、任务、迁移记录和日志，可删除重建 |
| `templates/` | 模板 | 用户提供的XMind、Excel用例模板和报告模板 |
| `projects/` | 需求 | 按客户平台和需求编号组织 |
| `knowledge/` | 知识库 | 通用、平台和需求级知识 |
| `tools/` | 工具 | 解析、校验和导出脚本 |
| `archive/` | 归档 | 已归档需求 |

## AI使用须知

1. 先阅读本文件和 `.blackbox/workspace.yaml` 了解工作区结构。
2. 需求元数据在每个需求的 `requirement.yaml` 中。
3. AI任务在 `.blackbox/tasks/<任务ID>/` 目录中，先阅读 `task.md`。
4. 只修改任务 `write-scope.json` 允许的路径。
5. 完成后更新 `result.json` 或目标文件。
6. 不要修改 `.blackbox/index.sqlite`。
7. 不要删除或覆盖已确认版本文件。
