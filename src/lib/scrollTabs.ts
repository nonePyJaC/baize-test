/** 横向Tab条：把激活项滚动到可视区中间，避免面板过窄时激活Tab被裁掉看不见 */
export function centerActiveTab(container: HTMLElement | null, selector = ".active"): void {
  if (!container) return;
  const active = container.querySelector<HTMLElement>(selector);
  if (!active) return;
  const containerRect = container.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  if (!containerRect.width || !activeRect.width) return;
  const delta = activeRect.left + activeRect.width / 2 - (containerRect.left + containerRect.width / 2);
  if (Math.abs(delta) < 1) return;
  container.scrollTo({ left: Math.max(0, container.scrollLeft + delta), behavior: "smooth" });
}
