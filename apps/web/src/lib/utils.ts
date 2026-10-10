import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and lets the later Tailwind utility win over an earlier
 * one of the same group - the helper every shadcn/ui component is written
 * against (`components.json`, alias `@/lib/utils`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
