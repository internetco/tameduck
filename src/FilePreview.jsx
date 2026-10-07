import React, { useEffect, useId, useState } from "react";
import { previewKind } from "../shared/file-preview.mjs";
import { SpreadsheetRowsPreview } from "./CsvSheet.jsx";

export { previewKind };
export const isPreviewable = (item) => Boolean(previewKind(item));
const incomplete =
  "Only part of this file is shown. Download it to see the complete content.";

export function FilePreview({ item, fill = false }) {
  const [state, setState] = useState({ loading: true });
  const [selected, setSelected] = useState(0);
  const sheetId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    setSelected(0);
    (async () => {
      try {
        const response = await fetch(
          "/api/uploads/" + encodeURIComponent(item.id) + "/preview",
          { signal: controller.signal },
        );
        const data = await response.json().catch(() => null);
        if (!response.ok || !data)
          throw new Error(
            data?.error ||
              "The preview could not be loaded. Download the file to open it.",
          );
        if (!["spreadsheet", "document", "text"].includes(data.kind))
          throw new Error(
            "This file cannot be previewed. Download it to open it.",
          );
        if (!controller.signal.aborted) setState({ data });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            error:
              error instanceof TypeError
                ? "The preview could not be loaded. Check your connection and try again."
                : error.message ||
                  "The preview could not be loaded. Close it and try again.",
          });
      }
    })();
    return () => controller.abort();
  }, [item.id]);
  if (state.loading)
    return (
      <p className="file-preview-status" role="status">
        Loading preview…
      </p>
    );
  if (state.error)
    return (
      <p className="file-preview-status" role="status">
        {state.error}
      </p>
    );
  const data = state.data;
  if (data.kind === "spreadsheet") {
    const sheets = data.sheets || [];
    const sheet = sheets[selected];
    if (!sheet)
      return (
        <p className="file-preview-status" role="status">
          This workbook has no worksheets to show.
        </p>
      );
    return (
      <div className={"file-preview-workbook" + (fill ? " fill" : " compact")}>
        <div className="file-preview-sheets">
          <label htmlFor={sheetId}>Worksheet</label>
          <select
            id={sheetId}
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {sheets.map((entry, index) => (
              <option key={index} value={index}>
                {entry.name}
              </option>
            ))}
          </select>
          <span>
            {selected + 1} of {sheets.length}
          </span>
        </div>
        {data.notice && (
          <p className="file-preview-note" role="status">
            {data.notice}
          </p>
        )}
        <SpreadsheetRowsPreview
          key={item.id + ":" + selected}
          rows={sheet.rows}
          truncated={false}
          label={item.name + " — " + sheet.name}
        />
        {(data.truncated || sheet.truncated) && (
          <p className="file-preview-note" role="status">
            {incomplete}
          </p>
        )}
      </div>
    );
  }
  if (data.kind === "text")
    return (
      <div className={"file-preview-text" + (fill ? " fill" : " compact")}>
        {data.text ? (
          <pre>{data.text}</pre>
        ) : (
          <p role="status">This file is empty.</p>
        )}
        {data.truncated && (
          <p className="file-preview-note" role="status">
            {incomplete}
          </p>
        )}
      </div>
    );
  const sections = data.sections || [];
  const hasText = sections.some((section) => section.text?.trim());
  return (
    <div className={"file-preview-document" + (fill ? " fill" : " compact")}>
      <p className="file-preview-description">
        Text preview · Download for the original layout and images.
      </p>
      {!hasText && <p role="status">This file has no text to preview.</p>}
      {sections.map((section, index) => (
        <section key={index}>
          {section.title && <h3>{section.title}</h3>}
          {section.text && <p>{section.text}</p>}
        </section>
      ))}
      {data.truncated && (
        <p className="file-preview-note" role="status">
          {incomplete}
        </p>
      )}
    </div>
  );
}
