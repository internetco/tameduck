import React from "react";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  StickyNote,
} from "lucide-react";
export { formatBytes } from "./Storage.jsx";
export { filterGroup } from "./files-list.mjs";
import "./files.css";

export const groupLabels = {
  document: "Documents",
  pdf: "PDFs",
  spreadsheet: "Spreadsheets",
  image: "Images",
  presentation: "Presentations",
  text: "Text & code",
  media: "Audio & video",
  archive: "Archives",
  other: "Other files",
};
const singular = {
  document: "Document",
  doc: "Word document",
  image: "Image",
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  text: "Text",
  media: "Audio or video",
  archive: "Archive",
  other: "File",
};
export function typeLabel(item) {
  if (item.kind === "screenshot") return "Screenshot";
  if (item.kind === "notes") return "Duck notes";
  if (item.kind === "document") return "Document";
  const ext = /\.([a-z0-9]{1,10})$/i.exec(item.name || "")?.[1];
  return ext && !["image", "pdf"].includes(item.group)
    ? ext.toUpperCase()
    : singular[item.group] || "File";
}
const icons = {
  document: FileText,
  doc: FileText,
  image: FileImage,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileCode,
  media: FileAudio,
  archive: FileArchive,
};
export function FileIcon({ item, size = 20 }) {
  const Icon = item.kind === "notes" ? StickyNote : icons[item.group] || File;
  return (
    <span className={"file-icon file-icon-" + (item.group || "other")}>
      <Icon size={size} />
    </span>
  );
}
export const uploadUrl = (id, download = false) =>
  "/api/uploads/" + id + (download ? "?download=1" : "");
