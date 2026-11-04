import { useDraftSave } from "../lib/draftGuard";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { parse as parseYaml } from "yaml";
import AppIcon from "../components/AppIcon";
import { useBusinessRefresh } from "../lib/businessEvents";
import { api, isTauri, joinPath } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import {
  REPORT_DIRECTORY,
  REPORT_PLACEHOLDERS,
  buildReportData,
  createReportId,
  defaultReportOutputRule,
  defaultReportPlaceholders,
  emptyReportTemplateRegistry,
  normalizeReportTemplateRegistry,
  renderDocxReport,
  renderMarkdownReport,
  renderReportOutputName,
  reportTemplateRegistryPath,
  reportTemplateStoragePath,
  type ReportBuildData,
  type ReportManifest,
} from "../lib/report";
import {
  TEST_EXECUTION_DIRECTORY,
  normalizeSnapshot,
  normalizeTestResults,
  normalizeTestRun,
  type TestRunRecord,
} from "../lib/testExecution";
import { resolveWorkspacePath, sha256Bytes, workspaceRelativePath } from "../lib/templateExport";
import { recordActivity, toWorkspaceRelative } from "../lib/requirementFlow";
import type {
  PlatformInfo,
  ReportTemplate,
  ReportTemplateRegistry,
  RequirementMeta,
  WorkspaceConfig,
} from "../lib/types";

interface ReportGenerationViewProps {
  workspace: WorkspaceConfig;
  initialPlatformId?: string;
  initialRequirementId?: string;
  initialRunId?: string;
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}

type ReportTemplateSource = { name: string; path: string; bytes: Uint8Array };
type ReportTemplateForm = {
  name: string;
  type: "markdown" | "docx";
  version: string;
  platformId: string;
  outputNameRule: string;
  placeholders: string;
  fixedSections: string;
};

