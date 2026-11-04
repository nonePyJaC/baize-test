/** Provider-neutral business contracts. Credentials only live in local preferences. */
export type Capability = "identity" | "requirements" | "defects" | "cases" | "plans" | "attachments" | "tasks";
export interface Connection {
  connection_id: string;
  provider_id: string;
  display_name: string;
  enabled: boolean;
  schema_version: number;
  capabilities: Capability[];
  config: Record<string, string>;
}
export interface ExternalReference {
  connection_id: string;
  provider_id: string;
  entity_type: string;
  external_id: string;
  display_key: string;
  title: string;
  url?: string;
  project_ref?: string;
  linked_at: string;
  role?: string;
  extensions?: Record<string, unknown>;
}
export interface IntegrationDefaults { requirement?: string; defect?: string; publication?: string }
export interface ExternalEntity extends ExternalReference { description?: string; parent_ref?: string; search_terms?: string[] }
export interface FormField { id: string; label: string; required: boolean; default_value?: string; options: Array<{ id: string; label: string }> }
export interface DefectForm { parent_required: boolean; assignee_required: boolean; fields: FormField[] }
export function defectFieldDefaults(form: DefectForm): Record<string, string> {
  return Object.fromEntries(form.fields.filter(f => f.default_value !== undefined && (!f.options.length || f.options.some(o => o.id === f.default_value))).map(f => [f.id, f.default_value!]));
}
export interface AttachmentDraft { id: string; name: string; data_base64: string }
export interface DefectDraft {
  title: string; description: string; project_ref: string; parent_ref?: string;
  assignee?: string; verifier?: string; sprint_ref?: string; fields: Record<string, string>;
  attachments: AttachmentDraft[];
}
export interface SubmitResult {
  status: "created" | "attachments_partial" | "local_link_failed" | "failed";
  reference: ExternalReference;
  pending_attachments: AttachmentDraft[];
  warnings: string[];
  description: string;
  embeds: Record<string, string>;
}
export interface PublicationInput {
  requirement_dir: string; version_id: string; fingerprint: string;
  repository: string; directory: string; case_ids: string[];
}
export interface PublicationItem { case_id: string; title: string; action: string; digest: string; external_id?: string; error?: string }
export interface PublicationPreview { input: PublicationInput; connection_id: string; items: PublicationItem[]; preview_token: string; receipt: PublicationReceipt }
export interface PublicationReceipt {
  schema_version: number; connection_id: string; provider_id: string; version_id: string; fingerprint: string;
  repository: string; directory: string; status: string; simulated: boolean; updated_at: string;
  items: PublicationItem[];
}
export function referenceKey(ref: ExternalReference): string {
  return JSON.stringify([ref.connection_id, ref.provider_id, ref.entity_type, ref.external_id]);
}
export function mergeReferences(...lists: ExternalReference[][]): ExternalReference[] {
  return [...new Map(lists.flat().filter(r => r.external_id).map(r => [referenceKey(r), r])).values()];
}
/** Historical reads never infer an organization from today's default connection. */
export function defectReferences(result: Record<string, unknown>): ExternalReference[] {
  const refs = Array.isArray(result.external_refs) ? result.external_refs as ExternalReference[] : [];
  const id = String(result.yunxiao_bug_id || "");
  if (!id || refs.some(r => r.provider_id === "yunxiao" && r.external_id === id)) return refs;
  return mergeReferences(refs, [{ connection_id: String(result.yunxiao_connection_id || "legacy-unresolved"), provider_id: "yunxiao", entity_type: "defect", external_id: id, display_key: String(result.yunxiao_bug_serial || id), title: String(result.yunxiao_bug_subject || ""), linked_at: String(result.yunxiao_bug_at || "") }]);
}
export function defectSummary(result: Record<string, unknown>): string {
  const parts = defectReferences(result).map(r => [r.display_key || r.external_id, r.title, r.url].filter(Boolean).join(" · "));
  const manual = String(result.defect_url || "").trim();
  if (manual && !parts.some(p => p.includes(manual))) parts.push(manual);
  return parts.join("；");
}
