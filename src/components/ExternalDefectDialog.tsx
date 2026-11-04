import React, { useEffect, useMemo, useRef, useState } from "react";
import ConnectionPicker from "./ConnectionPicker";
import SearchableSelect from "./SearchableSelect";
import { api } from "../lib/api";
import { loadConnections, selectDefectConnection, resolveDefectContext, mergeReferences, defectFieldDefaults, service, type Connection, type ExternalEntity, type ExternalReference, type DefectForm, type SubmitResult, type AttachmentDraft, type IntegrationDefaults } from "../services/integrations";
import type { RequirementMeta } from "../lib/types";
type MemberOption = ExternalEntity & { id: string };
const memberName = (m: MemberOption) => m.title;
const memberSearchTerms = (m: MemberOption) => m.search_terms || [];
export default function ExternalDefectDialog({ requirement, description = "", title = "", storageKey, mode = "create", inheritedDefaults = [], onClose, onLinked }: { requirement?: RequirementMeta | null; description?: string; title?: string; storageKey: string; mode?: "create" | "link"; inheritedDefaults?: Array<IntegrationDefaults | undefined>; onClose: () => void; onLinked: (ref: ExternalReference) => Promise<boolean> }) {
  const [connection, setConnection] = useState<Connection>();
  const [projects, setProjects] = useState<ExternalEntity[]>([]);
  const [members, setMembers] = useState<ExternalEntity[]>([]);
  const memberOptions = useMemo(() => members.map(m => ({ ...m, id: m.external_id })), [members]);
  const verifierOptions = useMemo(() => [{ id: "", external_id: "", title: "不指定", connection_id: "", provider_id: "", entity_type: "member", display_key: "", linked_at: "" }, ...memberOptions], [memberOptions]);
  const [parents, setParents] = useState<ExternalEntity[]>([]);
  const [project, setProject] = useState("");
  const [parent, setParent] = useState("");
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState(title);
  const [body, setBody] = useState(description);
  const [assignee, setAssignee] = useState("");
  const [verifier, setVerifier] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [form, setForm] = useState<DefectForm>();
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [candidates, setCandidates] = useState<ExternalReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contextLoading, setContextLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const searchVersion = useRef(0);
  const key = `baize-defect-receipt:${storageKey}`;
  const [receipt, setReceipt] = useState<SubmitResult | null>(() => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } });
  const [linked, setLinked] = useState(false);
  const [uncertain, setUncertain] = useState(() => localStorage.getItem(`${key}:uncertain`) === "true");
  const keep = (r: SubmitResult) => { setReceipt(r); try { localStorage.setItem(key, JSON.stringify(r)); } catch { setError("本地回执缓存空间不足，请先保存关联再关闭"); } };
  useEffect(() => { let live = true; void api.loadClientPreferences().then(p => loadConnections().then(cs => { if (!live) return; const originId = receipt?.reference.connection_id || localStorage.getItem(`${key}:origin`); const previous = originId ? cs.find(c => c.connection_id === originId) : undefined; setConnection(originId ? previous : selectDefectConnection(cs, requirement, ...inheritedDefaults, p.integration_defaults)); })).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, []);
  useEffect(() => {
    setProjects([]); setMembers([]); setCandidates([]); setProject(""); setParent(""); setParents([]); setForm(undefined); setFields({}); setAssignee(""); setVerifier(""); setError(""); setQuery("");
    setContextLoading(false);
    if (!connection) return;
    let live = true;
    const fail = (e: unknown) => { if (live) setError(String(e)); };
    void service<ExternalEntity[]>(connection, "projects").then(p => { if (live) setProjects(p); }).catch(fail);
    void service<ExternalEntity[]>(connection, "members").then(m => { if (live) setMembers(m); }).catch(fail);
    setContextLoading(true);
    void resolveDefectContext(requirement, connection).then(context => {
      if (!live) return;
      setProject(context.project_ref);
      if (context.parent) { setParent(context.parent.external_id); setParents([context.parent]); }
    }).catch(fail).finally(() => { if (live) setContextLoading(false); });
    return () => { live = false; };
  }, [connection]);
  useEffect(() => { ++searchVersion.current; setSearching(false); setSearchMessage(""); return () => { ++searchVersion.current; }; }, [connection, project]);
  useEffect(() => { setForm(undefined); setFields({}); if (!connection || !project || mode !== "create") return; let live = true; void service<DefectForm>(connection, "defect_form", { project_ref: project }).then(v => { if (live) { setForm(v); setFields(defectFieldDefaults(v)); } }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [connection, project, mode]);
  const searchParents = async () => {
    if (!connection || !project) return;
    const version = ++searchVersion.current;
    setSearching(true); setSearchMessage(""); setError("");
    try {
      const found = await service<ExternalEntity[]>(connection, "requirements", { project_ref: project, keyword: query.trim() });
      if (version !== searchVersion.current) return;
      setParents(old => mergeReferences(old.filter(p => p.external_id === parent), found));
      setSearchMessage(found.length ? `找到 ${found.length} 条需求，请在父需求中选择` : "未找到匹配需求，请核对项目或更换关键词；已选需求会保留");
    } catch (e) { if (version === searchVersion.current) setError(String(e)); }
    finally { if (version === searchVersion.current) setSearching(false); }
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const link = async (r: SubmitResult) => { try { const ok = await onLinked(r.reference); setLinked(ok); if (!ok) { keep({ ...r, status: "local_link_failed", warnings: [...r.warnings, "远端对象已存在，本地关联保存失败，请重试关联"] }); } } catch (e) { keep({ ...r, status: "local_link_failed", warnings: [...r.warnings, String(e)] }); } };
  const create = async () => {
    if (!connection || receipt) return;
    if (!form || !subject.trim() || (form.parent_required && !parent) || (form.assignee_required && !assignee) || form.fields.some(f => f.required && !fields[f.id])) { setError("请按该项目的字段要求填写完整"); return; }
    await run(async () => {
      // Persist before issuing a create. A crash/timeout must not offer another blind create.
      localStorage.setItem(`${key}:origin`, connection.connection_id); localStorage.setItem(`${key}:uncertain`, "true"); setUncertain(true);
      const r = await service<SubmitResult>(connection, "create_defect", { title: subject.trim(), description: body, project_ref: project, parent_ref: parent, assignee, verifier, fields, attachments });
      keep(r); localStorage.removeItem(`${key}:uncertain`); setUncertain(false); await link(r);
    });
  };
  const addFiles = async (files: File[]) => {
    const added = await Promise.all(files.map(async f => ({ id: crypto.randomUUID(), name: f.name, data_base64: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(f); }) })));
    setAttachments(old => [...old, ...added]); setBody(old => `${old}\n${added.map(a => `[[IMG:${a.id}]]`).join("\n")}`);
  };
  const close = () => { if (receipt && !linked) { setError("远端对象已创建，请先重试保存本地关联；回执已缓存，重新打开可继续"); return; } if (receipt?.status === "created" && linked) localStorage.removeItem(key); onClose(); };
  return <div className="modal-backdrop"><div className="modal bug-report-modal"><div className="modal-header"><h2>{mode === "link" ? "关联已有缺陷" : "提交缺陷"}</h2><button type="button" className="icon-button" disabled={busy} onClick={close}>关闭</button></div>
    {!receipt && <><ConnectionPicker capability="defects" value={connection?.connection_id} onChange={c => { if (!uncertain) { setConnection(c); setParents([]); } }} /><label className="field-label">目标项目<select className="field-input" disabled={contextLoading || busy} value={project} onChange={e => { setProject(e.target.value); setParent(""); setParents([]); }}><option value="">选择项目</option>{project && !projects.some(p => p.external_id === project) && <option value={project}>已关联项目 · {project}</option>}{projects.map(p => <option key={p.external_id} value={p.external_id}>{p.title}</option>)}</select></label>
      {mode === "create" && !uncertain ? <><label className="field-label">父需求{form?.parent_required ? "（必填）" : "（可选）"}<select className="field-input" disabled={contextLoading || busy} value={parent} onChange={e => setParent(e.target.value)}><option value="">{contextLoading ? "正在读取当前需求的绑定…" : "请选择"}</option>{parents.map(p => <option key={p.external_id} value={p.external_id}>{p.display_key} · {p.title}</option>)}</select></label><input className="field-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索父需求标题或编号" /><button type="button" className="button button-ghost" disabled={!connection || !project || contextLoading || searching || busy} onClick={() => void searchParents()}>{searching ? "搜索中…" : "搜索需求"}</button>{searchMessage && <p className="field-help" role="status">{searchMessage}</p>}
        <label className="field-label">缺陷标题<input className="field-input" value={subject} onChange={e => setSubject(e.target.value)} /></label><label className="field-label">实际现象与复现描述<textarea className="field-input field-textarea" rows={10} value={body} onChange={e => setBody(e.target.value)} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } }} /></label><input type="file" multiple accept="image/*" onChange={e => void addFiles(Array.from(e.target.files || []))} />{attachments.map(a => <span key={a.id}>{a.name} </span>)}
        <label className="field-label">负责人{form?.assignee_required ? "（必填）" : ""}<SearchableSelect ariaLabel="负责人" items={memberOptions} value={assignee} onSelect={m => setAssignee(m.id)} getItemName={memberName} getItemSearchTerms={memberSearchTerms} placeholder="搜索姓名、拼音或首字母" disabled={busy} /></label><label className="field-label">验证者（可选）<SearchableSelect ariaLabel="验证者" items={verifierOptions} value={verifier} onSelect={m => setVerifier(m.id)} getItemName={memberName} getItemSearchTerms={memberSearchTerms} placeholder="搜索姓名、拼音或首字母" disabled={busy} /></label>
        {form?.fields.map(f => <label key={f.id} className="field-label">{f.label}{f.required ? " *" : ""}{f.options.length ? <select className="field-input" value={fields[f.id] || ""} onChange={e => setFields(v => ({ ...v, [f.id]: e.target.value }))}><option value="">请选择</option>{f.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select> : <input className="field-input" value={fields[f.id] || ""} onChange={e => setFields(v => ({ ...v, [f.id]: e.target.value }))} />}</label>)}<button type="button" className="button button-primary" disabled={!connection || busy || !form} onClick={() => void create()}>创建缺陷并保存关联</button>
      </> : <>{uncertain && <p className="unlock-warning">上次创建结果未确认。请查询并关联远端对象；已核实未创建时可恢复表单。</p>}<input className="field-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="缺陷编号、链接或 ID" /><button type="button" className="button button-ghost" disabled={!connection || busy} onClick={() => void run(async () => { setCandidates(await service(connection!, "resolve_defect", { project_ref: project, query })); })}>查询缺陷</button>{candidates.map(r => <div key={r.external_id}>{r.display_key} · {r.title}<button type="button" disabled={busy} onClick={() => void run(async () => { const v: SubmitResult = { reference: r, status: "created", warnings: [], pending_attachments: [], description: "", embeds: {} }; keep(v); localStorage.removeItem(`${key}:uncertain`); setUncertain(false); await link(v); })}>确认关联</button></div>)}{uncertain && <button type="button" disabled={busy} onClick={() => { if (window.confirm("确认已核对原连接与远端记录，确实未创建缺陷？")) { localStorage.removeItem(`${key}:uncertain`); setUncertain(false); } }}>已核实未创建，恢复表单</button>}</>}
    </>}
    {receipt && <div role="status"><strong>远端已存在：{receipt.reference.display_key || receipt.reference.external_id} · {receipt.reference.title}</strong><p>{linked ? "本地关联已保存" : "本地关联待保存"}</p>{receipt.warnings.map((w, i) => <p key={i} className="unlock-warning">{w}</p>)}<button type="button" className="button button-ghost" disabled={busy} onClick={() => void run(() => link(receipt))}>重试保存本地关联</button>{(receipt.pending_attachments.length > 0 || receipt.status === "attachments_partial") && <button type="button" className="button button-ghost" disabled={busy || !connection?.enabled} onClick={() => void run(async () => { const r = await service<SubmitResult>(connection!, "retry_attachments", receipt); keep(r); })}>仅重试附件与正文</button>}<p className="field-help">再次提交其他缺陷时将保留此前所有引用。未完成附件的回执会保留，重新打开可继续。</p></div>}
    {error && <p role="alert" className="unlock-warning">{error}</p>}
  </div></div>;
}
