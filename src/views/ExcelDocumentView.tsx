import React, { useEffect, useMemo, useState } from "react";
import ExcelJS from "exceljs";
import { api } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import AppIcon from "../components/AppIcon";
import type { PathInfo } from "../lib/types";
import type { RightContextReporter } from "../lib/workbench";
import { formatModified, formatSize } from "./MarkdownDocumentView";

type SheetData = { name: string; rowCount: number; columnCount: number; rows: string[][] };
const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;

export default function ExcelDocumentView({ path, onRightContext }: { path: string; onRightContext?: RightContextReporter }) {
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<PathInfo | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const bytes = await api.readBinaryFile(path);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as any);
      const parsed = workbook.worksheets.map((worksheet) => {
        const rows: string[][] = [];
        const limit = Math.min(worksheet.rowCount, MAX_ROWS);
        for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
          const row = worksheet.getRow(rowNumber);
          const values: string[] = [];
          const columnLimit = Math.min(Math.max(worksheet.columnCount, row.cellCount), MAX_COLUMNS);
          for (let column = 1; column <= columnLimit; column += 1) values.push(row.getCell(column).text || "");
          rows.push(values);
        }
        return { name: worksheet.name, rowCount: worksheet.rowCount, columnCount: worksheet.columnCount, rows };
      });
      setSheets(parsed);
      setActiveSheet(0);
    } catch (reason) {
      setError(`Excel解析失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [path]);

  useEffect(() => {
    let cancelled = false;
    api.getPathInfo(path).then((info) => { if (!cancelled) setFileInfo(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [path, loading]);

  const sheet = sheets[activeSheet];

  // BB-16D：上报工作表大纲与文件属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "file",
      title: path.split(/[\\/]/).pop() || "Excel工作簿",
      subtitle: path,
      path,
      readOnly: true,
      outlineTitle: "工作表",
      outline: sheets.map((item, index) => ({ id: `sheet-${index}`, label: item.name, badge: `${item.rowCount}行`, icon: "spreadsheet", active: index === activeSheet, onSelect: () => setActiveSheet(index) })),
      properties: [
        { label: "文件名称", value: path.split(/[\\/]/).pop() || "" },
        { label: "文件类型", value: "Excel工作簿" },
        { label: "文件大小", value: fileInfo?.exists ? formatSize(fileInfo.size) : "—" },
        { label: "修改时间", value: fileInfo?.modified ? formatModified(fileInfo.modified) : "—" },
      ],
      stats: sheet ? [
        { label: "工作表数", value: String(sheets.length) },
        { label: "当前工作表", value: `${sheet.name}（${sheet.rowCount}行 × ${sheet.columnCount}列）` },
      ] : [{ label: "工作表数", value: String(sheets.length) }],
    });
    return () => onRightContext(null);
  }, [onRightContext, path, sheets, activeSheet, sheet, fileInfo]);

  const filteredRows = useMemo(() => {
    if (!sheet || !search.trim()) return sheet?.rows || [];
    const keyword = search.trim().toLowerCase();
    return sheet.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(keyword)));
  }, [sheet, search]);

  return (
    <div className="document-workspace excel-workspace">
      <div className="document-toolbar"><div className="document-toolbar-title"><AppIcon name="spreadsheet" size={16} /><strong>{path.split(/[\\/]/).pop()}</strong><span className="document-readonly">Excel阅读</span></div><div className="document-toolbar-actions"><div className="document-search"><AppIcon name="search" size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选当前工作表" /></div><button className="icon-button" onClick={() => void load()} title="重新解析"><AppIcon name="refresh" size={15} /></button><button className="icon-button" onClick={() => void systemOpen.reveal(path)} title="在目录中显示"><AppIcon name="folderOpen" size={15} /></button><button className="button button-ghost button-small" onClick={() => void systemOpen.openFile(path)}><AppIcon name="external" size={14} /> Excel/WPS打开</button></div></div>
      <div className="document-path" title={path}>{path}{sheet && <span>{sheet.rowCount} 行 × {sheet.columnCount} 列</span>}</div>
      {loading ? <div className="center-state"><span className="spinner" />正在解析工作簿…</div> : error ? <div className="center-state"><AppIcon name="alert" size={24} /><strong>{error}</strong><span>加密工作簿、宏和部分复杂公式需要使用Excel/WPS查看。</span></div> : <><div className="sheet-tabs">{sheets.map((item, index) => <button key={`${item.name}-${index}`} className={activeSheet === index ? "active" : ""} onClick={() => setActiveSheet(index)}>{item.name}<span>{item.rowCount}</span></button>)}</div><div className="excel-table-scroll">{sheet ? <table className="excel-table"><thead><tr><th className="excel-row-number" />{Array.from({ length: Math.max(1, Math.min(sheet.columnCount, MAX_COLUMNS)) }, (_, index) => <th key={index}>{columnName(index + 1)}</th>)}</tr></thead><tbody>{filteredRows.map((row, rowIndex) => <tr key={rowIndex}><th className="excel-row-number">{search ? "·" : rowIndex + 1}</th>{Array.from({ length: Math.max(1, Math.min(sheet.columnCount, MAX_COLUMNS)) }, (_, columnIndex) => <td key={columnIndex} title={row[columnIndex] || ""}>{row[columnIndex] || ""}</td>)}</tr>)}</tbody></table> : <div className="center-state">工作簿中没有工作表</div>}</div>{sheet && (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) && <div className="document-footer"><span>为保证客户端流畅，当前最多展示 {MAX_ROWS} 行、{MAX_COLUMNS} 列</span><span>完整内容请使用Excel/WPS打开</span></div>}</>}
    </div>
  );
}

function columnName(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
