import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware class name combiner — used by all shadcn components. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
