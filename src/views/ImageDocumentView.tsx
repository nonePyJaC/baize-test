import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import AppIcon from "../components/AppIcon";
import type { PathInfo } from "../lib/types";
import type { RightContextReporter } from "../lib/workbench";
import { formatModified, formatSize } from "./MarkdownDocumentView";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function ImageDocumentView({ path, onRightContext }: { path: string; onRightContext?: RightContextReporter }) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fileInfo, setFileInfo] = useState<PathInfo | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setZoom(1);
    api.readBinaryFile(path)
      .then((bytes) => {
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = blobUrl;
        setUrl(blobUrl);
        setSize(bytes.byteLength);
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [path]);

  const name = useMemo(() => path.split(/[\\/]/).pop() || path, [path]);
  const zoomIn = () => setZoom((current) => ZOOM_STEPS.find((step) => step > current) ?? current);
  const zoomOut = () => setZoom((current) => [...ZOOM_STEPS].reverse().find((step) => step < current) ?? current);

  useEffect(() => {
    let cancelled = false;
    api.getPathInfo(path).then((info) => { if (!cancelled) setFileInfo(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [path, loading]);

  // BB-16D：图片文件属性（无标题大纲）
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "file",
      title: name,
      subtitle: path,
      path,
      readOnly: true,
      properties: [
        { label: "文件名称", value: name },
        { label: "文件类型", value: `图片（${name.split(".").pop()?.toUpperCase() || "未知"}）` },
        { label: "文件大小", value: fileInfo?.exists ? formatSize(fileInfo.size) : formatSize(size) },
        { label: "修改时间", value: fileInfo?.modified ? formatModified(fileInfo.modified) : "—" },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, path, name, size, fileInfo]);

  return (
    <div className="document-workspace image-workspace">
      <div className="document-toolbar">
        <div className="document-toolbar-title">
          <AppIcon name="image" size={16} />
          <div><strong>{name}</strong><small>{size ? `${(size / 1024).toFixed(1)} KB` : "图片预览"}</small></div>
        </div>
        <div className="document-toolbar-actions">
          <button className="icon-button" type="button" onClick={zoomOut} disabled={zoom <= ZOOM_STEPS[0]} title="缩小"><AppIcon name="minus" size={15} /></button>
          <span className="image-zoom-label mono">{Math.round(zoom * 100)}%</span>
          <button className="icon-button" type="button" onClick={zoomIn} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} title="放大"><AppIcon name="add" size={15} /></button>
          <button className="button button-ghost button-small" type="button" onClick={() => setZoom(1)}>原始比例</button>
          <button className="icon-button" type="button" onClick={() => void systemOpen.reveal(path)} title="在目录中显示"><AppIcon name="folderOpen" size={15} /></button>
          <button className="button button-ghost button-small" type="button" onClick={() => void systemOpen.openFile(path)}><AppIcon name="external" size={14} /> 系统打开</button>
        </div>
      </div>
      <div className="document-path" title={path}>{path}</div>
      <div className="image-stage">
        {loading ? <div className="center-state"><span className="spinner" />正在读取图片…</div>
          : error ? <div className="center-state"><AppIcon name="alert" size={22} /><strong>图片读取失败</strong><span>{error}</span></div>
            : url ? <img className="image-preview" src={url} alt={name} style={{ width: `${zoom * 100}%` }} /> : null}
      </div>
    </div>
  );
}
