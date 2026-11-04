import React, { useEffect, useState } from "react";
import { loadConnections, type Connection, type IntegrationDefaults } from "../services/integrations";
export default function IntegrationDefaultsPicker({ value, onChange }: { value: IntegrationDefaults; onChange: (v: IntegrationDefaults) => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => { void loadConnections().then(setConnections); }, []);
  return <details><summary>本需求外部连接默认值</summary>{([['requirement','需求来源','requirements'],['defect','缺陷目标','defects'],['publication','用例发布目标','cases']] as const).map(([role,label,capability]) => <label key={role} className="field-label">{label}<select className="field-input" value={value[role] || ""} onChange={e => onChange({ ...value, [role]: e.target.value })}><option value="">继承平台 / 工作区 / 本机默认值</option>{value[role] && !connections.some(c => c.connection_id === value[role]) && <option value={value[role]}>原连接 {value[role]}（当前不可用）</option>}{connections.filter(c => c.capabilities.includes(capability)).map(c => <option key={c.connection_id} value={c.connection_id}>{c.display_name}{c.enabled ? "" : "（已关闭）"}</option>)}</select></label>)}</details>;
}
