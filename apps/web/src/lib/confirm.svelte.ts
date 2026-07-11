export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

export interface ConfirmRequest extends Required<Omit<ConfirmOptions, "title">> {
  id: number;
  title: string;
  resolve: (ok: boolean) => void;
}

let current = $state<ConfirmRequest | null>(null);
let nextId = 0;

export function getCurrentConfirm(): ConfirmRequest | null {
  return current;
}

export function confirm(message: string): Promise<boolean>;
export function confirm(options: ConfirmOptions): Promise<boolean>;
export function confirm(messageOrOptions: string | ConfirmOptions): Promise<boolean> {
  const options: ConfirmOptions =
    typeof messageOrOptions === "string" ? { message: messageOrOptions } : messageOrOptions;
  const request: ConfirmRequest = {
    id: ++nextId,
    title: options.title ?? "Please confirm",
    message: options.message,
    confirmLabel: options.confirmLabel ?? "Confirm",
    cancelLabel: options.cancelLabel ?? "Cancel",
    tone: options.tone ?? "danger",
    resolve: () => {},
  };
  return new Promise<boolean>((resolve) => {
    if (current) {
      const prev = current;
      current = null;
      prev.resolve(false);
    }
    request.resolve = resolve;
    current = request;
  });
}

export function resolveConfirm(): void {
  const req = current;
  if (!req) return;
  current = null;
  req.resolve(true);
}

export function dismissConfirm(): void {
  const req = current;
  if (!req) return;
  current = null;
  req.resolve(false);
}