export default function ReportGenerationView({ workspace, initialPlatformId, initialRequirementId, initialRunId, readOnly = false, onRightContext, onDirtyChange }: ReportGenerationViewProps) {
  const rootPath = workspace.workspace.root_path;
  const registryPath = reportTemplateRegistryPath(rootPath);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const platforms = workspace.platforms;
  const configuredPlatformId = workspace.defaults?.platform_id && platforms.some((item) => item.id === workspace.defaults?.platform_id) ? workspace.defaults.platform_id : "";
  const firstPlatformId = initialPlatformId && platforms.some((item) => item.id === initialPlatformId) ? initialPlatformId : configuredPlatformId || platforms[0]?.id || "";
  const [platformId, setPlatformId] = useState(firstPlatformId);
  const [requirementId, setRequirementId] = useState(initialRequirementId || "");
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [dataRevision, setDataRevision] = useState(0);
  const [runs, setRuns] = useState<TestRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState(initialRunId || "");
  const [registry, setRegistry] = useState<ReportTemplateRegistry>(emptyReportTemplateRegistry());
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateBytes, setTemplateBytes] = useState<Uint8Array | null>(null);
  const [templateContent, setTemplateContent] = useState("");
  const [templateChanged, setTemplateChanged] = useState(false);
  const [requirementYaml, setRequirementYaml] = useState<unknown>(null);
  const [risks, setRisks] = useState("");
  const [remainingIssues, setRemainingIssues] = useState("");
  const [savedInputs, setSavedInputs] = useState({ risks: "", remainingIssues: "" });
  const reportDirty = risks !== savedInputs.risks || remainingIssues !== savedInputs.remainingIssues;
  const reportDirtyRef = useRef(reportDirty); reportDirtyRef.current = reportDirty;
  useEffect(() => { onDirtyChange?.(reportDirty); }, [reportDirty, onDirtyChange]);
  useBusinessRefresh([joinPath(rootPath, platformId ? platforms.find((p) => p.id === platformId)?.path || "" : "", requirementId)], false,
    () => setDataRevision((v) => v + 1), () => undefined);
  const [source, setSource] = useState<ReportTemplateSource | null>(null);
  const [registration, setRegistration] = useState<ReportTemplateForm>(newReportTemplateForm("markdown"));
  const [showRegister, setShowRegister] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState("");

  const platform = platforms.find((item) => item.id === platformId);
  const requirement = requirements.find((item) => item.requirement.id === requirementId);
  const inputDraftPath = platform ? joinPath(rootPath, platform.path, requirementId, REPORT_DIRECTORY, "report-input-draft.json") : "";
  useEffect(() => {
    if (!inputDraftPath || !requirementId) return;
    setRisks(""); setRemainingIssues(""); setSavedInputs({ risks: "", remainingIssues: "" });
    let active = true;
    void api.readJsonFile(inputDraftPath).then((value) => {
      if (!active || reportDirtyRef.current) return;
      const loaded = { risks: String(value.risks || ""), remainingIssues: String(value.remaining_issues || "") };
      setRisks(loaded.risks); setRemainingIssues(loaded.remainingIssues); setSavedInputs(loaded);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [inputDraftPath, requirementId]);
  useDraftSave(async () => {
    if (!inputDraftPath || readOnly) return false;
    try { await api.saveJsonFile(inputDraftPath, { risks, remaining_issues: remainingIssues, run_id: selectedRunId }); setSavedInputs({ risks, remainingIssues }); return true; }
    catch (error) { setError(String(error)); return false; }
  });
  const selectedRun = runs.find((item) => item.id === selectedRunId) || null;
  const selectedTemplate = registry.templates.find((item) => item.id === selectedTemplateId) || null;
  const targetLocked = readOnly || requirement?.client_access.mode === "locked_for_ai";
  const reportData = useMemo<ReportBuildData | null>(() => {
    if (!selectedRun || requirementYaml === null) return null;
    return buildReportData({
      requirement_yaml: requirementYaml,
      platform_name: platform?.name || selectedRun.run.platform_id,
      run: selectedRun.run,
      snapshot: selectedRun.snapshot,
      results: selectedRun.results,
      risks,
      remaining_issues: remainingIssues,
    });
  }, [platform?.name, remainingIssues, requirementYaml, risks, selectedRun]);
  const markdownPreview = useMemo(() => {
    if (!reportData) return "";
    return renderMarkdownReport(templateContent, reportData);
  }, [reportData, templateContent]);

  // BB-16D：上报报告章节大纲与模板/轮次属性
  useEffect(() => {
    if (!onRightContext) return;
    const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    onRightContext({
      objectType: "report",
      objectId: selectedRun?.id || requirementId || undefined,
      title: "测试报告",
      subtitle: `${platform?.name || platformId} · ${requirementId || "未选择需求"}`,
      platformId: platform?.id || platformId || undefined,
      requirementId: requirementId || undefined,
      readOnly: targetLocked,
      outlineTitle: "报告章节",
      outline: [
        { id: "source", label: "报告来源", icon: "test", onSelect: scrollTo("report-source-section") },
        { id: "template", label: "模板信息", icon: "settings", onSelect: scrollTo("report-template-section") },
        { id: "input", label: "风险与遗留问题", icon: "edit", onSelect: scrollTo("report-input-section") },
        { id: "preview", label: "生成预览", icon: "eye", onSelect: scrollTo("report-preview-section") },
        ...(selectedTemplate?.fixed_sections || []).map((section, index) => ({ id: `section-${index}`, label: section, depth: 1, icon: "file", onSelect: scrollTo("report-preview-section") })),
      ],
      properties: [
        { label: "模板", value: selectedTemplate ? `${selectedTemplate.name}（${selectedTemplate.type.toUpperCase()} V${selectedTemplate.version}）` : "未选择" },
        { label: "输出命名", value: selectedTemplate?.output_name_rule || "—", mono: true },
        { label: "测试轮次", value: selectedRun ? selectedRun.run.name || selectedRun.id : "未选择" },
        { label: "测试环境", value: selectedRun?.run.environment || "—" },
        { label: "锁定状态", value: targetLocked ? "需求锁定，报告输出禁用" : "可生成" },
      ],
      stats: reportData ? [
        { label: "用例总数", value: String(reportData.stats.total) },
        { label: "通过率", value: reportData.placeholders.pass_rate },
      ] : undefined,
    });
    return () => onRightContext(null);
  }, [onRightContext, selectedTemplate, selectedRun, reportData, platform, platformId, requirementId, targetLocked]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.readJsonFile(registryPath)
      .then((value) => { if (!cancelled) setRegistry(normalizeReportTemplateRegistry(value)); })
      .catch(() => { if (!cancelled) setRegistry(emptyReportTemplateRegistry()); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [registryPath]);

  useEffect(() => {
    if (!registry.templates.length) {
      setSelectedTemplateId("");
      return;
    }
    setSelectedTemplateId((current) => registry.templates.some((item) => item.id === current)
      ? current
      : registry.templates.find((item) => item.id === workspace.defaults?.report_template_id)?.id
        || registry.templates.find((item) => item.is_default)?.id
        || registry.templates[0].id);
  }, [registry.templates, workspace.defaults?.report_template_id]);

  useEffect(() => {
    if (!platform) {
      setRequirements([]);
      setRequirementId("");
      return;
    }
    let cancelled = false;
    api.scanRequirements(rootPath, platform.path)
      .then((items) => {
        if (cancelled) return;
        setRequirements(items);
        setRequirementId((current) => items.some((item) => item.requirement.id === current)
          ? current
          : items.some((item) => item.requirement.id === initialRequirementId) ? initialRequirementId || "" : items[0]?.requirement.id || "");
      })
      .catch((reason) => { if (!cancelled) { setRequirements([]); setRequirementId(""); setError(`读取需求失败：${String(reason)}`); } });
    return () => { cancelled = true; };
  }, [initialRequirementId, platform, rootPath]);

  useEffect(() => {
    if (!platform || !requirementId) {
      setRuns([]);
      setSelectedRunId("");
      return;
    }
    let cancelled = false;
    const runsPath = joinPath(rootPath, platform.path, requirementId, TEST_EXECUTION_DIRECTORY);
    setLoadingRuns(true);
    api.listDirectory(runsPath)
      .then(async (entries) => {
        const loaded = await Promise.all(entries.filter((entry) => entry.is_dir).map(async (entry) => {
          try {
            const [runValue, snapshotValue, resultsValue] = await api.readJsonFiles([
              joinPath(entry.path, "run.json"), joinPath(entry.path, "cases-snapshot.json"), joinPath(entry.path, "results.json"),
            ]);
            const run = normalizeTestRun(runValue, entry.name, requirementId, platform.id);
            return {
              id: entry.name,
              path: entry.path,
              run,
              snapshot: normalizeSnapshot(snapshotValue, requirementId, platform.name, platform.id),
              results: normalizeTestResults(resultsValue, run.run_id),
            } satisfies TestRunRecord;
          } catch {
            return null;
          }
        }));
        if (cancelled) return;
        const next = loaded.filter((item): item is TestRunRecord => Boolean(item)).sort((left, right) => right.run.created_at.localeCompare(left.run.created_at));
        setRuns(next);
        setSelectedRunId((current) => next.some((item) => item.id === current)
          ? current
          : next.some((item) => item.id === initialRunId) ? initialRunId || "" : next[0]?.id || "");
      })
      .catch(() => { if (!cancelled) { setRuns([]); setSelectedRunId(""); } })
      .finally(() => { if (!cancelled) setLoadingRuns(false); });
    return () => { cancelled = true; };
  }, [initialRunId, platform, requirementId, rootPath, dataRevision]);

  useEffect(() => {
    if (!platform || !requirementId || !selectedRun) {
      setRequirementYaml(null);
      return;
    }
    let cancelled = false;
    const requirementPath = joinPath(rootPath, platform.path, requirementId, "requirement.yaml");
    api.readTextFile(requirementPath)
      .then((content) => {
        if (cancelled) return;
        try {
          setRequirementYaml(parseYaml(content));
          setError(null);
        } catch (reason) {
          setRequirementYaml(null);
          setError(`解析requirement.yaml失败：${String(reason)}`);
        }
      })
      .catch((reason) => { if (!cancelled) { setRequirementYaml(null); setError(`读取requirement.yaml失败：${String(reason)}`); } });
    return () => { cancelled = true; };
  }, [platform, requirementId, rootPath, selectedRun]);

  useEffect(() => {
    if (!selectedTemplate) {
      setTemplateBytes(null);
      setTemplateContent("");
      setTemplateChanged(false);
      return;
    }
    let cancelled = false;
    setLoadingTemplate(true);
    setError(null);
    api.readBinaryFile(resolveWorkspacePath(rootPath, selectedTemplate.file_path))
      .then(async (bytes) => {
        if (cancelled) return;
        setTemplateBytes(bytes);
        setTemplateContent(selectedTemplate.type === "markdown" ? new TextDecoder().decode(bytes) : "");
        const fingerprint = await sha256Bytes(bytes);
        if (!cancelled) setTemplateChanged(Boolean(selectedTemplate.fingerprint && selectedTemplate.fingerprint !== fingerprint));
      })
      .catch((reason) => { if (!cancelled) { setTemplateBytes(null); setTemplateContent(""); setError(`读取报告模板失败：${String(reason)}`); } })
      .finally(() => { if (!cancelled) setLoadingTemplate(false); });
    return () => { cancelled = true; };
  }, [rootPath, selectedTemplate]);

  const saveRegistry = async (next: ReportTemplateRegistry, successMessage?: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.saveJsonFile(registryPath, next);
      setRegistry(next);
      if (successMessage) setMessage(successMessage);
    } catch (reason) {
      setError(`保存报告模板登记失败：${String(reason)}`);
      throw reason;
    } finally {
      setSaving(false);
    }
  };

  const chooseSource = async () => {
    setError(null);
    try {
      if (isTauri) {
        const path = await api.chooseReportTemplateFile();
        if (!path) return;
        const bytes = await api.readBinaryFile(path);
        const type = reportTemplateType(path);
        if (!type) throw new Error("只支持Markdown或DOCX报告模板");
        setRegistration((current) => ({ ...current, type, outputNameRule: defaultReportOutputRule(type) }));
        setSource({ name: path.split(/[\\/]/).pop() || path, path, bytes });
        return;
      }
      sourceInputRef.current?.click();
    } catch (reason) {
      setError(`读取报告模板失败：${String(reason)}`);
    }
  };

  const handleSourceFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const type = reportTemplateType(file.name);
    if (!type) {
      setError("只支持Markdown或DOCX报告模板");
      return;
    }
    void file.arrayBuffer()
      .then((buffer) => {
        setRegistration((current) => ({ ...current, type, outputNameRule: defaultReportOutputRule(type) }));
        setSource({ name: file.name, path: file.name, bytes: new Uint8Array(buffer) });
      })
      .catch((reason) => setError(`读取报告模板失败：${String(reason)}`));
  };

  const registerTemplate = async () => {
    if (!source || !registration.name.trim()) {
      setError("请选择报告模板文件并填写模板名称");
      return;
    }
    setError(null);
    try {
      const id = `report-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fingerprint = await sha256Bytes(source.bytes);
      const destination = reportTemplateStoragePath(rootPath, workspace.directories.templates || "templates", registration.type, registration.name, id);
      await api.createBinaryFile(destination, source.bytes);
      const now = new Date().toISOString();
      const platformValue = registration.platformId.trim() || null;
      const template: ReportTemplate = {
        id,
        name: registration.name.trim(),
        type: registration.type,
        version: registration.version.trim() || "1.0",
        file_path: workspaceRelativePath(rootPath, destination),
        platform_id: platformValue,
        fingerprint,
        placeholders: parseLines(registration.placeholders, defaultReportPlaceholders()),
        fixed_sections: parseLines(registration.fixedSections, []),
        output_name_rule: registration.outputNameRule.trim() || defaultReportOutputRule(registration.type),
        is_default: !registry.templates.some((item) => item.type === registration.type && item.platform_id === platformValue),
        created_at: now,
        updated_at: now,
      };
      const nextTemplates = [...registry.templates.map((item) => template.is_default && item.type === template.type && item.platform_id === template.platform_id ? { ...item, is_default: false } : item), template];
      await saveRegistry({ ...registry, templates: nextTemplates }, `已登记报告模板“${template.name}”`);
      setSelectedTemplateId(template.id);
      setSource(null);
      setShowRegister(false);
    } catch (reason) {
      setError(`登记报告模板失败：${String(reason)}`);
    }
  };

  const generateReport = async () => {
    if (!selectedTemplate || !templateBytes || !selectedRun || !reportData || !platform || !requirementId) {
      setError("请选择报告模板、测试轮次并确保轮次数据完整");
      return;
    }
    if (targetLocked) {
      setError("目标需求已锁定，报告输出被禁止");
      return;
    }
    if (templateChanged) {
      setError("报告模板文件指纹已变化，请重新登记新模板版本后再生成");
      return;
    }
    setGenerating(true);
    setError(null);
    setMessage(null);
    try {
      const [[runValue, snapshotValue, resultsValue], requirementText] = await Promise.all([
        api.readJsonFiles([joinPath(selectedRun.path, "run.json"), joinPath(selectedRun.path, "cases-snapshot.json"), joinPath(selectedRun.path, "results.json")]),
        api.readTextFile(joinPath(rootPath, platform.path, requirementId, "requirement.yaml")),
      ]);
      const reportData = buildReportData({ requirement_yaml: parseYaml(requirementText), platform_name: platform.name,
        run: normalizeTestRun(runValue, selectedRun.id, requirementId, platform.id),
        snapshot: normalizeSnapshot(snapshotValue, requirementId, platform.name, platform.id),
        results: normalizeTestResults(resultsValue, selectedRun.id), risks, remaining_issues: remainingIssues });
      const reportId = createReportId();
      const reportDir = joinPath(rootPath, platform.path, requirementId, REPORT_DIRECTORY, reportId);
      const outputName = renderReportOutputName(selectedTemplate.output_name_rule, {
        requirement_id: reportData.placeholders.requirement_id,
        requirement_name: reportData.placeholders.requirement_name,
        platform: reportData.placeholders.platform,
        platform_id: platform.id,
        version: selectedTemplate.version,
        report_id: reportId,
      }, selectedTemplate.type);
      const outputPath = joinPath(reportDir, outputName);
      await api.createDirectory(reportDir);
      if (selectedTemplate.type === "markdown") {
        await api.writeTextFile(outputPath, renderMarkdownReport(templateContent, reportData));
      } else {
        const outputBytes = await renderDocxReport(templateBytes, reportData);
        await api.createBinaryFile(outputPath, outputBytes);
      }
      const requirementRoot = joinPath(rootPath, platform.path, requirementId);
      const manifest: ReportManifest = {
        version: "1.0",
        report_id: reportId,
        requirement_id: requirementId,
        platform_id: platform.id,
        run_id: selectedRun.run.run_id,
        template_id: selectedTemplate.id,
        template_version: selectedTemplate.version,
        template_fingerprint: selectedTemplate.fingerprint,
        output_type: selectedTemplate.type,
        output_path: workspaceRelativePath(requirementRoot, outputPath),
        created_at: new Date().toISOString(),
        stats: reportData.stats,
        risks,
        remaining_issues: remainingIssues,
        source_revisions: {
          working_revision: runValue.working_revision ?? null,
          case_version_id: runValue.case_version_id,
          baseline_fingerprint: runValue.baseline_fingerprint ?? null,
          results_sha256: await sha256Bytes(new TextEncoder().encode(JSON.stringify(resultsValue))),
          snapshot_sha256: await sha256Bytes(new TextEncoder().encode(JSON.stringify(snapshotValue))),
          results_updated_at: resultsValue.updated_at || null,
        },
        sources: {
          requirement: "requirement.yaml",
          run: joinPath(TEST_EXECUTION_DIRECTORY, selectedRun.id, "run.json"),
          snapshot: joinPath(TEST_EXECUTION_DIRECTORY, selectedRun.id, "cases-snapshot.json"),
          results: joinPath(TEST_EXECUTION_DIRECTORY, selectedRun.id, "results.json"),
          evidence: joinPath(TEST_EXECUTION_DIRECTORY, selectedRun.id, "evidence"),
        },
      };
      await api.createJsonFile(joinPath(reportDir, "report.json"), manifest);
      setLastOutput(outputPath);
      setSavedInputs({ risks, remainingIssues });
      setMessage(`报告生成完成：${outputName}`);
      recordActivity(rootPath, platform.path, requirementId, {
        action: "report_generated",
        summary: `生成测试报告「${outputName}」（轮次 ${selectedRun.run.name}）`,
        object_id: reportId,
        refs: [toWorkspaceRelative(rootPath, outputPath)],
      });
    } catch (reason) {
      setError(`生成测试报告失败：${String(reason)}`);
    } finally {
      setGenerating(false);
    }
  };

  const onPlatformChange = (nextId: string) => {
    if (reportDirty && !window.confirm("当前报告输入尚未保存，确定放弃并切换平台吗？")) return;
    setPlatformId(nextId);
    setRequirementId("");
    setRuns([]);
    setSelectedRunId("");
    setRequirementYaml(null);
  };

  return <div className="workspace-view report-generation-view">
    <section className="document-header">
      <div className="document-title-row"><span className="document-icon violet"><AppIcon name="file" size={20} /></span><div><div className="eyebrow">BB-12 / 报告模板与生成</div><h1>测试报告</h1><p>使用指定测试轮次快照和用户模板生成统计一致的测试报告</p></div></div>
      <div className="header-actions"><button className="button button-primary" type="button" onClick={() => { setRegistration(newReportTemplateForm("markdown")); setSource(null); setShowRegister(true); }}><AppIcon name="add" size={15} /> 登记报告模板</button><button className="button button-ghost" type="button" onClick={() => { setDataRevision((v) => v + 1); }}><AppIcon name="refresh" size={15} /> 刷新</button></div>
    </section>
    <input ref={sourceInputRef} type="file" accept=".md,.markdown,.docx" onChange={handleSourceFile} hidden />
    <div className="report-generation-layout">
      <aside className="panel-section report-template-list-panel"><div className="section-heading"><div><AppIcon name="file" size={16} /><h2>报告模板</h2></div><span className="section-muted">{registry.templates.length}</span></div>{loading ? <div className="loading-line"><span className="spinner" />读取报告模板登记…</div> : registry.templates.length ? <div className="report-template-list">{registry.templates.map((template) => <button type="button" key={template.id} className={`report-template-list-row ${template.id === selectedTemplateId ? "active" : ""}`} onClick={() => setSelectedTemplateId(template.id)}><span className={`report-template-list-icon ${template.type}`}><AppIcon name={template.type === "docx" ? "file" : "markdown"} size={16} /></span><span className="report-template-list-main"><strong>{template.name}</strong><small>{template.type.toUpperCase()} · V{template.version}{template.platform_id ? ` · ${platformName(platforms, template.platform_id)}` : " · 通用"}</small></span>{template.is_default && <span className="template-default-badge">默认</span>}</button>)}</div> : <div className="inline-empty">尚未登记报告模板，请先登记Markdown或DOCX模板。</div>}</aside>
      <main className="report-generation-main">
        <section className="panel-section report-source-panel" id="report-source-section"><div className="section-heading"><div><AppIcon name="test" size={16} /><h2>报告来源</h2></div><span className="section-muted">本轮工作快照</span></div><div className="report-source-grid"><label className="field-label">平台<select className="field-input" value={platformId} onChange={(event) => onPlatformChange(event.target.value)}><option value="">选择平台</option>{platforms.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）{item.status === "archived" ? " · 已归档" : ""}</option>)}</select></label><label className="field-label">需求<select className="field-input" value={requirementId} onChange={(event) => { if (!reportDirty || window.confirm("报告输入尚未保存，确定放弃并切换需求吗？")) setRequirementId(event.target.value); }} disabled={!platform || !requirements.length}><option value="">{platform ? "选择需求" : "先选择平台"}</option>{requirements.map((item) => <option key={item.requirement.id} value={item.requirement.id}>{item.requirement.id} · {item.requirement.name}</option>)}</select></label><label className="field-label">测试轮次<select className="field-input" value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)} disabled={!runs.length}><option value="">{loadingRuns ? "读取轮次…" : "选择测试轮次"}</option>{runs.map((item) => <option key={item.id} value={item.id}>{item.run.name} · {item.run.environment || "未填写环境"} · {item.run.created_at.slice(0, 10)}</option>)}</select></label></div>{requirement?.client_access.mode === "locked_for_ai" && <div className="unlock-warning"><AppIcon name="lock" size={14} /><span>目标需求正在由AI处理，报告输出被禁用，但仍可查看历史轮次。</span></div>}{selectedRun && reportData && <ReportStats data={reportData} />}</section>
        <section className="panel-section report-template-config-panel" id="report-template-section"><div className="section-heading"><div><AppIcon name="settings" size={16} /><h2>模板信息</h2></div>{selectedTemplate && <span className="status-pill">{selectedTemplate.type.toUpperCase()} · V{selectedTemplate.version}</span>}</div>{selectedTemplate ? <><div className="report-template-meta"><span className="mono">{selectedTemplate.file_path}</span><span className={templateChanged ? "template-fingerprint changed" : "template-fingerprint"}>{templateChanged ? "文件指纹已变化" : `SHA256 ${selectedTemplate.fingerprint.slice(0, 12)}…`}</span></div><div className="report-template-sections"><span>固定章节</span><strong>{selectedTemplate.fixed_sections.join("、") || "由模板正文决定"}</strong><span>支持占位符</span><strong>{selectedTemplate.placeholders.length} 个</strong></div></> : <div className="inline-empty large"><AppIcon name="inbox" size={18} />从左侧选择报告模板，或先登记模板。</div>}</section>
        <section className="panel-section report-input-panel" id="report-input-section"><div className="section-heading"><div><AppIcon name="edit" size={16} /><h2>风险与遗留问题</h2></div><span className="section-muted">可保存报告输入草稿</span></div><div className="report-input-grid"><label className="field-label">风险<textarea className="field-input field-textarea report-input-textarea" value={risks} onChange={(event) => setRisks(event.target.value)} placeholder="填写本轮测试风险、影响和建议" /></label><label className="field-label">遗留问题<textarea className="field-input field-textarea report-input-textarea" value={remainingIssues} onChange={(event) => setRemainingIssues(event.target.value)} placeholder="填写未解决问题、责任人或后续动作" /></label></div></section>
        <section className="panel-section report-preview-panel" id="report-preview-section"><div className="section-heading"><div><AppIcon name="eye" size={16} /><h2>生成预览</h2></div><div className="report-preview-actions"><span className="section-muted">{selectedTemplate?.type === "docx" ? "DOCX模板将保留原样式" : "Markdown正文预览"}</span><button className="button button-primary button-small" type="button" disabled={!selectedTemplate || !selectedRun || !reportData || !templateBytes || targetLocked || templateChanged || generating} onClick={() => void generateReport()}><AppIcon name="save" size={13} />{generating ? "生成中…" : "生成报告"}</button></div></div>{!selectedRun || !reportData ? <div className="inline-empty large"><AppIcon name="inbox" size={18} />选择测试轮次后查看统计、失败/阻塞用例和报告预览。</div> : selectedTemplate?.type === "docx" ? <div className="report-docx-preview"><AppIcon name="file" size={21} /><div><strong>DOCX报告输出</strong><p>生成时会将占位符写入模板的正文、页眉、页脚等XML文件，并保留模板样式和资源。</p><small>固定章节：{selectedTemplate.fixed_sections.join("、") || "按模板原有章节"}</small></div></div> : <pre className="report-markdown-preview">{markdownPreview}</pre>}{lastOutput && <div className="template-output-success"><AppIcon name="check" size={14} /><span>{lastOutput}</span><button className="text-button" type="button" onClick={() => void systemOpen.openFile(lastOutput)}>打开输出</button></div>}</section>
      </main>
    </div>
    {message && <div className="toast toast-success"><AppIcon name="check" size={15} /> {message}<button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}
    {error && <div className="toast toast-error"><AppIcon name="alert" size={15} /> {error}<button type="button" onClick={() => setError(null)}><AppIcon name="close" size={14} /></button></div>}
    {showRegister && <ReportTemplateRegistrationModal workspace={workspace} platforms={platforms} state={registration} source={source} saving={saving} onChange={setRegistration} onChooseSource={() => void chooseSource()} onClose={() => setShowRegister(false)} onSubmit={() => void registerTemplate()} />}
  </div>;
}

function ReportStats({ data }: { data: ReportBuildData }) {
  const { stats } = data;
  return <div className="report-stats"><Metric label="总数" value={stats.total} /><Metric label="通过" value={stats.passed} tone="passed" /><Metric label="失败" value={stats.failed} tone="failed" /><Metric label="阻塞" value={stats.blocked} tone="blocked" /><Metric label="未执行" value={stats.not_executed} tone="not-executed" /><Metric label="登记进度" value={`${stats.progress}%`} /><Metric label="实际执行" value={`${stats.executed}/${stats.applicable}`} /><Metric label="待复测" value={stats.needs_retest} /><Metric label="不适用" value={stats.not_applicable} /><Metric label="删除" value={stats.deleted} /><Metric label="通过率" value={data.placeholders.pass_rate} tone="rate" /></div>;
}

function Metric({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return <div className={`report-stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ReportTemplateRegistrationModal(props: { workspace: WorkspaceConfig; platforms: PlatformInfo[]; state: ReportTemplateForm; source: ReportTemplateSource | null; saving: boolean; onChange: React.Dispatch<React.SetStateAction<ReportTemplateForm>>; onChooseSource: () => void; onClose: () => void; onSubmit: () => void }) {
  const { platforms, state, source, saving, onChange, onChooseSource, onClose, onSubmit } = props;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}><div className="modal report-template-register-modal"><div className="modal-header"><div><span className="eyebrow">BB-12 / 模板登记</span><h2>登记测试报告模板</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving}><AppIcon name="close" size={16} /></button></div><p className="modal-description">模板会复制到工作区的 <span className="mono">templates/report</span>，登记信息保存在 <span className="mono">.blackbox/report-templates.json</span>。原始模板不会被覆盖。</p><div className="xmind-import-source"><div><AppIcon name={state.type === "docx" ? "file" : "markdown"} size={17} /><span>{source ? <><strong>{source.name}</strong><small>{source.path}</small></> : <><strong>尚未选择模板文件</strong><small>支持 .md、.markdown 和 .docx</small></>}</span></div><button className="button button-ghost button-small" type="button" onClick={onChooseSource} disabled={saving}><AppIcon name="upload" size={14} /> 选择文件</button></div><div className="report-register-grid"><label className="field-label">模板名称<input className="field-input" value={state.name} onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))} placeholder="例如：示例平台测试报告模板" /></label><label className="field-label">模板类型<select className="field-input" value={state.type} onChange={(event) => { const type = event.target.value as "markdown" | "docx"; onChange((current) => ({ ...current, type, outputNameRule: defaultReportOutputRule(type) })); }}><option value="markdown">Markdown</option><option value="docx">DOCX</option></select></label><label className="field-label">模板版本<input className="field-input" value={state.version} onChange={(event) => onChange((current) => ({ ...current, version: event.target.value }))} placeholder="例如 1.0" /></label><label className="field-label">适用平台<select className="field-input" value={state.platformId} onChange={(event) => onChange((current) => ({ ...current, platformId: event.target.value }))}><option value="">通用模板</option>{platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）</option>)}</select></label><label className="field-label report-register-wide">输出文件名规则<input className="field-input" value={state.outputNameRule} onChange={(event) => onChange((current) => ({ ...current, outputNameRule: event.target.value }))} placeholder={defaultReportOutputRule(state.type)} /></label><label className="field-label report-register-wide">占位符（每行一个）<textarea className="field-input field-textarea report-register-textarea" value={state.placeholders} onChange={(event) => onChange((current) => ({ ...current, placeholders: event.target.value }))} /></label><label className="field-label report-register-wide">固定章节（每行一个）<textarea className="field-input field-textarea report-register-textarea" value={state.fixedSections} onChange={(event) => onChange((current) => ({ ...current, fixedSections: event.target.value }))} placeholder="测试概况\n失败用例\n风险\n遗留问题" /></label></div><div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button><button className="button button-primary" type="button" onClick={onSubmit} disabled={saving || !source || !state.name.trim()}>{saving ? "保存中…" : "登记模板"}</button></div></div></div>;
}

function newReportTemplateForm(type: "markdown" | "docx"): ReportTemplateForm {
  return {
    name: "",
    type,
    version: "1.0",
    platformId: "",
    outputNameRule: defaultReportOutputRule(type),
    placeholders: REPORT_PLACEHOLDERS.join("\n"),
    fixedSections: "测试概况\n失败用例\n阻塞用例\n风险\n遗留问题",
  };
}

function parseLines(value: string, fallback: string[]): string[] {
  const lines = value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
  return lines.length ? [...new Set(lines)] : [...fallback];
}

function reportTemplateType(path: string): "markdown" | "docx" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return null;
}

function platformName(platforms: PlatformInfo[], id: string): string {
  return platforms.find((item) => item.id === id)?.name || id;
}
