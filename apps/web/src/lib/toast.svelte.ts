export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

let toasts = $state<Toast[]>([]);
let nextId = 0;

export function getToasts(): Toast[] {
  return toasts;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
}

export function toast(message: string, type: ToastType = "info", duration = 5000): number {
  const id = ++nextId;
  toasts = [...toasts, { id, type, message }];
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function toastError(message: string, duration = 6000): number {
  return toast(message, "error", duration);
}

export function toastSuccess(message: string, duration = 4000): number {
  return toast(message, "success", duration);
}

export function toastInfo(message: string, duration = 5000): number {
  return toast(message, "info", duration);
}
