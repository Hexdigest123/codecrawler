declare global {
  namespace App {
    interface Locals {
      session: {
        user?: { id: string; email: string; name?: string | null };
      } | null;
    }
    interface PageData {
      session?: {
        user?: { id: string; email: string; name?: string | null };
      } | null;
    }
    interface Error {
      message: string;
    }
  }
}

export {};
