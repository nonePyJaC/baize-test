import React, { useEffect, useMemo, useRef, useState } from "react";
import AppIcon from "../components/AppIcon";
import { api, isTauri, joinPath } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { normalizeCasesDocument } from "../lib/cases";
import {
  buildExcelExport,
  buildExportPreview,
  buildXMindExport,
  defaultExcelMapping,
  defaultXMindMapping,
  emptyTemplateRegistry,
  normalizeTemplateRegistry,
  renderOutputFileName,
  resolveWorkspacePath,
  sha256Bytes,
  templateRegistryPath,
  workspaceRelativePath,
  templateStoragePath,
} from "../lib/templateExport";
import type {
  CaseTemplate,
  CaseTemplateMapping,
  CaseTemplateRegistry,
  CasesDocument,
  ExcelTemplateMapping,
  PlatformInfo,
  RequirementMeta,
  WorkspaceConfig,
  XMindTemplateMapping,
} from "../lib/types";

type TemplateSource = { name: string; path: string; bytes: Uint8Array };
type FormState = { name: string; type: "xmind" | "excel"; version: string; platform_id: string; output_name_rule: string; mapping: CaseTemplateMapping };

interface TemplateExportViewProps {
  workspace: WorkspaceConfig;
  initialPlatformId?: string;
  initialRequirementId?: string;
  readOnly?: boolean;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}

