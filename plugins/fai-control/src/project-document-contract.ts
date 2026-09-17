export const projectDocumentCategories = ["passport", "specification", "architecture", "other"] as const;
export type ProjectDocumentCategory = typeof projectDocumentCategories[number];
export type ProjectDocumentExtractor = "browser-text" | "browser-docx" | "browser-pdf";
