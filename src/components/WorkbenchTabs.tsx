import React, { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import AppIcon from "./AppIcon";
import { centerActiveTab } from "../lib/scrollTabs";
import type { WorkbenchTab } from "../lib/workbench";

/** 菜单与视口边缘的留白，以及菜单宽度估算值（与 .tab-context-menu 的 min-width 对应） */
const MENU_MARGIN = 8;
const MENU_WIDTH = 150;

interface WorkbenchTabsProps {
  tabs: WorkbenchTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToLeft: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCloseAll: () => void;
  onRestore: () => void;
  canRestore: boolean;
}

export default function WorkbenchTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onPin,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onCloseAll,
  onRestore,
  canRestore,
}: WorkbenchTabsProps) {
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 新打开或切换的Tab可能落在可视区外（如点击AI任务新增的Tab），滚动到中间保持可见
  useEffect(() => {
    centerActiveTab(listRef.current);
  }, [activeId, tabs.length]);

  // Tab菜单用 fixed 定位挂在滚动容器外：tab-list 有 overflow-x，菜单放里面会被裁掉
  const openMenu = (id: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
    const left = Math.min(Math.max(rect.right - MENU_WIDTH, MENU_MARGIN), maxLeft);
    setMenu({ id, left, top: rect.bottom + 2 });
  };

  const menuTab = menu ? tabs.find((tab) => tab.id === menu.id) : undefined;

  return (
    <div className="tab-strip" onMouseLeave={() => setMenu(null)}>
      <div className="tab-list" ref={listRef}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`workbench-tab ${activeId === tab.id ? "active" : ""} ${tab.preview ? "preview" : ""}`}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => onPin(tab.id)}
            onContextMenu={(event) => { event.preventDefault(); openMenu(tab.id, event.currentTarget); }}
            title={tab.subtitle || tab.title}
          >
            <AppIcon name={(tab.icon as any) || "file"} size={15} />
            <span className="tab-title">{tab.title}</span>
            {tab.dirty && <span className="tab-dirty" aria-label="未保存" />}
            {tab.preview && !tab.pinned && <span className="tab-preview-mark">预览</span>}
            {tab.closable && (
              <button
                className="tab-close"
                onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
                aria-label={`关闭${tab.title}`}
              >
                <AppIcon name="close" size={14} />
              </button>
            )}
            <button
              className="tab-menu-trigger"
              onClick={(event) => {
                event.stopPropagation();
                if (menu?.id === tab.id) setMenu(null);
                else openMenu(tab.id, event.currentTarget.closest(".workbench-tab") || event.currentTarget);
              }}
              aria-label="Tab菜单"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        ))}
      </div>
      {menuTab && menu && (
        <div className="tab-context-menu" style={{ left: menu.left, top: menu.top }} onClick={(event) => event.stopPropagation()}>
          <button disabled={!menuTab.closable} onClick={() => { onClose(menuTab.id); setMenu(null); }}>关闭</button>
          <button onClick={() => { onCloseOthers(menuTab.id); setMenu(null); }}>关闭其他</button>
          <button disabled={!closableNeighbour(menuTab.id, "left", tabs)} onClick={() => { onCloseToLeft(menuTab.id); setMenu(null); }}>关闭左侧Tab</button>
          <button disabled={!closableNeighbour(menuTab.id, "right", tabs)} onClick={() => { onCloseToRight(menuTab.id); setMenu(null); }}>关闭右侧Tab</button>
          <button disabled={!tabs.some((item) => item.closable)} onClick={() => { onCloseAll(); setMenu(null); }}>关闭全部</button>
          <div className="tab-context-separator" />
          <button onClick={() => { onPin(menuTab.id); setMenu(null); }}>{menuTab.pinned ? "取消固定" : "固定Tab"}</button>
          {canRestore && <button onClick={() => { onRestore(); setMenu(null); }}>恢复关闭的Tab</button>}
        </div>
      )}
      <div className="tab-strip-actions">
        <button className="icon-button" onClick={onRestore} disabled={!canRestore} title="恢复关闭的Tab">
          <AppIcon name="history" size={15} />
        </button>
      </div>
    </div>
  );
}

/** 指定Tab的某一侧是否还有可关闭的Tab（只有工作区首页这类不可关闭Tab不算） */
function closableNeighbour(id: string, side: "left" | "right", tabs: WorkbenchTab[]): boolean {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return false;
  return tabs.some((tab, position) => (side === "left" ? position < index : position > index) && tab.closable);
}
