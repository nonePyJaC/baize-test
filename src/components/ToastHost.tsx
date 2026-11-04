import React, { useEffect, useRef, useState } from "react";
import AppIcon, { type IconName } from "./AppIcon";
import { subscribeNotices, type Notice, type NoticeKind } from "../lib/notify";

const KIND_ICON: Record<NoticeKind, IconName> = {
  info: "info",
  success: "check",
  error: "alert",
};

const MAX_NOTICES = 5;

export default function ToastHost() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = (id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setNotices((current) => current.filter((notice) => notice.id !== id));
  };

  useEffect(() => {
    const unsubscribe = subscribeNotices((notice) => {
      setNotices((current) => [...current.slice(-(MAX_NOTICES - 1)), notice]);
      if (notice.duration > 0) {
        const timer = setTimeout(() => dismiss(notice.id), notice.duration);
        timers.current.set(notice.id, timer);
      }
    });
    const pending = timers.current;
    return () => {
      unsubscribe();
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  if (!notices.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`toast toast-${notice.kind}`}>
          <AppIcon name={KIND_ICON[notice.kind]} size={15} />
          <span>{notice.message}</span>
          <button type="button" onClick={() => dismiss(notice.id)} aria-label="关闭通知">
            <AppIcon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
