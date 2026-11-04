import { api } from "../../lib/api";
import type { ClientPreferences, RequirementMeta } from "../../lib/types";
import { mergeReferences, type Capability, type Connection, type ExternalEntity, type ExternalReference, type IntegrationDefaults } from "../../domain/integrations";
export * from "../../domain/integrations";
/** Compatibility conversion, read only. Explicit connections suppress implicit legacy migration. */
export function connectionsFromPreferences(p: ClientPreferences): Connection[] {
  if (p.connections !== undefined) return p.connections;
  const y = p.yunxiao;
  return y.access_token || y.organization_id ? [{ connection_id: `legacy-yunxiao-${y.organization_id || "unverified"}`, provider_id: "yunxiao", display_name: y.organization_name || "原云效连接", enabled: y.enabled, schema_version: 1, capabilities: ["identity", "requirements", "defects", "cases", "plans", "attachments", "tasks"], config: { ...Object.fromEntries(Object.entries(y).filter(([, v]) => typeof v === "string")) } }] : [];
}
export async function loadConnections(): Promise<Connection[]> { return connectionsFromPreferences(await api.loadClientPreferences()); }
export function selectConnection(connections: Connection[], capability: Capability, role: keyof IntegrationDefaults, ...scopes: Array<IntegrationDefaults | undefined>): Connection | undefined {
  const id = scopes.find(scope => scope?.[role])?.[role];
  if (id) return connections.find(c => c.connection_id === id && c.enabled && c.capabilities.includes(capability));
  const candidates = connections.filter(c => c.enabled && c.capabilities.includes(capability));
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function requirementReferences(r?: RequirementMeta | null, legacyConnectionId = "legacy-unresolved"): ExternalReference[] {
  const refs = r?.external_refs || [];
  const y = r?.yunxiao;
  if (!y?.workitem_id || refs.some(ref => ref.provider_id === "yunxiao" && ref.external_id === y.workitem_id)) return refs;
  return mergeReferences(refs, [{ connection_id: legacyConnectionId, provider_id: "yunxiao", entity_type: "requirement", role: "source", external_id: y.workitem_id, display_key: y.workitem_serial, title: y.workitem_subject, project_ref: y.project_id, linked_at: "" }]);
}
/** Prefer a requirement's existing connection when no defect connection was explicitly configured. */
export function selectDefectConnection(connections: Connection[], r?: RequirementMeta | null, ...scopes: Array<IntegrationDefaults | undefined>): Connection | undefined {
  const defaults = [r?.integration_defaults, ...scopes];
  if (defaults.some(scope => scope?.defect)) return selectConnection(connections, "defects", "defect", ...defaults);
  const refs = requirementReferences(r).filter(ref => ref.entity_type === "requirement");
  const bound = connections.filter(c => c.enabled && c.capabilities.includes("defects") && refs.some(ref => ref.connection_id === c.connection_id && ref.provider_id === c.provider_id));
  if (bound.length) return bound.length === 1 ? bound[0] : undefined;
  const legacy = refs.find(ref => ref.connection_id === "legacy-unresolved");
  if (legacy) {
    const candidates = connections.filter(c => c.provider_id === legacy.provider_id && c.enabled && c.capabilities.includes("defects"));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  return selectConnection(connections, "defects", "defect");
}
/** Resolve old bindings for this dialog only; never migrate or overwrite the stored requirement. */
export async function resolveDefectContext(r: RequirementMeta | null | undefined, c: Connection): Promise<{ project_ref: string; parent?: ExternalReference }> {
  const refs = requirementReferences(r);
  const current = refs.filter(ref => ref.connection_id === c.connection_id && ref.provider_id === c.provider_id);
  const parent = current.find(ref => ref.entity_type === "requirement" && ref.role === "source") || current.find(ref => ref.entity_type === "requirement");
  const project = current.find(ref => ref.entity_type === "project")?.external_id || "";
  if (parent) return { project_ref: parent.project_ref || project, parent };
  const legacy = refs.find(ref => ref.connection_id === "legacy-unresolved" && ref.provider_id === c.provider_id && ref.entity_type === "requirement");
  if (!legacy) return { project_ref: project };
  // A read by the exact bound ID verifies the selected organization, without relying on search results.
  const remote = await service<ExternalEntity>(c, "requirement", { external_id: legacy.external_id });
  if (remote.external_id !== legacy.external_id || (remote.project_ref && legacy.project_ref && remote.project_ref !== legacy.project_ref)) {
    throw new Error("当前连接中的需求与原绑定不一致，请切换到原连接；原绑定未修改");
  }
  const resolved = { ...legacy, ...remote, connection_id: c.connection_id, provider_id: c.provider_id, project_ref: remote.project_ref || legacy.project_ref, display_key: remote.display_key || legacy.display_key, title: remote.title || legacy.title };
  return { project_ref: resolved.project_ref || project, parent: resolved };
}
export async function service<T>(c: Connection, operation: string, args: unknown = {}): Promise<T> {
  return api.integrationCall<T>(c, operation, args);
}