export default function TemplateExportView({ workspace, initialPlatformId, initialRequirementId, readOnly = false, onRightContext }: TemplateExportViewProps) {
  const rootPath = workspace.workspace.root_path;
  const templatesDirectory = workspace.directories.templates || "templates";
  const registryPath = templateRegistryPath(rootPath, templatesDirectory);
  const inputRef = useRef<HTMLInputElement>(null);
  const activePlatforms = useMemo(() => workspace.platforms.filter((platform) => platform.status !== "archived"), [workspace.platforms]);
  const configuredPlatformId = workspace.defaults?.platform_id && activePlatforms.some((platform) => platform.id === workspace.defaults?.platform_id) ? workspace.defaults.platform_id : "";
  const firstPlatformId = initialPlatformId && activePlatforms.some((platform) => platform.id === initialPlatformId) ? initialPlatformId : configuredPlatformId || activePlatforms[0]?.id || "";
  const [platformId, setPlatformId] = useState(firstPlatformId);
  const [requirementId, setRequirementId] = useState(initialRequirementId || "");
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [registry, setRegistry] = useState<CaseTemplateRegistry>(emptyTemplateRegistry());
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [document, setDocument] = useState<CasesDocument | null>(null);
  const [templateBytes, setTemplateBytes] = useState<Uint8Array | null>(null);
  const [templateChanged, setTemplateChanged] = useState(false);
  const [mappingDraft, setMappingDraft] = useState<CaseTemplateMapping | null>(null);
  const [outputRuleDraft, setOutputRuleDraft] = useState("");
  const [source, setSource] = useState<TemplateSource | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [registration, setRegistration] = useState<FormState>(newFormState("xmind"));
  const [loading, setLoading] = useState(true);
  const [loadingCases, setLoadingCases] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState("");

  const selectedPlatform = workspace.platforms.find((platform) => platform.id === platformId);
  const selectedRequirement = requirements.find((item) => item.requirement.id === requirementId);
  const selectedTemplate = registry.templates.find((item) => item.id === selectedTemplateId) || null;
  const targetLocked = readOnly || selectedRequirement?.client_access.mode === "locked_for_ai";
  const outputName = selectedTemplate && selectedPlatform && requirementId
    ? renderOutputFileName(outputRuleDraft || selectedTemplate.output_name_rule, {
      requirement_id: requirementId,
      requirement_name: selectedRequirement?.requirement.name,
      platform: selectedPlatform.name,
      platform_id: selectedPlatform.id,
      version: selectedTemplate.version,
    }, selectedTemplate.type)
    : "";
  const outputPath = selectedPlatform && requirementId && outputName
    ? joinPath(rootPath, selectedPlatform.path, requirementId, "04-测试用例", "exports", outputName)
    : "";
  const preview = document && selectedTemplate && outputPath
    ? { ...buildExportPreview(document, { ...selectedTemplate, mapping: mappingDraft || selectedTemplate.mapping }, outputPath), template_changed: templateChanged }
    : null;

  // BB-16D：上报模板大纲与导出配置属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "cases",
      objectId: requirementId || undefined,
      title: "模板与导出",
      subtitle: `${selectedPlatform?.name || platformId} · ${requirementId || "未选择需求"}`,
      platformId: platformId || undefined,
      requirementId: requirementId || undefined,
      readOnly: targetLocked,
      outlineTitle: "已登记模板",
      outline: registry.templates.map((template) => ({
        id: template.id,
        label: template.name,
        badge: `${template.type.toUpperCase()} V${template.version}`,
        icon: template.type === "xmind" ? "archiveFile" : "spreadsheet",
        active: template.id === selectedTemplateId,
        onSelect: () => setSelectedTemplateId(template.id),
      })),
      properties: [
        { label: "选中模板", value: selectedTemplate ? `${selectedTemplate.name}（${selectedTemplate.type.toUpperCase()}）` : "未选择" },
        { label: "输出文件", value: outputName || "—", mono: true },
        { label: "导出目录", value: outputPath ? "04-测试用例/exports" : "—" },
        { label: "用例数据", value: document ? `${document.cases.length} 条用例` : "未加载" },
        { label: "锁定状态", value: targetLocked ? "需求锁定，导出禁用" : "可导出" },
      ],
      stats: [
        { label: "模板数", value: String(registry.templates.length) },
        { label: "预览条目", value: preview ? String(preview.case_count) : "—" },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, registry, selectedTemplate, selectedTemplateId, outputName, outputPath, document, preview, targetLocked, platformId, requirementId, selectedPlatform]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.readJsonFile(registryPath)
      .then((value) => { if (!cancelled) setRegistry(normalizeTemplateRegistry(value)); })
      .catch(() => { if (!cancelled) setRegistry(emptyTemplateRegistry()); })
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
      : registry.templates.find((item) => item.id === workspace.defaults?.case_template_id)?.id
        || registry.templates.find((item) => item.is_default)?.id
        || registry.templates[0].id);
  }, [registry.templates, workspace.defaults?.case_template_id]);

  useEffect(() => {
    if (!selectedTemplate) {
      setMappingDraft(null);
      setOutputRuleDraft("");
      setTemplateBytes(null);
      setTemplateChanged(false);
      return;
    }
    let cancelled = false;
    setMappingDraft(selectedTemplate.mapping);
    setOutputRuleDraft(selectedTemplate.output_name_rule);
    setLoadingTemplate(true);
    setError(null);
    api.readBinaryFile(resolveWorkspacePath(rootPath, selectedTemplate.file_path))
      .then(async (bytes) => {
        if (cancelled) return;
        setTemplateBytes(bytes);
        const fingerprint = await sha256Bytes(bytes);
        if (!cancelled) setTemplateChanged(Boolean(selectedTemplate.fingerprint && selectedTemplate.fingerprint !== fingerprint));
      })
      .catch((reason) => { if (!cancelled) { setTemplateBytes(null); setError(`读取模板失败：${String(reason)}`); } })
      .finally(() => { if (!cancelled) setLoadingTemplate(false); });
    return () => { cancelled = true; };
  }, [rootPath, selectedTemplate]);

  useEffect(() => {
    if (!selectedPlatform) {
      setRequirements([]);
      setRequirementId("");
      return;
    }
    let cancelled = false;
    api.scanRequirements(rootPath, selectedPlatform.path)
      .then((items) => {
        if (cancelled) return;
        setRequirements(items);
        setRequirementId((current) => items.some((item) => item.requirement.id === current) ? current : items.some((item) => item.requirement.id === initialRequirementId) ? initialRequirementId || "" : items[0]?.requirement.id || "");
      })
      .catch((reason) => { if (!cancelled) { setRequirements([]); setRequirementId(""); setError(`读取需求失败：${String(reason)}`); } });
    return () => { cancelled = true; };
  }, [initialRequirementId, rootPath, selectedPlatform, platformId]);

  useEffect(() => {
    if (!selectedPlatform || !requirementId) {
      setDocument(null);
      return;
    }
    let cancelled = false;
    setLoadingCases(true);
    const casesPath = joinPath(rootPath, selectedPlatform.path, requirementId, "04-测试用例", "cases.json");
    api.readJsonFile(casesPath)
      .then((value) => { if (!cancelled) setDocument(normalizeCasesDocument(value, requirementId, selectedPlatform.name, selectedPlatform.id)); })
      .catch((reason) => { if (!cancelled) { setDocument(null); setError(`读取cases.json失败：${String(reason)}`); } })
      .finally(() => { if (!cancelled) setLoadingCases(false); });
    return () => { cancelled = true; };
  }, [platformId, requirementId, rootPath, selectedPlatform]);

  const saveRegistry = async (next: CaseTemplateRegistry, successMessage?: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.saveJsonFile(registryPath, next);
      setRegistry(next);
      if (successMessage) setMessage(successMessage);
    } catch (reason) {
      setError(`保存模板登记失败：${String(reason)}`);
      throw reason;
    } finally {
      setSaving(false);
    }
  };

  const chooseSource = async () => {
    setError(null);
    try {
      if (isTauri) {
        const path = await api.chooseTemplateFile();
        if (!path) return;
        const bytes = await api.readBinaryFile(path);
        const type = fileType(path);
        if (!type) {
          setError("只支持XMind或.xlsx模板");
          return;
        }
        setRegistration((current) => ({ ...current, type, mapping: type === "excel" ? defaultExcelMapping() : defaultXMindMapping(), output_name_rule: defaultOutputRule(type) }));
        setSource({ name: path.split(/[\\/]/).pop() || path, path, bytes });
        return;
      }
      inputRef.current?.click();
    } catch (reason) {
      setError(`读取模板失败：${String(reason)}`);
    }
  };

  const handleSourceFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const type = fileType(file.name);
    if (!type) {
      setError("只支持XMind或.xlsx模板");
      return;
    }
    void file.arrayBuffer().then((buffer) => {
      setRegistration((current) => ({ ...current, type, mapping: type === "excel" ? defaultExcelMapping() : defaultXMindMapping(), output_name_rule: defaultOutputRule(type) }));
      setSource({ name: file.name, path: file.name, bytes: new Uint8Array(buffer) });
    }).catch((reason) => setError(`读取模板失败：${String(reason)}`));
  };

  const registerTemplate = async () => {
    if (!source || !registration.name.trim()) {
      setError("请选择模板文件并填写模板名称");
      return;
    }
    setError(null);
    try {
      const id = `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fingerprint = await sha256Bytes(source.bytes);
      const destination = templateStoragePath(rootPath, templatesDirectory, registration.type, registration.name, id);
      await api.createBinaryFile(destination, source.bytes);
      const now = new Date().toISOString();
      const template: CaseTemplate = {
        id,
        name: registration.name.trim(),
        type: registration.type,
        version: registration.version.trim() || "1.0",
        file_path: workspaceRelativePath(rootPath, destination),
        platform_id: registration.platform_id.trim() || null,
        fingerprint,
        output_name_rule: registration.output_name_rule.trim() || defaultOutputRule(registration.type),
        mapping: registration.mapping,
        required_fields: requiredFields(registration.type),
        is_default: !registry.templates.some((item) => item.type === registration.type && item.platform_id === (registration.platform_id.trim() || null)),
        created_at: now,
        updated_at: now,
      };
      const nextTemplates = [...registry.templates.map((item) => template.is_default && item.type === template.type && item.platform_id === template.platform_id ? { ...item, is_default: false } : item), template];
      await saveRegistry({ ...registry, templates: nextTemplates }, `已登记模板“${template.name}”`);
      setSelectedTemplateId(template.id);
      setSource(null);
      setShowRegister(false);
    } catch (reason) {
      setError(`登记模板失败：${String(reason)}`);
    }
  };

  const saveTemplateSettings = async () => {
    if (!selectedTemplate || !mappingDraft) return;
    const next = {
      ...registry,
      templates: registry.templates.map((item) => item.id === selectedTemplate.id ? { ...item, mapping: mappingDraft, output_name_rule: outputRuleDraft.trim() || item.output_name_rule, updated_at: new Date().toISOString() } : item),
    };
    await saveRegistry(next, "模板映射和输出规则已保存");
  };

  const setDefaultTemplate = async () => {
    if (!selectedTemplate) return;
    const next = {
      ...registry,
      templates: registry.templates.map((item) => item.type === selectedTemplate.type && item.platform_id === selectedTemplate.platform_id ? { ...item, is_default: item.id === selectedTemplate.id } : item),
    };
    await saveRegistry(next, `已将“${selectedTemplate.name}”设为默认模板`);
  };

  const exportCases = async () => {
    if (!selectedTemplate || !document || !templateBytes || !outputPath) {
      setError("请选择模板和包含cases.json的目标需求");
      return;
    }
    if (targetLocked) {
      setError("目标需求已锁定，模板导出被禁止");
      return;
    }
    if (templateChanged) {
      setError("模板文件指纹已变化，请重新登记新模板版本后再导出");
      return;
    }
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const result = selectedTemplate.type === "excel"
        ? await buildExcelExport(templateBytes, document, mappingDraft || selectedTemplate.mapping)
        : await buildXMindExport(templateBytes, document, mappingDraft || selectedTemplate.mapping);
      if (!result.validation.passed) throw new Error(`导出校验失败：${[...result.validation.errors, ...result.validation.warnings].join("；")}`);
      await api.createBinaryFile(outputPath, result.bytes);
      setLastOutput(outputPath);
      setMessage(`导出完成：${outputName}，共 ${result.validation.case_count} 条用例`);
    } catch (reason) {
      setError(`导出失败：${String(reason)}`);
    } finally {
      setExporting(false);
    }
  };

  return <div className="workspace-view template-export-view">
    <section className="document-header">
      <div className="document-title-row"><span className="document-icon blue"><AppIcon name="tools" size={20} /></span><div><div className="eyebrow">BB-10 / 模板化交付</div><h1>XMind / Excel 模板与导出</h1><p>从结构化 cases.json 生成保留模板格式的交付物</p></div></div>
      <div className="header-actions"><button className="button button-primary" type="button" onClick={() => { setRegistration(newFormState("xmind")); setSource(null); setShowRegister(true); }}><AppIcon name="add" size={15} /> 登记模板</button><button className="button button-ghost" type="button" onClick={() => window.location.reload()}><AppIcon name="refresh" size={15} /> 刷新</button></div>
    </section>
    <input ref={inputRef} type="file" accept=".xmind,.xlsx" onChange={handleSourceFile} hidden />
    <div className="template-export-layout">
      <aside className="panel-section template-list-panel"><div className="section-heading"><div><AppIcon name="archiveFile" size={16} /><h2>已登记模板</h2></div><span className="section-muted">{registry.templates.length}</span></div>{loading ? <div className="loading-line"><span className="spinner" />读取模板登记…</div> : registry.templates.length ? <div className="template-list">{registry.templates.map((template) => <button type="button" key={template.id} className={`template-list-row ${template.id === selectedTemplateId ? "active" : ""}`} onClick={() => setSelectedTemplateId(template.id)}><span className={`template-list-icon ${template.type}`}><AppIcon name={template.type === "xmind" ? "archiveFile" : "spreadsheet"} size={16} /></span><span className="template-list-main"><strong>{template.name}</strong><small>{template.type.toUpperCase()} · V{template.version}{template.platform_id ? ` · ${platformName(workspace.platforms, template.platform_id)}` : " · 通用"}</small></span>{template.is_default && <span className="template-default-badge">默认</span>}</button>)}</div> : <div className="inline-empty">尚未登记模板，请先登记XMind或Excel模板。</div>}</aside>
      <main className="template-export-main">
        <section className="panel-section template-source-panel"><div className="section-heading"><div><AppIcon name="checks" size={16} /><h2>导出来源</h2></div><span className="section-muted">{document ? `${document.cases.length} 条用例` : "未选择需求"}</span></div><div className="template-source-grid"><label className="field-label">平台<select className="field-input" value={platformId} onChange={(event) => { setPlatformId(event.target.value); setRequirementId(""); }}><option value="">选择平台</option>{activePlatforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）</option>)}</select></label><label className="field-label">需求<select className="field-input" value={requirementId} onChange={(event) => setRequirementId(event.target.value)} disabled={!selectedPlatform || !requirements.length}><option value="">{selectedPlatform ? "选择需求" : "先选择平台"}</option>{requirements.map((item) => <option key={item.requirement.id} value={item.requirement.id}>{item.requirement.id} · {item.requirement.name}</option>)}</select></label></div>{selectedRequirement?.client_access.mode === "locked_for_ai" && <div className="unlock-warning"><AppIcon name="lock" size={14} /><span>目标需求正在由AI处理，模板导出被禁用。</span></div>}{loadingCases && <div className="loading-line"><span className="spinner" />读取cases.json…</div>}{document && <div className="field-hint mono">{joinPath(rootPath, selectedPlatform?.path || "", requirementId, "04-测试用例", "cases.json")}</div>}</section>
        <section className="panel-section template-config-panel"><div className="section-heading"><div><AppIcon name="settings" size={16} /><h2>模板配置</h2></div>{selectedTemplate && <span className="status-pill">{selectedTemplate.type === "xmind" ? "XMind" : "Excel"} · V{selectedTemplate.version}</span>}</div>{selectedTemplate && mappingDraft ? <><div className="template-config-meta"><span title={resolveWorkspacePath(rootPath, selectedTemplate.file_path)}><AppIcon name="file" size={13} /> {selectedTemplate.file_path}</span><span className={templateChanged ? "template-fingerprint changed" : "template-fingerprint"}>{templateChanged ? "文件指纹已变化" : `SHA256 ${selectedTemplate.fingerprint.slice(0, 12)}…`}</span></div><div className="template-config-grid"><label className="field-label">模板名称<input className="field-input" value={selectedTemplate.name} readOnly /></label><label className="field-label">输出文件名规则<input className="field-input" value={outputRuleDraft} onChange={(event) => setOutputRuleDraft(event.target.value)} /></label></div><MappingEditor type={selectedTemplate.type} mapping={mappingDraft} onChange={setMappingDraft} /><div className="template-config-actions"><button className="button button-ghost button-small" type="button" onClick={() => void setDefaultTemplate()} disabled={saving || selectedTemplate.is_default}>设为默认</button><button className="button button-primary button-small" type="button" onClick={() => void saveTemplateSettings()} disabled={saving || !mappingDraft}>{saving ? "保存中…" : "保存模板配置"}</button></div></> : <div className="inline-empty large"><AppIcon name="inbox" size={18} />从左侧选择模板，或先登记一个模板。</div>}</section>
        <section className="panel-section template-preview-panel"><div className="section-heading"><div><AppIcon name="eye" size={16} /><h2>导出预览与校验</h2></div>{preview && <span className={`status-pill ${preview.missing_fields.length ? "warning" : "success"}`}>{preview.missing_fields.length ? `${preview.missing_fields.length} 项缺失` : "字段完整"}</span>}</div>{preview ? <><div className="template-preview-summary"><Summary label="输出文件" value={preview.output_name} /><Summary label="模板版本" value={`V${preview.template.version}`} /><Summary label="目录数量" value={`${preview.directory_count}`} /><Summary label="用例数量" value={`${preview.case_count}`} /></div>{preview.missing_fields.length > 0 && <div className="template-missing-fields"><AppIcon name="alert" size={14} /><span>缺失字段：{preview.missing_fields.join("、")}</span></div>}<div className="template-mapping-preview"><div className="subsection-title"><AppIcon name="list" size={14} />前十条映射结果</div>{preview.mappings.length ? preview.mappings.map((item) => <div className="template-mapping-row" key={item.case_id}><span className="template-mapping-directory" title={item.directory}>{item.directory}</span><strong title={item.title}>{item.title}</strong><small title={item.target}>{item.target}</small></div>) : <div className="inline-empty">当前没有可导出的用例。</div>}</div><div className="template-export-actions"><span className="field-hint mono" title={preview.output_path}>{preview.output_path}</span><button className="button button-primary" type="button" onClick={() => void exportCases()} disabled={Boolean(targetLocked || exporting || loadingTemplate || !templateBytes || preview.template_changed || preview.missing_fields.length > 0)}><AppIcon name="download" size={15} />{exporting ? "导出并校验中…" : "生成交付物"}</button></div>{lastOutput && <div className="template-output-success"><AppIcon name="check" size={14} /><span>已生成 {lastOutput}</span><button className="text-button" type="button" onClick={() => void systemOpen.openFile(lastOutput)}>外部打开</button></div>}</> : <div className="inline-empty large"><AppIcon name="eye" size={18} />选择模板、平台和需求后生成导出预览。</div>}</section>
        {message && <div className="toast toast-success"><AppIcon name="check" size={15} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}{error && <div className="toast toast-error"><AppIcon name="alert" size={15} /><span>{error}</span><button type="button" onClick={() => setError(null)}><AppIcon name="close" size={14} /></button></div>}
      </main>
    </div>
    {showRegister && <RegistrationModal workspace={workspace} platforms={activePlatforms} state={registration} source={source} saving={saving} onChange={setRegistration} onChooseSource={() => void chooseSource()} onClose={() => setShowRegister(false)} onSubmit={() => void registerTemplate()} />}
  </div>;
}

function RegistrationModal({ workspace, platforms, state, source, saving, onChange, onChooseSource, onClose, onSubmit }: { workspace: WorkspaceConfig; platforms: PlatformInfo[]; state: FormState; source: TemplateSource | null; saving: boolean; onChange: React.Dispatch<React.SetStateAction<FormState>>; onChooseSource: () => void; onClose: () => void; onSubmit: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}><div className="modal template-register-modal"><div className="modal-header"><div><span className="eyebrow">BB-10 / 模板登记</span><h2>登记用例交付模板</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving}><AppIcon name="close" size={16} /></button></div><p className="modal-description">模板会复制到工作区的 <span className="mono">templates/testcase</span>，原文件不会被覆盖；登记信息保存在 <span className="mono">.blackbox/templates.json</span>。</p><div className="xmind-import-source"><div><AppIcon name={state.type === "xmind" ? "archiveFile" : "spreadsheet"} size={17} /><span>{source ? <><strong>{source.name}</strong><small>{source.path}</small></> : <><strong>尚未选择模板文件</strong><small>支持 .xmind 和 .xlsx</small></>}</span></div><button className="button button-ghost button-small" type="button" onClick={onChooseSource} disabled={saving}><AppIcon name="upload" size={14} /> 选择文件</button></div><div className="template-register-grid"><label className="field-label">模板名称<input className="field-input" value={state.name} onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))} placeholder="例如：示例平台标准用例模板" /></label><label className="field-label">模板类型<select className="field-input" value={state.type} onChange={(event) => { const type = event.target.value as "xmind" | "excel"; onChange((current) => ({ ...current, type, mapping: type === "excel" ? defaultExcelMapping() : defaultXMindMapping(), output_name_rule: defaultOutputRule(type) })); }}><option value="xmind">XMind</option><option value="excel">Excel</option></select></label><label className="field-label">模板版本<input className="field-input" value={state.version} onChange={(event) => onChange((current) => ({ ...current, version: event.target.value }))} /></label><label className="field-label">适用平台<select className="field-input" value={state.platform_id} onChange={(event) => onChange((current) => ({ ...current, platform_id: event.target.value }))}><option value="">通用模板</option>{platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）</option>)}</select></label></div><label className="field-label">输出文件名规则<input className="field-input" value={state.output_name_rule} onChange={(event) => onChange((current) => ({ ...current, output_name_rule: event.target.value }))} /><span className="field-hint">可用变量：&#123;&#123;requirement_id&#125;&#125;、&#123;&#123;platform_id&#125;&#125;、&#123;&#123;date&#125;&#125;、&#123;&#123;ext&#125;&#125;</span></label><MappingEditor type={state.type} mapping={state.mapping} onChange={(mapping) => onChange((current) => ({ ...current, mapping }))} /><div className="modal-actions"><span className="modal-action-spacer" /><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button><button className="button button-primary" type="button" onClick={onSubmit} disabled={saving || !source || !state.name.trim()}>{saving ? "登记中…" : "保存登记"}</button></div></div></div>;
}

function MappingEditor({ type, mapping, onChange }: { type: "xmind" | "excel"; mapping: CaseTemplateMapping; onChange: (mapping: CaseTemplateMapping) => void }) {
  if (type === "xmind") {
    const value = mapping as XMindTemplateMapping;
    return <div className="template-mapping-form"><div className="mapping-form-title"><AppIcon name="archiveFile" size={14} />XMind节点映射</div><div className="template-register-grid"><MappingInput label="根节点（ID或标题，可空）" value={value.root_topic} onChange={(next) => onChange({ ...value, root_topic: next })} /><MappingInput label="目录占位节点" value={value.directory_placeholder} onChange={(next) => onChange({ ...value, directory_placeholder: next })} /><MappingInput label="用例占位节点" value={value.case_placeholder} onChange={(next) => onChange({ ...value, case_placeholder: next })} /><MappingInput label="前置条件节点" value={value.pc_topic} onChange={(next) => onChange({ ...value, pc_topic: next })} /><MappingInput label="步骤节点" value={value.tx_topic} onChange={(next) => onChange({ ...value, tx_topic: next })} /><MappingInput label="期望结果节点" value={value.expected_topic} onChange={(next) => onChange({ ...value, expected_topic: next })} /></div><label className="template-checkbox"><input type="checkbox" checked={value.expected_as_child} onChange={(event) => onChange({ ...value, expected_as_child: event.target.checked })} /><span>将返回数据作为 tx 子节点</span></label><span className="field-hint">占位节点可填写模板中的完整标题、节点ID或标题片段；未匹配时会在根节点追加生成内容。</span></div>;
  }
  const value = mapping as ExcelTemplateMapping;
  return <div className="template-mapping-form"><div className="mapping-form-title"><AppIcon name="spreadsheet" size={14} />Excel工作表与列映射</div><div className="template-register-grid"><MappingInput label="工作表名称（可空，默认第一个）" value={value.worksheet} onChange={(next) => onChange({ ...value, worksheet: next })} /><MappingNumber label="表头行" value={value.header_row} onChange={(next) => onChange({ ...value, header_row: next })} /><MappingNumber label="数据起始行" value={value.data_start_row} onChange={(next) => onChange({ ...value, data_start_row: next })} /><MappingInput label="目录列" value={value.directory_column} onChange={(next) => onChange({ ...value, directory_column: next })} /><MappingInput label="标题列" value={value.title_column} onChange={(next) => onChange({ ...value, title_column: next })} /><MappingInput label="优先级列" value={value.priority_column} onChange={(next) => onChange({ ...value, priority_column: next })} /><MappingInput label="测试类型列" value={value.test_type_column} onChange={(next) => onChange({ ...value, test_type_column: next })} /><MappingInput label="前置条件列" value={value.preconditions_column} onChange={(next) => onChange({ ...value, preconditions_column: next })} /><MappingInput label="步骤列" value={value.steps_column} onChange={(next) => onChange({ ...value, steps_column: next })} /><MappingInput label="期望结果列" value={value.expected_column} onChange={(next) => onChange({ ...value, expected_column: next })} /></div><span className="field-hint">列可以填写 Excel 字母（A、B、AA）或数字；导出会清理数据起始行后的示例行，再按用例数量写入。</span></div>;
}

function MappingInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="field-label">{label}<input className="field-input" value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function MappingNumber({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <label className="field-label">{label}<input className="field-input" type="number" min="1" value={value} onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))} /></label>; }
function Summary({ label, value }: { label: string; value: string }) { return <div className="template-preview-summary-card"><small>{label}</small><strong title={value}>{value}</strong></div>; }

function newFormState(type: "xmind" | "excel"): FormState { return { name: "", type, version: "1.0", platform_id: "", output_name_rule: defaultOutputRule(type), mapping: type === "excel" ? defaultExcelMapping() : defaultXMindMapping() }; }
function defaultOutputRule(type: "xmind" | "excel"): string { return `{{requirement_id}}-{{platform_id}}-用例.${type === "excel" ? "xlsx" : "xmind"}`; }
function fileType(path: string): "xmind" | "excel" | null { if (path.toLowerCase().endsWith(".xlsx")) return "excel"; if (path.toLowerCase().endsWith(".xmind")) return "xmind"; return null; }
function requiredFields(type: "xmind" | "excel"): string[] { return type === "xmind" ? ["目录", "标题", "优先级", "测试类型", "前置条件", "操作步骤", "期望结果"] : ["工作表", "目录列", "标题列", "优先级列", "测试类型列", "前置条件列", "步骤列", "期望结果列"]; }
function platformName(platforms: PlatformInfo[], id: string): string { return platforms.find((platform) => platform.id === id)?.name || id; }
