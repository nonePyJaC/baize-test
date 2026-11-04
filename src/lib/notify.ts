// 工作台级通知服务：任何模块都可以通过 notify() 推送右下角 Toast，
// 由 ToastHost 组件统一渲染和自动消失，不需要逐层传递 setMessage。

export type NoticeKind = "info" | "success" | "error";

export interface Notice {
  id: number;
  kind: NoticeKind;
  message: string;
  duration: number;
}

const DEFAULT_DURATION: Record<NoticeKind, number> = {
  info: 3500,
  success: 3500,
  error: 8000,
};

const listeners = new Set<(notice: Notice) => void>();
let sequence = 0;

export function notify(kind: NoticeKind, message: string, duration?: number): void {
  const notice: Notice = {
    id: ++sequence,
    kind,
    message,
    duration: duration ?? DEFAULT_DURATION[kind],
  };
  listeners.forEach((listener) => listener(notice));
}

export function subscribeNotices(listener: (notice: Notice) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
