import React, { useEffect, useMemo, useState } from "react";
import { api, joinPath } from "../lib/api";
import AppIcon from "../components/AppIcon";
import XMindImportModal from "../components/XMindImportModal";
import type { DirEntryInfo, TestAssetInfo, WorkspaceConfig } from "../lib/types";
import type { WorkbenchTab } from "../lib/workbench";

interface AssetGroup {
  key: string;
  platformName: string;
  requirementId: string;
  requirementName: string;
  casesJsonExists: boolean;
  files: TestAssetInfo[];
}

export default function TestAssetsView({ workspace, onOpenTab, onRightContext }: { workspace: WorkspaceConfig; onOpenTab: (tab: WorkbenchTab) => void; onRightContext?: import("../lib/workbench").RightContextReporter }) {
  const rootPath = workspace.workspace.root_path;
  const legacyDirectory = joinPath(rootPath, "testCase");
  const [assets, setAssets] = useState<TestAssetInfo[]>([]);
  const [legacyFiles, setLegacyFiles] = useState<DirEntryInfo[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.scanTestAssets(rootPath).catch(() => [] as TestAssetInfo[]),
      api.listDirectory(legacyDirectory).catch(() => [] as DirEntryInfo[]),
    ])
      .then(([nextAssets, entries]) => {
        setAssets(nextAssets);
        setLegacyFiles(entries.filter((entry) => !entry.is_dir && /\.(xmind|xlsx)$/i.test(entry.name)));
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [rootPath, legacyDirectory]);

  const keyword = search.trim().toLowerCase();
  const groups = useMemo<AssetGroup[]>(() => {
    const map = new Map<string, AssetGroup>();
    for (const asset of assets) {
      if (keyword && !`${asset.name} ${asset.requirement_id} ${asset.requirement_name} ${asset.platform_name}`.toLowerCase().includes(keyword)) continue;
      const key = `${asset.platform_id}::${asset.requirement_id}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          platformName: asset.platform_name || asset.platform_id,
          requirementId: asset.requirement_id,
          requirementName: asset.requirement_name,
          casesJsonExists: asset.cases_json_exists,
          files: [],
        });
      }
      map.get(key)!.files.push(asset);
    }
    return [...map.values()];
  }, [assets, keyword]);

  const visibleLegacy = useMemo(
    () => legacyFiles.filter((entry) => !keyword || entry.name.toLowerCase().includes(keyword)),
    [legacyFiles, keyword],
  );

  const openFile = (path: string, name: string) => {
    const type = name.toLowerCase().endsWith(".xmind") ? "xmind" : "excel";
    onOpenTab({ id: `file:${path}`, type, title: name, subtitle: path, icon: type === "xmind" ? "archiveFile" : "spreadsheet", preview: true, pinned: false, dirty: false, closable: true, payload: { path } });
  };

  // BB-16D：上报测试资产分组大纲与统计属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "cases",
      title: "测试用例",
      subtitle: "XMind与Excel测试资产",
      outlineTitle: "需求分组",
      outline: groups.map((group) => ({
        id: group.key,
        label: `${group.requirementId} ${group.requirementName}`,
        badge: String(group.files.length),
        icon: "checks",
        hint: group.platformName,
        onSelect: () => group.files[0] && openFile(group.files[0].path, group.files[0].name),
      })),
      properties: [
        { label: "覆盖需求", value: String(groups.length) },
        { label: "资产文件", value: String(assets.length) },
        { label: "历史testCase目录", value: `${visibleLegacy.length} 个文件` },
      ],
      stats: [
        { label: "可结构化", value: String(assets.filter((item) => item.cases_json_exists).length) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, groups, assets.length, visibleLegacy.length]);

  const fileCard = (path: string, name: string, hint: string) => (
    <button key={path} className="asset-file-card" onClick={() => openFile(path, name)}>
      <span className={`asset-file-icon ${name.toLowerCase().endsWith(".xmind") ? "xmind" : "excel"}`}>
        <AppIcon name={name.toLowerCase().endsWith(".xmind") ? "archiveFile" : "spreadsheet"} size={19} />
      </span>
      <span><strong>{name}</strong><small>{hint}</small></span>
      <AppIcon name="next" size={15} />
    </button>
  );

  const total = assets.length + visibleLegacy.length;

  return <div className="workspace-view">
    <section className="document-header">
      <div className="document-title-row"><span className="document-icon blue"><AppIcon name="checks" size={20} /></span><div><div className="eyebrow">测试资产</div><h1>测试用例文件</h1><p>按平台与需求汇总 {joinPath(rootPath, "projects")} 下的 XMind / Excel 用例</p></div></div>
      <div className="header-actions"><button className="button button-primary" onClick={() => setShowImport(true)}><AppIcon name="upload" size={15} /> 导入XMind</button><button className="button button-ghost" onClick={() => onOpenTab({ id: "case-export", type: "case-export", title: "模板与导出", subtitle: "XMind与Excel模板化交付", icon: "tools", preview: false, pinned: true, dirty: false, closable: true })}><AppIcon name="tools" size={15} /> 模板与导出</button><button className="button button-ghost" onClick={load}><AppIcon name="refresh" size={15} />刷新</button></div>
    </section>

    <section className="panel-section">
      <div className="section-heading">
        <div><AppIcon name="archiveFile" size={16} /><h2>平台需求用例</h2></div>
        <div className="document-search"><AppIcon name="search" size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用例文件或需求" /></div>
      </div>
      {loading ? <div className="loading-line"><span className="spinner" />正在扫描工作区用例目录…</div>
        : groups.length ? <div className="asset-group-list">{groups.map((group) => (
          <div className="asset-group" key={group.key}>
            <div className="asset-group-heading">
              <AppIcon name="box" size={14} />
              <strong>{group.platformName}</strong>
              <span className="mono">{group.requirementId}</span>
              <span className="asset-group-name">{group.requirementName}</span>
              <span className={`status-pill ${group.casesJsonExists ? "success" : "warning"}`}>{group.casesJsonExists ? "已导入 cases.json" : "未导入 cases.json"}</span>
            </div>
            <div className="asset-file-grid">{group.files.map((asset) => fileCard(asset.path, asset.name, asset.kind === "xmind" ? "解析为结构化测试用例" : "按工作表阅读"))}</div>
          </div>
        ))}</div>
          : <div className="inline-empty large"><AppIcon name="inbox" size={20} />当前工作区没有识别到用例文件，可先“导入XMind”。</div>}
    </section>

    {visibleLegacy.length > 0 && <section className="panel-section">
      <div className="section-heading"><div><AppIcon name="history" size={16} /><h2>历史目录用例（未迁移）</h2></div><span className="section-muted">{legacyDirectory}</span></div>
      <div className="asset-file-grid">{visibleLegacy.map((entry) => fileCard(entry.path, entry.name, "历史目录，建议迁移到对应需求"))}</div>
    </section>}

    {total === 0 && !loading && <div className="field-hint">提示：用例文件位于 <span className="mono">{joinPath(rootPath, "projects", "<平台>", "<需求>", "04-测试用例")}</span>；结构化用例需在该目录生成 cases.json（由“导入XMind”产生）。</div>}

    {showImport && <XMindImportModal workspace={workspace} onClose={() => setShowImport(false)} onImported={(result) => { setShowImport(false); setMessage(`已导入 ${result.caseCount} 条用例：${result.path}`); load(); }} />}
    {message && <div className="toast toast-success"><AppIcon name="check" size={15} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}
  </div>;
}
