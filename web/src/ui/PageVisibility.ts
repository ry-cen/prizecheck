import { createContext } from "react";

/** Kept pages may read their first page, but enrich only cards the collector can see. */
export const PageVisibility = createContext(true);
