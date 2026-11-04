import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { connectionsFromPreferences, selectConnection, type Connection, type Capability, type IntegrationDefaults } from "../services/integrations";
export default function ConnectionPicker({ capability, value, onChange, includeDisabled = false, role, defaults = [] }: { capability: Capability; value?: string; onChange: (c: Connection | undefined) => void; includeDisabled?: boolean; role?: keyof IntegrationDefaults; defaults?: Array<IntegrationDefaults | undefined> }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => { let live = true; void api.loadClientPreferences().then(p => { if (!live) return; const cs = connectionsFromPreferences(p); setConnections(cs); if (!value && role) onChange(selectConnection(cs, capability, role, ...defaults, p.integration_defaults)); }); return () => { live = false; }; }, []);
  return <label className="field-label">外部连接<select className="field-input" value={value || ""} onChange={e => onChange(connections.find(c => c.connection_id === e.target.value))}><option value="">仅本地 / 请选择连接</option>{connections.filter(c => (includeDisabled || c.enabled) && c.capabilities.includes(capability)).map(c => <option key={c.connection_id} value={c.connection_id}>{c.display_name}{!c.enabled ? "（已关闭）" : ""}</option>)}</select></label>;
}
